import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "../../config.js";
import type { Logger } from "../../logging.js";
import { assistantMessage } from "../../protocol/messages.js";
import { canonicalToolUseId, collectToolResults, textFromBlocks } from "../../protocol/content.js";
import { providerFromModelId, type CursorModelParameter } from "../../models.js";
import { applyCursorReasoning, droidReasoningLevel } from "../reasoning.js";
import { BridgeError, type ContentBlock, type Json, type Usage } from "../../types.js";
import { historyMessageHashes } from "../../sessions/correlate.js";
import { resolveRequestCwd } from "../../workspace.js";
import { buildDynamicUserContent, buildInitialUserContent } from "../system-prompt.js";
import { INTERRUPT_GRACE_MS } from "../turn-watchdog.js";
import { upstreamError } from "../upstream-error.js";
import { redactValue } from "../../security/redact.js";
import type { BridgeRuntime, RuntimeControl, RuntimeHostCall, RuntimeHostCompletion, RuntimeHostEnd, RuntimeRequest, RuntimeTurn, StreamSink } from "../types.js";
import type { CursorAgentApi, CursorAgentLike, CursorRunLike, CursorRunResult } from "./agent-api.js";
import { cursorApiKey, cursorCredentialStatus, cursorReauthMessage, cursorStoredKeyExpired } from "./credentials.js";
import { applyCursorUpdate, emptyCursorDraft, type CursorTurnDraft, type CursorUpdate } from "./events.js";
import { loadCursorSdk, openCursorAgentStore, type CursorAgentStore } from "./sdk-load.js";
import { deferredToolDefinitions } from "./deferred-catalog.js";
import { assertCursorNativeTools, bareDroidToolName, base64Image, CURSOR_NATIVE_TOOLS, customToolDefinitions, outboundDroidToolName, toCursorToolResult, type CursorCustomToolResult } from "./tools.js";

interface PendingTool {
  resolve: (result: CursorCustomToolResult) => void;
  reject: (error: unknown) => void;
  name: string;
  outbound: string;
  input: Record<string, unknown>;
}

interface LiveCursor {
  agent?: CursorAgentLike;
  run?: CursorRunLike;
  pending: Map<string, PendingTool>;
  draft: CursorTurnDraft;
  checkpoint: boolean;
  busy: boolean;
  sent: boolean;
  settled?: Promise<CursorRunResult>;
  sink?: StreamSink;
  releasePark?: () => void;
  lastRequestHash?: string;
  lastTurn?: RuntimeTurn;
  ended?: BridgeError;
  cancelled: Promise<never>;
  rejectCancellation(error: BridgeError): void;
  lastTouched: number;
  stopping?: Promise<void>;
}

export interface CursorSdkDependencies {
  api?: CursorAgentApi;
  nativeTools?: readonly string[];
  interruptGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  openStore?: typeof openCursorAgentStore;
}

