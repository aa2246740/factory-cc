import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalWorkspacePath } from "../workspace.js";
import { asBlocks } from "../protocol/content.js";
import { assistantMessage } from "../protocol/messages.js";
import { ToolMailbox } from "../relay/mailbox.js";
import type { BridgeConfig } from "../config.js";
import type { ContentBlock, Json, Usage } from "../types.js";
import { BridgeError } from "../types.js";
import type { Logger } from "../logging.js";
import { claudeToolTraceDetail, isDroidMcpName, selectDroidMcpTools } from "./droid-tools.js";
import { DroidMcpCatalog, StableDroidToolNames } from "./droid-mcp-catalog.js";
import { hostAllowsAnyTools, nativeToolAllowed } from "./native-tool-policy.js";
import { buildDynamicUserContent, buildHostContext, buildInitialUserContent, buildPresetSystemPrompt, describePromptLayout } from "./system-prompt.js";
import { UsageLedger } from "./usage.js";
import type { BridgeRuntime, RuntimeApprovalRequest, RuntimeControl, RuntimeEvent, RuntimeHostCall, RuntimeHostCompletion, RuntimeHostEnd, RuntimePermissionDecision, RuntimeRequest, RuntimeTurn, StreamSink } from "./types.js";
import { publicSelection, sdkEnv, selectionFromConfig, type UpstreamSelection } from "../upstream/providers.js";

/** Kept narrow so tests can inject a deterministic SDK without starting a CLI. */
export interface SdkHandle {
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>> & {
    interrupt?: () => Promise<unknown>;
    close?: () => void;
    mcpServerStatus?: () => Promise<Array<{ name: string; status: string; tools?: Array<{ name: string; description?: string }> }>>;
  };
  tool(name: string, description: string, schema: unknown, handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>, extras?: Record<string, unknown>): unknown;
  createSdkMcpServer(options: Record<string, unknown>): unknown;
}

export interface SdkUserInput {
  type: "user";
  message: { role: "user"; content: ContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
  uuid: string;
}

/** A streaming SDK prompt stays open between user turns, including MCP waits. */
class InputQueue implements AsyncIterable<SdkUserInput> {
  private readonly values: SdkUserInput[] = [];
  private nextValue?: (value: IteratorResult<SdkUserInput>) => void;
  private ended = false;

  push(value: SdkUserInput): void {
    if (this.ended) throw new BridgeError(409, "session_closed", "SDK input queue is closed");
    const next = this.nextValue;
    this.nextValue = undefined;
    if (next) next({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.ended = true;
    this.values.length = 0;
    this.nextValue?.({ value: undefined, done: true });
    this.nextValue = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkUserInput> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.nextValue = resolve; });
      },
    };
  }
}

interface PendingTurn {
  resolve(turn: RuntimeTurn): void;
  reject(error: Error): void;
}
interface DroidCall { id: string; name: string; input: unknown; mcpName?: string }
interface HandlerArrival {
  name: string;
  mcpName?: string;
  input: Record<string, unknown>;
  callId?: string;
  resolve(call: DroidCall): void;
  reject(error: BridgeError): void;
}
interface HostResultConsumption {
  promise: Promise<void>;
  resolve(): void;
}
interface NativePermissionContext {
  signal?: AbortSignal;
  toolUseID?: string;
  requestId?: string;
  agentID?: string;
  title?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
}
interface LiveSdk {
  mailbox: ToolMailbox;
  inputs: InputQueue;
  events: RuntimeEvent[];
  busy: boolean;
  active: boolean;
  terminal?: BridgeError;
  sdkSessionId?: string;
  names?: StableDroidToolNames;
  catalog?: DroidMcpCatalog;
  policyKey?: string;
  abort?: AbortController;
  query?: ReturnType<SdkHandle["query"]>;
  loop?: Promise<void>;
  waiter?: PendingTurn;
  outbox: RuntimeTurn[];
  sink?: StreamSink;
  current?: RuntimeRequest;
  usage: UsageLedger;
  streamed: string;
  blocks: ContentBlock[];
  pending: Map<string, DroidCall>;
  candidates: Map<string, DroidCall>;
  handlerArrivals: Set<HandlerArrival>;
  retiredCandidates: Set<string>;
  claimedHandlers: Set<string>;
  resultFingerprints: Map<string, string>;
  hostResultConsumptions: Map<string, HostResultConsumption>;
  hostCompletionFingerprints: Map<string, string>;
  approvals: Set<AbortController>;
  hostEnding?: string;
  resumableAfterHostEnd?: boolean;
  lastRequestKey?: string;
  lastReply?: RuntimeTurn;
  compactMetadata?: Record<string, unknown>;
  lastHostContext?: string;
  sentUserTurns: number;
  starting: boolean;
  queryEpoch: number;
  lastTouched: number;
  backgroundTasks: Set<string>;
}

type DroidResult = { tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean };

/** Official Claude Code owns the agent loop, tools, context, and compaction. */
export class SdkRuntime implements BridgeRuntime {
  readonly kind = "sdk" as const;
  private sdk?: SdkHandle;
  private selection?: UpstreamSelection;
  private selectionPromise?: Promise<UpstreamSelection | undefined>;
  private readonly lives = new Map<string, LiveSdk>();
  private readonly usageFile: string;
  private control?: RuntimeControl;

  constructor(private readonly config: BridgeConfig, private readonly logger: Logger, sdk?: SdkHandle) {
    this.sdk = sdk;
    this.usageFile = join(config.logDir, "usage.jsonl");
  }

  describe(): Record<string, unknown> {
    return {
      kind: "sdk", authMode: this.config.authMode, permissionMode: this.config.permissionMode,
      prompt: describePromptLayout(), tools: "preset:claude_code + droid-exclusive MCP",
      input: "persistent SDK streaming input", includePartialMessages: true,
      approvalChannel: this.control ? "external controller" : "unavailable: fail closed",
      activeNativeSessions: [...this.lives.values()].filter((live) => !live.terminal && (live.query || live.starting)).length,
      activeNativeTurns: [...this.lives.values()].filter((live) => !live.terminal && live.active).length,
      pendingHostCalls: [...this.lives.values()].reduce((total, live) => total + (live.terminal ? 0 : live.pending.size), 0),
      pendingApprovals: [...this.lives.values()].reduce((total, live) => total + live.approvals.size, 0),
      fatalErrors: [...this.lives.entries()].flatMap(([sessionId, live]) => live.terminal && !["cancelled", "host_session_ended"].includes(live.terminal.code)
        ? [{ sessionId, code: live.terminal.code, message: live.terminal.message }] : []),
      overridesAnthropicEnv: this.config.authMode !== "subscription",
      upstream: this.selection ? publicSelection(this.selection) : { selected: false, authMode: this.config.authMode },
    };
  }