/** Local Cursor agent. The real SDK is loaded only when no agent API is injected. */
export class CursorSdkRuntime implements BridgeRuntime {
  readonly kind = "cursor" as const;
  private readonly lives = new Map<string, LiveCursor>();
  private readonly nativeTools: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly grace: number;
  private readonly now: () => number;
  private api?: CursorAgentApi;
  private readonly injected: boolean;
  private store?: Promise<CursorAgentStore>;
  private closing = false;
  private cleanupTimeouts = 0;
  private readonly openStore?: typeof openCursorAgentStore;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    dependencies: CursorSdkDependencies = {},
  ) {
    this.nativeTools = dependencies.nativeTools ?? CURSOR_NATIVE_TOOLS;
    this.env = dependencies.env ?? process.env;
    this.grace = dependencies.interruptGraceMs ?? INTERRUPT_GRACE_MS;
    this.now = dependencies.now ?? Date.now;
    this.api = dependencies.api;
    this.injected = dependencies.api !== undefined;
    this.openStore = dependencies.openStore ?? (this.injected ? undefined : openCursorAgentStore);
  }

  setControl(_control: RuntimeControl | undefined): void {
    // The SDK has no approval callback. Native reads are not routed through Control.
  }

  describe(): Record<string, unknown> {
    const status = cursorCredentialStatus(this.config.dataDir, this.env, this.now());
    return {
      kind: "cursor",
      agents: this.lives.size,
      cleanupTimeouts: this.cleanupTimeouts,
      slotsInUse: [...this.lives.values()].filter((live) => live.agent || live.busy).length,
      pendingHostCalls: [...this.lives.values()].reduce((sum, live) => sum + live.pending.size, 0),
      keyExpiresAt: status.expiresAt ?? null,
      accountPresent: status.accountPresent,
      loggedIn: status.loggedIn,
    };
  }

  pendingHostCalls(sessionId: string): RuntimeHostCall[] {
    const live = this.lives.get(sessionId);
    if (!live) return [];
    return [...live.pending.entries()].map(([toolUseId, call]) => ({ toolUseId, toolName: call.name, input: call.input }));
  }

  protectedSessionIds(): string[] {
    return [...this.lives.entries()].filter(([, live]) => !live.ended && (live.busy || live.pending.size || live.run?.status === "running")).map(([id]) => id);
  }

  isSessionUsable(sessionId: string): boolean {
    const live = this.lives.get(sessionId);
    return Boolean(live && !live.ended);
  }

  async deliverResults(sessionId: string, results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>): Promise<Array<"accepted" | "duplicate">> {
    return results.map((result) => this.acceptTool(sessionId, result.tool_use_id, result.content, result.is_error));
  }

  async completeHostTool(sessionId: string, completion: RuntimeHostCompletion): Promise<"accepted" | "duplicate"> {
    return this.acceptTool(sessionId, completion.toolUseId, completion.content, completion.isError);
  }

  async handle(input: RuntimeRequest, sink?: StreamSink): Promise<RuntimeTurn> {
    if (this.closing) throw new BridgeError(503, "bridge_shutting_down", "Bridge is shutting down");
    const tools = assertCursorNativeTools(this.nativeTools);
    const selection = this.selection(input.request.model, input.request);
    const live = this.live(input.session.bridgeSessionId);
    if (live.busy) throw new BridgeError(409, "session_busy", "This Cursor session already has an active request");
    live.busy = true;
    live.lastTouched = this.now();
    live.sink = sink;
    try {
      const requestHash = historyMessageHashes(input.request.messages).join("\n");
      if (live.lastTurn && live.lastRequestHash === requestHash) return live.lastTurn;
      live.draft = emptyCursorDraft();
      if (cursorStoredKeyExpired(this.config.dataDir, this.env, this.now())) {
        throw new BridgeError(401, "cursor_auth", cursorReauthMessage("Cursor key is expired."));
      }
      this.deliverRequestResults(live, input);
      const agent = await this.ensureAgent(live, input, selection, tools);
      // A follow-up can arrive while the previous run is still open. Resolving the
      // parked tool may make the model call another tool before wait() settles.
      // Arm a fresh park so that call is returned to Droid instead of waiting forever.
      if (live.run && live.run.status === "running") {
        if (live.pending.size) return this.remember(live, requestHash, this.toolTurn(live, input));
        return this.remember(live, requestHash, await this.finishOrPark(live, input, this.armPark(live)));
      }
      const message = this.userMessage(input, !input.session.sdkSessionId && !live.sent);
      this.logger.info("cursor_run_params", { model: selection.id, params: selection.params });
      let parked = false;
      const park = new Promise<void>((resolve) => { live.releasePark = () => { parked = true; resolve(); }; });
      const sending = agent.send(message, {
        model: { id: selection.id, params: selection.params },
        onDelta: ({ update }) => this.observe(live, update),
        local: { customTools: this.customTools(live, input) },
      }).then(async (run) => {
        if (live.ended) { await this.bounded(run.cancel()); throw live.ended; }
        return run;
      });
      const run = await Promise.race([sending, live.cancelled]);
      live.run = run;
      live.sent = true;
      live.settled = run.wait().then((result) => {
        if (result.status === "finished") live.checkpoint = true;
        return result;
      }).catch((error: unknown) => {
        this.logger.warn("cursor_run_failed", { name: error instanceof Error ? error.name : "unknown" });
        throw error;
      });
      void live.settled.catch(() => undefined);
      if (parked || live.pending.size) return this.remember(live, requestHash, this.toolTurn(live, input));
      return this.remember(live, requestHash, await this.finishOrPark(live, input, park));
    } catch (error) {
      const retrySafe = !live.pending.size;
      await this.cancel(input.session.bridgeSessionId, "request-failed");
      const converted = upstreamError(error) ?? presentCursorAuthError(error);
      if (converted instanceof Error) {
        const key = cursorApiKey(this.config.dataDir, this.env, this.now());
        const message = redactValue(key ? converted.message.replaceAll(key, "[redacted]") : converted.message);
        throw converted instanceof BridgeError ? new BridgeError(converted.status, converted.code, message,
          [429, 529].includes(converted.status) && retrySafe ? { ...converted.extra, retry_from_history: true } : converted.extra) : new BridgeError(502, "cursor_sdk_error", message);
      }
      throw converted;
    } finally {
      live.busy = false;
      live.sink = undefined;
      live.lastTouched = this.now();
      void this.trimIdle().catch(() => this.logger.warn("cursor_idle_trim_failed"));
    }
  }

  async interrupt(sessionId: string, _reason: string): Promise<boolean> {
    const live = this.lives.get(sessionId);
    const run = live?.run;
    if (!live || !run || run.status !== "running") return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cancelled = run.cancel().then(() => run.status !== "running").catch(() => false);
      const timed = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), this.grace); });
      await Promise.race([cancelled, timed]);
      if (run.status === "running") {
        await this.bounded(this.agents().cancelRun?.(run.id));
      }
      return run.status !== "running" && live.checkpoint;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    const live = this.lives.get(sessionId);
    if (!live) return;
    if (live.stopping) return live.stopping;
    const error = new BridgeError(499, "cancelled", reason);
    live.ended = error;
    live.rejectCancellation(error);
    live.sink = undefined;
    live.releasePark = undefined;
    for (const pending of live.pending.values()) pending.reject(error);
    live.pending.clear();
    try { live.agent?.close(); } catch { this.logger.warn("cursor_close_failed", { sessionId }); }
    live.stopping = (async () => {
      await this.bounded(Promise.resolve().then(() => live.run?.cancel()));
      if (live.run?.status === "running") await this.bounded(this.agents().cancelRun?.(live.run.id));
    })().finally(() => { if (this.lives.get(sessionId) === live) this.lives.delete(sessionId); });
    return live.stopping;
  }

  async endHostSession(sessionId: string, reason: string): Promise<RuntimeHostEnd> {
    const live = this.lives.get(sessionId);
    const resumable = Boolean(live?.checkpoint && live.pending.size === 0);
    const sdkSessionId = live?.agent?.agentId;
    await this.cancel(sessionId, reason);
    return { resumable, sdkSessionId };
  }

  async forget({ bridgeSessionId: sessionId, sdkSessionId }: import("../types.js").RetiredSession): Promise<void> {
    const live = this.lives.get(sessionId);
    if (live && (live.busy || live.pending.size || live.run?.status === "running")) return;
    if (live) await this.cancel(sessionId, "session-expired");
    if (sdkSessionId && this.store) {
      const store = await this.store;
      if (store.agents) await store.agents.delete({ filter: { agentIds: [sdkSessionId] } });
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.lives.keys()].map((sessionId) => this.cancel(sessionId, "bridge shutdown")));
    if (this.store) await this.bounded(this.store.then((store) => store.dispose?.()));
    this.store = undefined;
  }

  private async bounded(operation?: Promise<unknown>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([operation?.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(() => { this.cleanupTimeouts++; this.logger.warn("cursor_cleanup_timeout"); resolve(); }, this.grace); })]); }
    finally { if (timer) clearTimeout(timer); }
  }

  private async trimIdle(): Promise<void> {
    if (!this.config.persistSessions) return;
    const idle = [...this.lives.entries()].filter(([, live]) => live.checkpoint && !live.busy && !live.pending.size && live.run?.status !== "running").sort(([, a], [, b]) => a.lastTouched - b.lastTouched);
    await Promise.all(idle.slice(0, Math.max(0, idle.length - (this.config.maxIdleSessions ?? 4))).map(([id]) => this.cancel(id, "idle-pool-limit")));
  }

  private remember(live: LiveCursor, requestHash: string, turn: RuntimeTurn): RuntimeTurn {
    live.lastRequestHash = requestHash;
    live.lastTurn = turn;
    return turn;
  }

  private live(sessionId: string): LiveCursor {
    const existing = this.lives.get(sessionId);
    if (existing) return existing;
    let rejectCancellation!: (error: BridgeError) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    void cancelled.catch(() => undefined);
    const created: LiveCursor = { pending: new Map(), draft: emptyCursorDraft(), checkpoint: false, busy: false, sent: false, cancelled, rejectCancellation, lastTouched: this.now() };
    this.lives.set(sessionId, created);
    return created;
  }

  private agents(): CursorAgentApi {
    if (!this.api) this.api = loadCursorSdk().Agent;
    return this.api;
  }

  private selection(modelId: string, request: RuntimeRequest["request"]): { id: string; params: CursorModelParameter[] } {
    if (providerFromModelId(modelId) !== "cursor") throw new BridgeError(400, "unknown_model", "This model is not a Cursor model.");
    const profile = this.config.models?.find((model) => model.id === modelId && model.provider === "cursor");
    if (!profile?.cursor) throw new BridgeError(400, "unknown_model", "This Cursor model is not on the menu.");
    return {
      id: profile.cursor.id,
      params: applyCursorReasoning(profile.cursor.params, profile.cursor.parameters, droidReasoningLevel(request)),
    };
  }

  private async ensureAgent(live: LiveCursor, input: RuntimeRequest, selection: { id: string; params: CursorModelParameter[] }, tools: string[]): Promise<CursorAgentLike> {
    if (live.agent) return live.agent;
    const occupied = [...this.lives.values()].filter((other) => other.agent || other.busy);
    if (occupied.length > this.config.maxSessions) {
      const idle = [...this.lives.entries()].filter(([, other]) => other !== live && other.checkpoint && !other.busy && !other.pending.size && other.run?.status !== "running")
        .sort(([, a], [, b]) => a.lastTouched - b.lastTouched)[0];
      if (!idle) throw new BridgeError(429, "rate_limit_error", "All Cursor slots have live work. Retry later.", { retry_after: 1 });
      await this.cancel(idle[0], "idle-eviction");
      this.logger.info("cursor_idle_evicted", { sessionId: idle[0] });
    }
    const options = await Promise.race([this.agentOptions(live, input, selection, tools), live.cancelled]);
    if (live.ended || this.closing) throw live.ended ?? new BridgeError(503, "bridge_shutting_down", "Bridge is shutting down");
    // A cross-provider session has no Cursor agent id. Reference history is sent; nothing is resumed.
    const resumeId = input.session.sdkSessionId;
    const creating = (resumeId ? this.agents().resume(resumeId, options) : this.agents().create(options)).then((agent) => {
      if (live.ended || this.closing) { agent.close(); throw live.ended ?? new Error("Bridge is shutting down"); }
      return agent;
    });
    live.agent = await Promise.race([creating, live.cancelled]);
    return live.agent;
  }

  private async agentOptions(live: LiveCursor, input: RuntimeRequest, selection: { id: string; params: CursorModelParameter[] }, tools: string[]): Promise<Record<string, unknown>> {
    const cwd = resolveRequestCwd(input.headers, input.request, this.config);
    const apiKey = cursorApiKey(this.config.dataDir, this.env, this.now());
    const store = this.openStore ? await this.agentStore(cwd, this.openStore) : undefined;
    return {
      model: { id: selection.id, params: selection.params },
      tools,
      ...(apiKey ? { apiKey } : {}),
      local: { cwd, ...(store ? { store } : {}), customTools: this.customTools(live, input) },
    };
  }

  private agentStore(workspaceRef: string, openStore: typeof openCursorAgentStore): Promise<CursorAgentStore> {
    if (!this.store) this.store = openStore(this.config.dataDir, workspaceRef).catch((error: unknown) => { this.store = undefined; throw error; });
    return this.store;
  }

  private customTools(live: LiveCursor, input: RuntimeRequest): Record<string, { description?: string; inputSchema?: Record<string, unknown>; execute: (args: Record<string, unknown>, context: { toolCallId?: string }) => Promise<CursorCustomToolResult> }> {
    const advertised = new Map((input.request.tools ?? []).map((tool) => [bareDroidToolName(tool.name), tool.name]));
    const tools: Record<string, { description?: string; inputSchema?: Record<string, unknown>; execute: (args: Record<string, unknown>, context: { toolCallId?: string }) => Promise<CursorCustomToolResult> }> = {};
    const nativeReads = new Set(["Read", "LS", "Grep", "Glob"]);
    const customSource = this.config.desktopProfile
      ? (input.request.tools ?? []).filter((tool) => !nativeReads.has(bareDroidToolName(tool.name)))
      : input.request.tools ?? [];
    const advertisedNames = new Set(customSource.map((tool) => bareDroidToolName(tool.name)));
    const merged = [...customSource, ...deferredToolDefinitions(input.request.messages, advertisedNames)];
    for (const tool of customToolDefinitions(merged)) {
      tools[tool.name] = {
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: (args, context) => new Promise((resolve, reject) => {
          if (live.ended) { reject(live.ended); return; }
          const id = canonicalToolUseId(context.toolCallId || `tool_${randomUUID().replace(/-/g, "")}`);
          const outbound = outboundDroidToolName(tool.name);
          // Current `droid exec` advertises `Execute` and rejects `mcp__droid__Execute`.
          // Deferred tools are not in this request's catalog yet, so they use the bare name
          // Droid accepts once ToolSearch has loaded them. Keep a prefix only when Droid sent one.
          const wireName = advertised.get(tool.name) ?? tool.name;
          const inputArgs = args ?? {};
          live.pending.set(id, { resolve, reject, name: advertised.get(tool.name) ?? tool.name, outbound, input: inputArgs });
          const existing = live.draft.blocks.find((block) => block.type === "tool_use" && block.id === id);
          if (existing && existing.type === "tool_use") existing.name = wireName;
          else live.draft.blocks.push({ type: "tool_use", id, name: wireName, input: inputArgs as Json });
          live.releasePark?.();
        }),
      };
    }
    return tools;
  }

  private userMessage(input: RuntimeRequest, coldImport: boolean): string | { text: string; images?: Array<{ data: string; mimeType: string }> } {
    const cwd = resolveRequestCwd(input.headers, input.request, this.config);
    const blocks = coldImport ? buildInitialUserContent(input, cwd) : buildDynamicUserContent(input, cwd);
    const images = blocks.flatMap((block) => { const image = base64Image(block); return image ? [image] : []; });
    const text = textFromBlocks(blocks);
    return images.length ? { text, images } : text;
  }

  private observe(live: LiveCursor, update: CursorUpdate): void {
    if (live.ended) return;
    applyCursorUpdate(live.draft, update);
    if (live.draft.events.length > 1000) live.draft.events.splice(0, live.draft.events.length - 1000);
    live.sink?.activity?.();
    if (update.type === "text-delta" && typeof update.text === "string") live.sink?.textDelta(update.text);
    if (update.type === "tool-call-started") {
      const call = update.toolCall;
      const raw = call && typeof call === "object" && "args" in call && call.args && typeof call.args === "object" && "toolName" in call.args && typeof call.args.toolName === "string"
        ? call.args.toolName
        : call && typeof call === "object" && "type" in call && typeof call.type === "string" ? call.type : "tool";
      // Native Cursor reads are not Droid tools. Prefixing them made the transcript say mcp__droid__read.
      const native = new Set(["read", "grep", "glob", "ls", "mcp"]);
      live.sink?.toolTrace(native.has(raw) ? raw : outboundDroidToolName(raw), raw);
    }
  }

  private deliverRequestResults(live: LiveCursor, input: RuntimeRequest): void {
    for (const result of collectToolResults(input.request.messages)) {
      const pending = this.takePending(live, result.tool_use_id);
      if (!pending) continue;
      pending.resolve(toCursorToolResult(result.content, result.is_error));
    }
  }

  private acceptTool(sessionId: string, toolUseId: string, content: string | ContentBlock[], isError?: boolean): "accepted" | "duplicate" {
    const live = this.lives.get(sessionId);
    if (!live) throw new BridgeError(409, "interrupted_tool_roundtrip", "No live Cursor agent owns these tool results");
    const pending = this.takePending(live, toolUseId);
    if (!pending) return "duplicate";
    pending.resolve(toCursorToolResult(content, isError));
    return "accepted";
  }

  /** Pending keys are canonical. A result may still carry the raw newline form. */
  private takePending(live: LiveCursor, toolUseId: string): PendingTool | undefined {
    const wanted = canonicalToolUseId(toolUseId);
    const direct = live.pending.get(wanted);
    if (direct) {
      live.pending.delete(wanted);
      return direct;
    }
    for (const [key, pending] of live.pending) {
      if (canonicalToolUseId(key) === wanted) {
        live.pending.delete(key);
        return pending;
      }
    }
    return undefined;
  }

  private armPark(live: LiveCursor): Promise<void> {
    return new Promise((resolve) => { live.releasePark = () => resolve(); });
  }

  private async finishOrPark(live: LiveCursor, input: RuntimeRequest, park?: Promise<void>): Promise<RuntimeTurn> {
    const run = live.run;
    if (!run || !live.settled) throw new BridgeError(409, "session_unavailable", "No Cursor run is in progress");
    if (live.pending.size) return this.toolTurn(live, input);
    const done = live.settled.then((result) => ({ kind: "done" as const, result }));
    const parked = (park ?? new Promise<void>(() => undefined)).then(() => ({ kind: "parked" as const }));
    const outcome = await Promise.race([done, parked, live.cancelled]);
    if (outcome.kind === "parked" || live.pending.size) return this.toolTurn(live, input);
    return this.completedTurn(live, input, outcome.result);
  }

  private toolTurn(live: LiveCursor, input: RuntimeRequest): RuntimeTurn {
    const pending = [...live.pending.keys()];
    return {
      response: assistantMessage(input.request.model, live.draft.blocks, "tool_use", { input_tokens: 0, output_tokens: 0, estimated: true }),
      pendingToolIds: pending,
      sdkSessionId: live.agent?.agentId,
      events: live.draft.events.map((event) => ({ at: new Date(this.now()).toISOString(), ...event })),
    };
  }

  private completedTurn(live: LiveCursor, input: RuntimeRequest, result: CursorRunResult): RuntimeTurn {
    if (result.status === "error") throw new BridgeError(502, "cursor_run_failed", result.error?.message || "Cursor run failed");
    if (result.status === "cancelled") throw new BridgeError(499, "cancelled", "Cursor run was cancelled");
    if (result.status === "finished") live.checkpoint = true;
    const blocks = [...live.draft.blocks];
    if (result.result && !textFromBlocks(blocks).includes(result.result)) blocks.push({ type: "text", text: result.result });
    const usage = usageFrom(result);
    return {
      response: assistantMessage(input.request.model, blocks, blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn", usage),
      pendingToolIds: [...live.pending.keys()],
      sdkSessionId: live.agent?.agentId,
      events: live.draft.events.map((event) => ({ at: new Date(this.now()).toISOString(), ...event })),
    };
  }
}

/** A rejected or expired key has to tell Droid how to mint a new one. Other failures stay as they are. */
function presentCursorAuthError(error: unknown): unknown {
  if (!(error instanceof Error) || error.message.includes("npm run desktop -- cursor login")) return error;
  if (!isCursorAuthRejection(error)) return error;
  return new BridgeError(401, "cursor_auth", cursorReauthMessage("Cursor rejected the credential."));
}

function isCursorAuthRejection(error: Error): boolean {
  if (error.name === "AuthenticationError") return true;
  const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
  if (error.name !== "BridgeError" && status === 401) return true;
  return /unauthori[sz]ed|unauthenticated|invalid api key|api key\b.*\b(expired|rejected|invalid|revoked)|not logged in|authentication failed/i.test(error.message);
}

function usageFrom(result: CursorRunResult): Usage {
  const usage = result.usage;
  if (!usage) return { input_tokens: 0, output_tokens: 0, estimated: true };
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_input_tokens: usage.cacheReadTokens,
    cache_creation_input_tokens: usage.cacheWriteTokens,
    estimated: false,
  };
}