  setControl(control: RuntimeControl | undefined): void {
    // A replaced/disconnected controller cannot retain permission authority.
    if (control !== this.control) for (const live of this.lives.values()) {
      for (const approval of live.approvals) approval.abort();
    }
    this.control = control;
  }

  pendingHostCalls(sessionId: string): RuntimeHostCall[] {
    const live = this.lives.get(sessionId);
    if (!live || live.terminal) return [];
    return [...live.pending.values()].map((call) => ({ toolUseId: call.id, toolName: call.name, input: structuredClone(call.input) }));
  }

  async completeHostTool(sessionId: string, completion: RuntimeHostCompletion): Promise<"accepted" | "duplicate"> {
    const live = this.lives.get(sessionId);
    if (!live) throw new BridgeError(409, "interrupted_tool_roundtrip", "No live SDK owns this host completion");
    const call = live.mailbox.getCall(completion.toolUseId);
    if (!call) throw new BridgeError(409, "unknown_tool_use_id", completion.toolUseId);
    if (call.originalName !== completion.toolName || canonicalJson(call.input) !== canonicalJson(completion.input)) {
      throw new BridgeError(409, "conflicting_host_completion", "Host completion does not match the accepted native tool invocation");
    }
    const fingerprint = canonicalJson({ ...completion, isError: Boolean(completion.isError), terminal: Boolean(completion.terminal) });
    const previous = live.hostCompletionFingerprints.get(completion.toolUseId);
    if (previous) {
      if (previous !== fingerprint) throw new BridgeError(409, "conflicting_host_completion", completion.toolUseId);
      return "duplicate";
    }
    if (live.terminal) throw live.terminal;
    if (live.hostEnding) throw new BridgeError(409, "host_session_ending", live.hostEnding);
    if (completion.terminal && completion.isError) throw new BridgeError(400, "failed_terminal_tool", "A failed host tool does not confirm successful session termination");
    if (completion.terminal && [...live.pending.keys()].some((id) => id !== completion.toolUseId)) {
      throw new BridgeError(409, "host_tools_pending", "A terminal completion cannot discard another pending host tool");
    }
    const result: DroidResult = { tool_use_id: completion.toolUseId, content: completion.content, is_error: Boolean(completion.isError) };
    mcpContent(result.content);
    this.validateResults(live, [result]);
    live.hostCompletionFingerprints.set(completion.toolUseId, fingerprint);
    if (completion.terminal) live.hostEnding = `Host completed ${completion.toolName}`;
    const [outcome] = this.submitResults(live, [result]);
    live.events.push({ at: now(), type: "host_tool_completed", data: { toolUseId: completion.toolUseId, toolName: completion.toolName, terminal: Boolean(completion.terminal), isError: Boolean(completion.isError) } });
    if (completion.terminal) {
      // Let the real MCP handler consume the host's actual result before closing
      // its worker. No final model request or fabricated model success is needed.
      await live.hostResultConsumptions.get(completion.toolUseId)?.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await this.endHostSession(sessionId, `Host completed ${completion.toolName}`);
    }
    return outcome!;
  }

  async endHostSession(sessionId: string, reason: string): Promise<RuntimeHostEnd> {
    const live = this.lives.get(sessionId);
    if (!live) return { resumable: false };
    if (live.terminal) return { resumable: live.terminal.code === "host_session_ended" && live.resumableAfterHostEnd === true, sdkSessionId: live.sdkSessionId };
    live.resumableAfterHostEnd = this.config.persistSessions && Boolean(live.sdkSessionId) && !live.hostEnding
      && !live.pending.size && !live.handlerArrivals.size && !live.candidates.size && !live.backgroundTasks.size;
    live.events.push({ at: now(), type: "host_session_ended", data: { reason, unresolvedToolIds: [...live.pending.keys()] } });
    this.stop(live, new BridgeError(409, "host_session_ended", reason));
    return { resumable: live.resumableAfterHostEnd, sdkSessionId: live.sdkSessionId };
  }

  async ensureSelection(): Promise<UpstreamSelection | undefined> {
    if (this.config.authMode === "subscription") return undefined;
    if (this.selection) return this.selection;
    if (this.selectionPromise) return this.selectionPromise;
    this.selectionPromise = (async () => {
      const configured = selectionFromConfig({ baseUrl: this.config.upstreamBaseUrl, model: this.config.upstreamModel, tokenEnv: this.config.upstreamTokenEnv });
      if (configured) return (this.selection = configured);
      throw new BridgeError(401, "blocked_auth", "BYOK requires explicit BRIDGE_UPSTREAM_BASE_URL, BRIDGE_UPSTREAM_MODEL and BRIDGE_UPSTREAM_TOKEN_ENV; automatic credential discovery is disabled.");
    })();
    try { return await this.selectionPromise; }
    finally { this.selectionPromise = undefined; }
  }

  async handle(input: RuntimeRequest, sink?: StreamSink): Promise<RuntimeTurn> {
    const id = input.session.bridgeSessionId;
    let live = this.lives.get(id);
    if (live?.terminal?.code === "host_session_ended" && live.resumableAfterHostEnd) {
      if (input.session.pendingToolIds.length) throw new BridgeError(409, "interrupted_tool_roundtrip", "The ended host session still records unresolved tools; do not replay them");
      const previous = live;
      live = this.createLive(previous.sdkSessionId);
      // Preserve only resumable native configuration/context. A new generation
      // never inherits callbacks, approvals, delivery receipts or old replies.
      live.names = previous.names;
      live.catalog = previous.catalog;
      live.policyKey = previous.policyKey;
      live.lastHostContext = previous.lastHostContext;
      live.sentUserTurns = previous.sentUserTurns;
      this.lives.set(id, live);
    }
    if (!live && input.session.pendingToolIds.length) {
      throw new BridgeError(409, "interrupted_tool_roundtrip", "The bridge restarted while a Droid tool was pending. Start a new session; the tool will not be replayed.");
    }
    if (!live) {
      live = this.createLive(input.session.sdkSessionId);
      this.lives.set(id, live);
    }
    if (live.terminal) throw live.terminal;
    if (live.hostEnding) throw new BridgeError(409, "host_session_ending", live.hostEnding);
    if (live.busy) throw new BridgeError(409, "session_busy", "This session already has an active HTTP request");
    // Acquire before the first await: concurrent initial turns cannot start two queries.
    live.busy = true;
    live.lastTouched = Date.now();
    live.sink = sink;
    const requestKey = JSON.stringify({ request: input.request, role: input.role, cwd: resolveCwd(input, this.config), missionDir: input.headers["x-bridge-mission-dir"] });
    let waiting: Promise<RuntimeTurn> | undefined;
    try {
      if (requestKey === live.lastRequestKey && live.lastReply) return live.lastReply;
      const results = latestToolResults(input, live.active || live.pending.size > 0);
      if (!results.length && live.active) {
        throw new BridgeError(409, "session_busy", "Complete the current SDK turn and its Droid tools before sending a new user turn");
      }
      if (results.length) {
        this.validateResults(live, results);
        const supplied = new Set(results.map((result) => result.tool_use_id));
        const missing = live.lastReply?.response.content
          .filter((block) => block.type === "tool_use")
          .map((block) => (block as { id: string }).id)
          .filter((callId) => live.pending.has(callId) && !supplied.has(callId)) ?? [];
        if (missing.length) throw new BridgeError(409, "incomplete_tool_results", "Return all tool results from the preceding response together", { missing_tool_use_ids: missing });
        if (!live.active && !live.outbox.length) {
          throw new BridgeError(409, "stale_tool_result", "These tool results have already completed their SDK turn");
        }
      }
      const policy = queryPolicy(input, this.config);
      if (live.policyKey && live.policyKey !== policy) {
        throw new BridgeError(409, "session_configuration_changed", "Working directory, model, permission policy or role changed; start a separate session");
      }
      const context = buildHostContext(input, resolveCwd(input, this.config));
      const continuation = results.length ? this.continuationContent(input, live, context) : [];
      if (continuation.length && results.every((result) => live.resultFingerprints.has(result.tool_use_id))) {
        throw new BridgeError(409, "stale_tool_result_context", "New host context cannot be attached to an already-delivered tool result");
      }
      // Validate before changing catalog, fingerprints, or mailbox state.
      // Unsupported documents must not wake a pending handler and fail later.
      for (const result of results) if (!live.resultFingerprints.has(result.tool_use_id)) mcpContent(result.content);
      if (continuation.length) mcpContent(continuation);
      live.current = input;
      waiting = this.waitForTurn(live);
      // Attach rejection handling before startup awaits, including startup timeouts.
      void waiting.catch(() => undefined);
      // ToolSearch may add tools on the very request that returns its result.
      // Publish the catalog change before unblocking the original MCP handler.
      if (live.query && input.request.tools !== undefined) await this.updateCatalog(live, input);
      if (live.terminal) throw live.terminal;
      if (results.length) {
        this.submitResults(live, results, continuation);
        live.lastHostContext = context;
        this.flushOutbox(live);
      } else {
        // The CLI can emit init before it reads its first input. That new session ID
        // is not evidence that the supplied Droid history was already imported.
        const coldImport = !live.sentUserTurns && !live.sdkSessionId;
        live.active = true;
        if (!live.query) await this.startQuery(input, live);
        if (live.terminal) throw live.terminal;
        const cwd = resolveCwd(input, this.config);
        const content = coldImport
          ? buildInitialUserContent(input, cwd)
          : buildDynamicUserContent(input, cwd, { includeContext: live.lastHostContext !== context });
        live.lastHostContext = context;
        live.sentUserTurns++;
        live.inputs.push({
          type: "user", message: { role: "user", content },
          parent_tool_use_id: null, session_id: live.sdkSessionId ?? "", uuid: randomUUID(),
        });
      }
      const reply = await waiting;
      live.lastRequestKey = requestKey;
      live.lastReply = reply;
      return reply;
    } catch (error) {
      if (waiting) this.stop(live, asBridgeError(error));
      throw error;
    } finally {
      live.busy = false;
      live.sink = undefined;
      live.lastTouched = Date.now();
    }
  }

  async deliverResults(sessionId: string, results: DroidResult[]): Promise<Array<"accepted" | "duplicate">> {
    const live = this.lives.get(sessionId);
    if (!live) throw new BridgeError(409, "interrupted_tool_roundtrip", "No live SDK owns these tool results");
    if (live.terminal) throw live.terminal;
    this.validateResults(live, results);
    return this.submitResults(live, results);
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    const live = this.lives.get(sessionId);
    if (live) this.stop(live, new BridgeError(499, "cancelled", reason));
  }

  async close(): Promise<void> {
    for (const live of this.lives.values()) this.stop(live, new BridgeError(499, "cancelled", "bridge shutdown"));
    // Give the SDK's process/stream cleanup time to finish before index exits.
    // A broken transport must not keep bridge shutdown blocked indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.lives.values()].map((live) => live.loop)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); timer.unref(); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private createLive(sdkSessionId?: string): LiveSdk {
    return {
      mailbox: new ToolMailbox(), inputs: new InputQueue(), events: [], busy: false, active: false,
      sdkSessionId, outbox: [], usage: new UsageLedger(), streamed: "", blocks: [], pending: new Map(),
      candidates: new Map(), handlerArrivals: new Set(), retiredCandidates: new Set(),
      claimedHandlers: new Set(), resultFingerprints: new Map(), sentUserTurns: 0,
      hostResultConsumptions: new Map(), hostCompletionFingerprints: new Map(), approvals: new Set(),
      starting: false, queryEpoch: 0, lastTouched: Date.now(), backgroundTasks: new Set(),
    };
  }

  private validateResults(live: LiveSdk, results: DroidResult[]): void {
    const batch = new Map<string, string>();
    for (const result of results) {
      if (!live.mailbox.hasCall(result.tool_use_id)) throw new BridgeError(409, "unknown_tool_use_id", result.tool_use_id);
      const fingerprint = resultFingerprint(result);
      const previous = live.resultFingerprints.get(result.tool_use_id);
      const earlierInBatch = batch.get(result.tool_use_id);
      if ((previous && previous !== fingerprint) || (earlierInBatch && earlierInBatch !== fingerprint)) throw new BridgeError(409, "conflicting_tool_result", result.tool_use_id);
      batch.set(result.tool_use_id, fingerprint);
    }
  }

  private continuationContent(input: RuntimeRequest, live: LiveSdk, context: string): ContentBlock[] {
    const content = trailingUserMessages(input).flatMap((message) => buildDynamicUserContent({
      ...input, request: { ...input.request, messages: [message] },
    }, resolveCwd(input, this.config), { includeContext: false }));
    if (context !== live.lastHostContext) content.push({ type: "text", text: context });
    return content.length ? [{ type: "text", text: "Host continuation context supplied by Droid with these tool results (not an additional user turn):" }, ...content] : [];
  }

  private submitResults(live: LiveSdk, results: DroidResult[], continuation: ContentBlock[] = []): Array<"accepted" | "duplicate"> {
    let attached = false;
    return results.map((result) => {
      const fresh = !live.resultFingerprints.has(result.tool_use_id);
      live.resultFingerprints.set(result.tool_use_id, resultFingerprint(result));
      live.pending.delete(result.tool_use_id);
      const delivered = fresh && !attached && continuation.length
        ? { ...result, content: [...asBlocks(result.content), ...continuation] }
        : result;
      if (delivered !== result) attached = true;
      return live.mailbox.submitResult(delivered);
    });
  }

  private async updateCatalog(live: LiveSdk, input: RuntimeRequest): Promise<void> {
    if (!live.catalog) throw new BridgeError(503, "dynamic_tools_unavailable", "The live SDK session has no mutable Droid MCP catalog");
    if (await live.catalog.update(selectDroidMcpTools(input.request.tools))) {
      await this.waitForCatalogVisibility(live);
      live.events.push({ at: now(), type: "droid_catalog_updated", data: {
        tools: live.catalog.definitions().map((tool) => tool.name), visibility: "cli_tool_names_confirmed", schemaVisibility: "revision_name_confirmed",
      } });
    }
  }

  private async waitForCatalogVisibility(live: LiveSdk): Promise<void> {
    const query = live.query;
    if (!query?.mcpServerStatus) throw new BridgeError(503, "dynamic_tools_unavailable", "SDK cannot confirm that Claude Code refreshed its MCP catalog");
    const expected = live.catalog!.definitions().map((tool) => live.names!.toMcp(tool.name)).sort();
    const deadline = Date.now() + Math.min(5_000, Math.max(1, Math.floor(this.config.requestTimeoutMs / 2)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      while (!live.terminal && Date.now() < deadline) {
        const statuses = await query.mcpServerStatus!();
        const server = statuses.find((status) => status.name === "droid");
        const actual = server?.tools?.map((tool) => tool.name.replace(/^mcp__droid__/, "")).sort();
        if (server?.status === "connected" && actual && JSON.stringify(actual) === JSON.stringify(expected)) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
      throw live.terminal ?? new BridgeError(503, "tool_catalog_not_visible", "Claude Code did not refresh its advertised Droid tools before continuation");
    };
    try {
      await Promise.race([
        poll(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BridgeError(503, "tool_catalog_not_visible", "Timed out confirming the Claude Code tool catalog")), Math.max(1, deadline - Date.now())); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async startQuery(input: RuntimeRequest, live: LiveSdk): Promise<void> {
    this.ensureQueryCapacity(live);
    live.starting = true;
    try { await this.startQueryImpl(input, live); }
    finally { live.starting = false; }
  }

  private ensureQueryCapacity(current: LiveSdk): void {
    const running = [...this.lives.values()].filter((live) => live !== current && !live.terminal && (live.query || live.starting));
    if (running.length < this.config.maxSessions) return;
    const idle = running.filter((live) => this.config.persistSessions && live.query && live.sdkSessionId && !live.active && !live.busy && !live.outbox.length && !live.backgroundTasks.size && !live.approvals.size)
      .sort((left, right) => left.lastTouched - right.lastTouched)[0];
    if (!idle) throw new BridgeError(429, "sdk_session_limit", "No safely resumable idle Claude Code process is available; close a session or raise BRIDGE_MAX_SESSIONS");
    // Preserve the official session identity and resume it if its user returns.
    idle.queryEpoch++;
    idle.inputs.close();
    idle.abort?.abort();
    try { void idle.query?.interrupt?.().catch(() => undefined); } catch { /* best effort */ }
    try { idle.query?.close?.(); } catch { /* already closed */ }
    idle.inputs = new InputQueue();
    idle.query = undefined;
    idle.loop = undefined;
    idle.abort = undefined;
    idle.events.push({ at: now(), type: "sdk_idle_evicted", data: { sdkSessionId: idle.sdkSessionId } });
  }

  private async startQueryImpl(input: RuntimeRequest, live: LiveSdk): Promise<void> {
    const sdk = await this.loadSdk();
    const selection = await this.ensureSelection();
    if (live.terminal) throw live.terminal;
    const droidTools = input.request.tools !== undefined ? selectDroidMcpTools(input.request.tools) : live.catalog?.definitions() ?? [];
    const names = live.names ?? new StableDroidToolNames();
    live.names = names;
    live.policyKey = queryPolicy(input, this.config);
    const server = sdk.createSdkMcpServer({ name: "droid", version: "0.1.0", tools: [], alwaysLoad: true });
    const catalog = new DroidMcpCatalog(server, async (original, args, extra, mcpName) => {
        if (live.terminal) throw live.terminal;
        if (live.hostEnding) throw new BridgeError(409, "host_session_ended", live.hostEnding);
        if (!live.catalog?.has(original)) throw new BridgeError(409, "tool_not_advertised", `Droid no longer advertises ${original}`);
        try {
          // Only this handler proves the native CLI and MCP server accepted the
          // invocation. Assistant tool_use output alone is merely a proposal.
          const call = await this.claimCall(live, original, args, extractCallId(extra), mcpName);
          if (live.terminal) throw live.terminal;
          if (live.retiredCandidates.has(call.id)) throw new BridgeError(409, "sdk_tool_rejected", "The native SDK already completed this tool invocation");
          if (!live.catalog?.has(original)) throw new BridgeError(409, "tool_not_advertised", `Droid no longer advertises ${original}`);
          live.mailbox.registerCall({ callId: call.id, originalName: original, mcpName: mcpName ?? names.toMcp(original), input: call.input });
          live.pending.set(call.id, call);
          let consumed!: () => void;
          live.hostResultConsumptions.set(call.id, { promise: new Promise<void>((resolve) => { consumed = resolve; }), resolve: () => consumed() });
          const waiting = live.mailbox.wait(call.id, this.config.toolWaitMs);
          this.publish(live, this.makeTurn(live, [{ type: "tool_use", id: call.id, name: original, input: call.input as Json }], "tool_use"));
          const result = await waiting;
          const response = { content: mcpContent(result.content), isError: Boolean(result.isError) };
          live.hostResultConsumptions.get(call.id)?.resolve();
          live.hostResultConsumptions.delete(call.id);
          return response;
        } catch (error) {
          this.stop(live, asBridgeError(error));
          throw error;
        }
      }, names);
    live.catalog = catalog;
    await catalog.update(droidTools);
    if (live.terminal) throw live.terminal;
    const env = sdkEnv(selection, `${this.config.host}:${this.config.port}`, this.config.authMode);
    // The native worker receives its provider credential, never the host
    // controller's authority or Factory lifecycle generation.
    for (const name of ["BRIDGE_ADMIN_TOKEN", "BRIDGE_FACTORY_BINDING", "BRIDGE_FACTORY_LAUNCH_ID", "BRIDGE_LAUNCH_ID"]) delete env[name];
    if (this.config.authMode !== "subscription") {
      const configDir = join(this.config.dataDir, "claude-config");
      mkdirSync(configDir, { recursive: true });
      env.CLAUDE_CONFIG_DIR = configDir;
    }
    const abort = new AbortController();
    live.abort = abort;
    const options: Record<string, unknown> = {
      tools: { type: "preset", preset: "claude_code" }, includePartialMessages: true,
      cwd: resolveCwd(input, this.config), persistSession: this.config.persistSessions,
      maxTurns: this.config.maxTurns, mcpServers: { droid: server },
      // Permit the dynamic host namespace only. Droid executes these operations
      // with its own permissions; native Claude Code builtins are not covered.
      allowedTools: ["mcp__droid__*"],
      env, permissionMode: this.config.permissionMode === "ask" ? "default" : "bypassPermissions",
      allowDangerouslySkipPermissions: this.config.permissionMode !== "ask", abortController: abort,
      systemPrompt: buildPresetSystemPrompt(),
      canUseTool: async (name: string, toolInput: Record<string, unknown>, context?: NativePermissionContext) => this.canUseTool(live, name, toolInput, context),
    };
    // The host can change its tool capability between turns without rebuilding
    // native history. Check at invocation, including under native bypass mode.
    options.hooks = { PreToolUse: [{ hooks: [async (hook: { tool_name?: string; tool_use_id?: string }) => {
        if (live.terminal) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The host session has ended." } };
        const denial = toolAccessDenial(live, hook.tool_name, this.control?.factoryPermissionMode?.(input.session.bridgeSessionId));
        if (!denial) return {};
        const data = { sessionId: input.session.bridgeSessionId, sdkSessionId: live.sdkSessionId, toolName: hook.tool_name, toolUseId: hook.tool_use_id, reason: denial };
        live.events.push({ at: now(), type: "host_tool_access_denied", data });
        this.logger.info("host_tool_access_denied", data);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denial } };
      }] }] };
    if (selection) options.model = selection.provider.model;
    else if (process.env.ANTHROPIC_MODEL) options.model = process.env.ANTHROPIC_MODEL;
    if (this.config.claudeExecutable) options.pathToClaudeCodeExecutable = this.config.claudeExecutable;
    if (live.sdkSessionId) options.resume = live.sdkSessionId;
    live.events.push({ at: now(), type: "sdk_query_start", data: { resumed: Boolean(live.sdkSessionId), sdkSessionId: live.sdkSessionId, droidMcp: catalog.definitions().map((tool) => tool.name) } });
    try {
      live.query = sdk.query({ prompt: live.inputs, options });
      // Iterate the Query itself. Its close() owns process shutdown; never call raw generator.return().
      live.loop = this.consume(live, live.query, live.queryEpoch);
    } catch (error) {
      this.stop(live, asBridgeError(error));
      throw asBridgeError(error);
    }
  }

  private async canUseTool(live: LiveSdk, name: string, input: Record<string, unknown>, context: NativePermissionContext = {}): Promise<RuntimePermissionDecision> {
    if (live.terminal) return { behavior: "deny", message: "Session is closed" };
    const denial = toolAccessDenial(live, name, live.current && this.control?.factoryPermissionMode?.(live.current.session.bridgeSessionId));
    if (denial) return { behavior: "deny", message: denial };
    const control = this.control;
    if (!control || !live.current) {
      live.events.push({ at: now(), type: "permission_denied", data: { toolName: name, reason: "approval_channel_unavailable" } });
      return { behavior: "deny", message: "No approval controller is connected. Open the bridge approvals client and retry this operation." };
    }
    const approval = new AbortController();
    const epoch = live.queryEpoch;
    live.approvals.add(approval);
    const cancel = () => approval.abort();
    context.signal?.addEventListener("abort", cancel, { once: true });
    if (context.signal?.aborted) approval.abort();
    const timer = setTimeout(cancel, this.config.requestTimeoutMs);
    timer.unref();
    let interrupted!: () => void;
    const aborted = new Promise<RuntimePermissionDecision>((resolve) => {
      interrupted = () => resolve({ behavior: "deny", message: "Native approval expired or was cancelled" });
      approval.signal.addEventListener("abort", interrupted, { once: true });
      if (approval.signal.aborted) interrupted();
    });
    const details: RuntimeApprovalRequest = {
      bridgeSessionId: live.current.session.bridgeSessionId, sdkSessionId: live.sdkSessionId,
      toolName: name, input: structuredClone(input), signal: approval.signal,
      toolUseId: context.toolUseID, requestId: context.requestId, agentId: context.agentID,
      title: context.title, description: context.description, decisionReason: context.decisionReason,
      blockedPath: context.blockedPath, defaultToNo: context.defaultToNo, suppressAlwaysAllowRule: context.suppressAlwaysAllowRule,
    };
    live.events.push({ at: now(), type: "permission_requested", data: { toolName: name, toolUseId: context.toolUseID, requestId: context.requestId } });
    try {
      if (approval.signal.aborted) return await aborted;
      const decision = await Promise.race([control.requestApproval(details), aborted]);
      if (live.terminal || live.queryEpoch !== epoch || approval.signal.aborted || this.control !== control) {
        return { behavior: "deny", message: "Native approval is no longer live" };
      }
      const currentDenial = toolAccessDenial(live, name, live.current && this.control?.factoryPermissionMode?.(live.current.session.bridgeSessionId));
      if (currentDenial) return { behavior: "deny", message: currentDenial };
      if (!decision || (decision.behavior !== "allow" && decision.behavior !== "deny")) {
        return { behavior: "deny", message: "The approval controller returned an invalid decision" };
      }
      live.events.push({ at: now(), type: decision.behavior === "allow" ? "permission_allowed" : "permission_denied", data: { toolName: name, toolUseId: context.toolUseID } });
      return decision.behavior === "allow"
        ? { behavior: "allow", updatedInput: decision.updatedInput ?? input }
        : { behavior: "deny", message: decision.message || "The operation was denied" };
    } catch (error) {
      live.events.push({ at: now(), type: "permission_denied", data: { toolName: name, reason: "approval_controller_error" } });
      this.logger.warn("approval_controller_error", { sessionId: details.bridgeSessionId, toolName: name, error: error instanceof Error ? error.message : String(error) });
      return { behavior: "deny", message: "The approval controller disconnected or failed" };
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", cancel);
      approval.signal.removeEventListener("abort", interrupted);
      live.approvals.delete(approval);
      approval.abort();
    }
  }

  private claimCall(live: LiveSdk, name: string, input: Record<string, unknown>, callId?: string, mcpName?: string): Promise<DroidCall> {
    if (live.terminal) return Promise.reject(live.terminal);
    if (callId && (live.claimedHandlers.has(callId) || live.retiredCandidates.has(callId))) {
      return Promise.reject(new BridgeError(409, "duplicate_tool_handler", "The SDK tool invocation was already handled or rejected"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => arrival.reject(new BridgeError(504, "sdk_tool_handoff_timeout", `No matching SDK tool_use arrived for ${name}`)), Math.min(this.config.requestTimeoutMs, this.config.toolWaitMs));
      const arrival: HandlerArrival = {
        name, input, callId, mcpName,
        resolve: (call) => { clearTimeout(timer); live.handlerArrivals.delete(arrival); resolve(call); },
        reject: (error) => { clearTimeout(timer); live.handlerArrivals.delete(arrival); reject(error); },
      };
      live.handlerArrivals.add(arrival);
      this.matchHandlers(live);
    });
  }

  private matchHandlers(live: LiveSdk): void {
    for (const arrival of [...live.handlerArrivals]) {
      const candidates = [...live.candidates.values()].filter((call) =>
        !live.claimedHandlers.has(call.id) && call.name === arrival.name
        && (!arrival.callId || call.id === arrival.callId)
        && (!arrival.mcpName || call.mcpName === arrival.mcpName)
        && canonicalJson(call.input) === canonicalJson(arrival.input));
      const rivals = [...live.handlerArrivals].filter((other) => other !== arrival && !other.callId && !arrival.callId
        && other.name === arrival.name && other.mcpName === arrival.mcpName && canonicalJson(other.input) === canonicalJson(arrival.input));
      if (candidates.length > 1 || (candidates.length && rivals.length)) {
        const error = new BridgeError(409, "ambiguous_tool_call", `Cannot safely associate the SDK callback for ${arrival.name} with one tool call`);
        this.stop(live, error);
        return;
      }
      const call = candidates[0];
      if (!call) continue; // SDK control requests can arrive before assistant output.
      live.candidates.delete(call.id);
      live.claimedHandlers.add(call.id);
      arrival.resolve(call);
    }
  }

  private retireNativeToolResults(live: LiveSdk, message: Record<string, unknown>): void {
    const body = message.message as { content?: unknown } | undefined;
    if (!Array.isArray(body?.content)) return;
    for (const block of body.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const id = block.tool_use_id;
      live.candidates.delete(id);
      live.retiredCandidates.add(id);
      for (const arrival of [...live.handlerArrivals]) {
        if (arrival.callId === id) arrival.reject(new BridgeError(409, "sdk_tool_rejected", "The native SDK rejected this tool invocation before handoff"));
      }
      if (live.pending.has(id)) throw new BridgeError(502, "sdk_tool_interrupted", "The native SDK completed a Droid tool before its external result arrived; do not replay it");
    }
  }

  private async consume(live: LiveSdk, iterator: AsyncIterable<Record<string, unknown>>, epoch: number): Promise<void> {
    try {
      // Official Query.next()/return() manage its process; its raw iterator's
      // return() can remain parked waiting for another streaming-input turn.
      const query = iterator as AsyncIterable<Record<string, unknown>> & Partial<AsyncIterator<Record<string, unknown>>>;
      const source = typeof query.next === "function"
        ? { [Symbol.asyncIterator]: () => query as AsyncIterator<Record<string, unknown>> }
        : iterator;
      for await (const message of source) {
        if (live.terminal || live.queryEpoch !== epoch) return;
        if (typeof message.session_id === "string") live.sdkSessionId = message.session_id;
        const event = { at: now(), type: String(message.subtype === "compact_boundary" ? "compact_boundary" : message.type ?? "sdk"), data: summarizeSdk(message) };
        live.events.push(event);
        if (live.events.length > 1000) live.events.splice(0, live.events.length - 1000);
        if (message.subtype === "compact_boundary" && message.compact_metadata && typeof message.compact_metadata === "object") {
          live.compactMetadata = structuredClone(message.compact_metadata as Record<string, unknown>);
          this.logger.info("sdk_compact_boundary", { sdkSessionId: live.sdkSessionId, ...live.compactMetadata });
        }
        this.noteUsage(live, message);
        if (message.type === "system" && message.subtype === "task_started" && typeof message.task_id === "string") live.backgroundTasks.add(message.task_id);
        if (message.type === "system" && message.subtype === "task_notification" && typeof message.task_id === "string") live.backgroundTasks.delete(message.task_id);
        if (message.type === "stream_event") {
          if (message.parent_tool_use_id) continue;
          const text = streamTextDelta(message);
          if (text) { live.streamed += text; live.sink?.textDelta(text); }
          continue;
        }
        if (message.type === "user") this.retireNativeToolResults(live, message);
        if (message.type === "assistant") {
          const uses = extractToolUses(message);
          for (const use of uses) {
            if (isDroidMcpName(use.name)) {
              // The official MCP CallToolRequest parser drops this root key.
              // Reject the original proposal before joining its mutated handler
              // arguments; never wait for a match or forward altered parameters.
              if (use.input && typeof use.input === "object" && Object.hasOwn(use.input, "__proto__")) {
                throw new BridgeError(422, "unsupported_tool_argument", "The official MCP transport cannot preserve a root __proto__ argument");
              }
              const bare = use.name.replace(/^mcp__droid__/, "");
              const original = live.names?.toOriginal(bare);
              // A stale/unknown proposal can still be rejected by the native
              // tool runner and corrected by the model. It grants no authority.
              if (!original || (!live.catalog?.hasVersion(original, bare) && !live.mailbox.hasCall(use.id))) continue;
              const published = live.mailbox.getCall(use.id);
              if (published && (published.originalName !== original || canonicalJson(published.input) !== canonicalJson(use.input))) throw new BridgeError(409, "conflicting_sdk_tool", "SDK reused a published tool id for different arguments");
              if (!live.claimedHandlers.has(use.id) && !live.retiredCandidates.has(use.id)) {
                const call = { ...use, name: original, mcpName: bare };
                const previous = live.candidates.get(use.id);
                if (previous && (previous.name !== call.name || canonicalJson(previous.input) !== canonicalJson(call.input))) throw new BridgeError(409, "conflicting_sdk_tool", "SDK reused a tool id for different arguments");
                live.candidates.set(use.id, call);
              }
            } else {
              live.sink?.toolTrace(use.name, claudeToolTraceDetail(use.name, use.input));
              live.events.push({ at: now(), type: "claude_code_tool", data: { name: use.name, id: use.id } });
            }
          }
          const text = message.parent_tool_use_id ? "" : extractText(message);
          if (text && !live.streamed.includes(text)) {
            live.blocks.push({ type: "text", text });
            if (!live.streamed) live.sink?.textDelta(text);
          }
          this.matchHandlers(live);
        }
        if (message.type === "result") {
          if (message.parent_tool_use_id) continue;
          if (message.is_error === true || (typeof message.subtype === "string" && message.subtype !== "success")) {
            const errors = Array.isArray(message.errors) ? message.errors.filter((item): item is string => typeof item === "string").join("; ") : "";
            throw new BridgeError(502, "sdk_execution_error", errors || extractText(message) || String(message.subtype ?? "SDK execution failed"));
          }
          if (!live.active) continue;
          if (live.pending.size || live.handlerArrivals.size) throw new BridgeError(502, "sdk_unfinished_tools", "SDK ended a turn while Droid tools were unresolved");
          for (const id of live.candidates.keys()) live.retiredCandidates.add(id);
          live.candidates.clear();
          live.active = false;
          const fallback = extractText(message);
          if (!live.streamed && !live.blocks.length && fallback) live.blocks.push({ type: "text", text: fallback });
          this.publish(live, this.makeTurn(live, [], "end_turn"));
        }
      }
      if (!live.terminal && live.queryEpoch === epoch) {
        // Streaming mode must remain alive between turns; an unexpected EOF is not a successful reply.
        this.stop(live, new BridgeError(502, "sdk_stream_closed", "The Claude Code session ended unexpectedly; resume it in a new bridge process or start a new session"));
      }
    } catch (error) {
      if (!live.terminal && live.queryEpoch === epoch) this.stop(live, asBridgeError(error));
    }
  }

  private noteUsage(live: LiveSdk, message: Record<string, unknown>): void {
    const event = live.usage.ingest(message);
    if (!event) return;
    const data = { ...event, sessionId: live.current?.session.bridgeSessionId, sdkSessionId: live.sdkSessionId };
    mkdirSync(this.config.logDir, { recursive: true });
    appendFileSync(this.usageFile, `${JSON.stringify({ at: now(), ...data })}\n`);
    live.events.push({ at: now(), type: "usage", data });
  }

  private makeTurn(live: LiveSdk, extra: ContentBlock[], stop: "tool_use" | "end_turn"): RuntimeTurn {
    const text = live.streamed.trim();
    const content: ContentBlock[] = text ? [{ type: "text", text }, ...extra] : [...live.blocks, ...extra];
    if (!content.length) content.push({ type: "text", text: "" });
    const usage = live.usage.drainTurnUsage() as Usage;
    const turn: RuntimeTurn = {
      response: assistantMessage(live.current!.request.model, content, stop, usage),
      pendingToolIds: [...live.pending.keys()], sdkSessionId: live.sdkSessionId,
      compactMetadata: live.compactMetadata, sdkBillingUsage: live.usage.billingSnapshot(), events: [...live.events],
    };
    live.blocks = [];
    live.streamed = "";
    return turn;
  }

  private publish(live: LiveSdk, turn: RuntimeTurn): void {
    if (live.terminal) return;
    if (live.waiter) live.waiter.resolve(turn);
    else live.outbox.push(turn);
  }

  private waitForTurn(live: LiveSdk): Promise<RuntimeTurn> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(live, new BridgeError(504, "sdk_turn_timeout", "SDK turn timed out and was cancelled")), this.config.requestTimeoutMs);
      live.waiter = {
        resolve: (turn) => { clearTimeout(timer); live.waiter = undefined; resolve(turn); },
        reject: (error) => { clearTimeout(timer); live.waiter = undefined; reject(error); },
      };
      if (live.terminal) live.waiter.reject(live.terminal);
    });
  }

  private flushOutbox(live: LiveSdk): void {
    while (live.waiter && live.outbox.length) {
      const turn = live.outbox.shift()!;
      if (turn.response.stop_reason === "tool_use") {
        turn.response.content = turn.response.content.filter((block) => block.type !== "tool_use" || live.pending.has((block as { id: string }).id));
        if (!turn.response.content.some((block) => block.type === "tool_use")) continue;
        turn.pendingToolIds = [...live.pending.keys()];
      }
      live.waiter.resolve(turn);
    }
  }

  private stop(live: LiveSdk, error: BridgeError): void {
    if (live.terminal) return;
    live.terminal = error;
    live.active = false;
    live.inputs.close();
    for (const approval of live.approvals) approval.abort();
    live.approvals.clear();
    live.mailbox.cancel(error.message);
    for (const consumption of live.hostResultConsumptions.values()) consumption.resolve();
    live.hostResultConsumptions.clear();
    for (const arrival of [...live.handlerArrivals]) arrival.reject(error);
    live.candidates.clear();
    live.abort?.abort();
    // Do not await interrupt before close: a dead subprocess must not delay cancellation.
    try { void live.query?.interrupt?.().catch(() => undefined); } catch { /* best effort */ }
    try { live.query?.close?.(); } catch { /* already closed */ }
    live.waiter?.reject(error);
    live.outbox.length = 0;
  }

  private async loadSdk(): Promise<SdkHandle> {
    if (this.sdk) return this.sdk;
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      if (!sdk.query || !sdk.tool || !sdk.createSdkMcpServer) throw new Error("SDK exports missing query/tool/createSdkMcpServer");
      this.sdk = sdk as unknown as SdkHandle;
      return this.sdk;
    } catch (error) { throw new BridgeError(503, "sdk_unavailable", error instanceof Error ? error.message : String(error)); }
  }
}

function trailingUserMessages(input: RuntimeRequest): RuntimeRequest["request"]["messages"] {
  const messages = input.request.messages;
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.role === "user") start--;
  return messages.slice(start);
}

function latestToolResults(input: RuntimeRequest, includeTrailingUserMessages = false): DroidResult[] {
  const latest = input.request.messages.at(-1);
  if (!latest || latest.role !== "user") throw new BridgeError(400, "invalid_turn", "A new turn must end with a user message");
  const messages = includeTrailingUserMessages ? trailingUserMessages(input) : [latest];
  return messages.flatMap((message) => asBlocks(message.content)).filter((block) => block.type === "tool_result").map((block) => {
    const result = block as { tool_use_id?: string; content?: string | ContentBlock[]; is_error?: boolean };
    return {
    tool_use_id: String(result.tool_use_id ?? ""), content: result.content ?? "", is_error: Boolean(result.is_error),
    };
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function resultFingerprint(result: DroidResult): string {
  return JSON.stringify({ tool_use_id: result.tool_use_id, content: result.content, is_error: Boolean(result.is_error) });
}

function mcpContent(content: string | ContentBlock[]): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") {
      const source = (block as { source?: unknown }).source as { type?: string; data?: string; media_type?: string; url?: string };
      if (source?.type === "base64") return { type: "image", data: source.data, mimeType: source.media_type };
      if (source?.type === "url") return { type: "resource_link", uri: source.url, name: "Droid image" };
    }
    if (["resource", "resource_link", "audio"].includes(block.type)) return { ...block };
    throw new BridgeError(422, "unsupported_tool_result_content", `Cannot preserve tool result block ${block.type} in MCP`);
  });
}

function queryPolicy(input: RuntimeRequest, config: BridgeConfig): string {
  return JSON.stringify({ model: input.request.model, role: input.role, cwd: resolveCwd(input, config), permission: config.permissionMode });
}
function toolAccessDenial(live: LiveSdk, name: string | undefined, factoryPermissionMode?: string): string | undefined {
  const request = live.current?.request;
  if (!hostAllowsAnyTools(request)) return "BRIDGE_HOST_TOOL_ACCESS_NONE: This host request permits no tools. Answer using the supplied conversation only.";
  if (name?.startsWith("mcp__droid__")) {
    const mcpName = name.slice("mcp__droid__".length);
    const original = live.names?.toOriginal(mcpName);
    if (original && request?.tools?.some((tool) => tool.name === original) && live.catalog?.hasVersion(original, mcpName)) return;
  } else if (nativeToolAllowed(name, request)) {
    if ((factoryPermissionMode ?? live.current?.factoryPermissionMode) === "spec" && !["Read", "Glob", "Grep", "LS"].includes(name!)) {
      return "BRIDGE_FACTORY_SPEC_READ_ONLY: Factory spec mode permits native read tools only. Propose the plan through Factory and wait for its permission transition before executing changes.";
    }
    return;
  }
  return `BRIDGE_HOST_TOOL_NOT_ADVERTISED: ${name ?? "Unknown tool"} is not authorized by the current host tool set. Use only its advertised native equivalents or Factory MCP tools; do not work around this restriction.`;
}
function resolveCwd(input: RuntimeRequest, config: BridgeConfig): string {
  const raw = input.headers["x-bridge-cwd"];
  return canonicalWorkspacePath(process.env.BRIDGE_SDK_CWD || (Array.isArray(raw) ? raw[0] : raw) || config.sdkCwd);
}
function extractToolUses(message: Record<string, unknown>): DroidCall[] {
  const content = (message.message as { content?: unknown[] } | undefined)?.content ?? [];
  return content.filter((raw): raw is DroidCall & { type: string } => Boolean(raw && typeof raw === "object" && (raw as { type?: string }).type === "tool_use")).map((use) => ({ id: use.id, name: use.name, input: use.input ?? {} }));
}
function extractText(message: Record<string, unknown>): string {
  if (typeof message.result === "string") return message.result;
  const content = (message.message as { content?: ContentBlock[] } | undefined)?.content ?? [];
  return content.filter((block) => block.type === "text").map((block) => (block as { text?: string }).text ?? "").join("");
}
function streamTextDelta(message: Record<string, unknown>): string {
  const event = message.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
  return event?.type === "content_block_delta" && event.delta?.type === "text_delta" ? event.delta.text ?? "" : "";
}
function extractCallId(extra: unknown): string | undefined {
  if (!extra || typeof extra !== "object") return undefined;
  const rec = extra as Record<string, unknown>;
  for (const key of ["toolUseId", "toolUseID", "tool_use_id"]) if (typeof rec[key] === "string") return rec[key] as string;
  for (const key of ["meta", "_meta"]) {
    const meta = rec[key] as Record<string, unknown> | undefined;
    if (meta && typeof meta.toolUseId === "string") return meta.toolUseId;
  }
  return undefined;
}
function summarizeSdk(message: Record<string, unknown>): Record<string, unknown> {
  return { type: message.type, subtype: message.subtype, session_id: message.session_id,
    ...(message.subtype === "compact_boundary" ? { compact_metadata: structuredClone(message.compact_metadata) } : {}) };
}
function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new BridgeError(/auth|login|unauthorized|api key|credit|billing/i.test(message) ? 401 : 502, /auth|login|unauthorized|api key|credit|billing/i.test(message) ? "blocked_auth" : "sdk_error", message);
}
function now(): string { return new Date().toISOString(); }
