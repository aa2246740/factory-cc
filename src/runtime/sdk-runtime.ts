import { DESKTOP_DISALLOWED_TOOLS, DESKTOP_APPROVAL_DENIAL, DESKTOP_READ_DENIAL } from "./desktop-policy.js";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { resolveRequestCwd } from "../workspace.js";
import { asBlocks } from "../protocol/content.js";
import { assistantMessage } from "../protocol/messages.js";
import { ToolMailbox } from "../relay/mailbox.js";
import type { BridgeConfig } from "../config.js";
import type { ContentBlock, Json, Usage } from "../types.js";
import { BridgeError } from "../types.js";
import { appendLogLine, type Logger } from "../logging.js";
import { claudeToolTraceDetail, isDroidMcpName, selectDroidMcpTools } from "./droid-tools.js";
import { DroidMcpCatalog, StableDroidToolNames } from "./droid-mcp-catalog.js";
import { hostAllowsAnyTools, nativeToolAllowed } from "./native-tool-policy.js";
import { buildDynamicUserContent, buildHostContext, buildInitialUserContent, buildPresetSystemPrompt, describePromptLayout, trailingUserMessages } from "./system-prompt.js";
import { UsageLedger } from "./usage.js";
import { INTERRUPT_GRACE_MS, TurnWatchdog } from "./turn-watchdog.js";
import type { BridgeRuntime, RuntimeApprovalRequest, RuntimeControl, RuntimeEvent, RuntimeHostCall, RuntimeHostCompletion, RuntimeHostEnd, RuntimePermissionDecision, RuntimeRequest, RuntimeTurn, StreamSink } from "./types.js";
import { redactClaudeConfigText, claudeConfigNeedsLogin, CLAUDE_LOGIN_REQUIRED } from "../upstream/claude-config.js";
import { buildChildEnv, classifyAuth, maskEmail, type AuthClassification, type AuthObservation } from "../upstream/auth-env.js";
import { publicSelection, sdkEnv, selectionFromConfig, type UpstreamSelection } from "../upstream/providers.js";
import { resolveRequestModel } from "../models.js";

type ModelRoute = ReturnType<typeof resolveRequestModel>;

/** Kept narrow so tests can inject a deterministic SDK without starting a CLI. */
export interface SdkHandle {
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>> & {
    interrupt?: () => Promise<unknown>;
    close?: () => void;
    mcpServerStatus?: () => Promise<Array<{ name: string; status: string; tools?: Array<{ name: string; description?: string }> }>>;
    accountInfo?: () => Promise<Record<string, unknown>>;
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
interface DroidCall { id: string; name: string; input: unknown; mcpName?: string; messageId?: string }
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
  modelRoute?: ModelRoute;
  abort?: AbortController;
  query?: ReturnType<SdkHandle["query"]>;
  loop?: Promise<void>;
  waiter?: PendingTurn;
  outbox: RuntimeTurn[];
  sink?: StreamSink;
  current?: RuntimeRequest;
  usage: UsageLedger;
  streamed: string;
  /** A new text block started since the last delta: separate it from the text before it. */
  textBreak?: boolean;
  blocks: ContentBlock[];
  pending: Map<string, DroidCall>;
  candidates: Map<string, DroidCall>;
  /** The main thread's assistant message being streamed: its tool_use order and whether it has ended. */
  assistantTurn?: { id: string; toolUses: Array<{ id: string; name: string }>; seen: Set<string>; stopped: boolean };
  /** Task batches waiting for their assistant message to finish streaming. */
  batchChecks: Set<() => void>;
  /** Task calls already sent to Droid with an earlier Task of the same message, before their own handler. */
  prefetched: Set<string>;
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
  initApiKeySource?: string;
  accountSnapshot?: AuthObservation;
  lastTouched: number;
  backgroundTasks: Set<string>;
  /** Backstop deadline of the HTTP request currently waiting for this session's turn. */
  watchdog?: TurnWatchdog;
  /** Set while interrupt() waits for the aborted turn to end. */
  interrupting?: boolean;
  windDown?: () => void;
  /** The user cancelled a Droid tool. Its native turn may only wind down, without
   * tools; what the user sent next is pushed as its own turn once that turn ends. */
  cancelledTurn?: { followup: ContentBlock[] };
}

/**
 * The HTTP layer enforces the idle and maximum limits and interrupts cleanly
 * first. The runtime's own deadline only guards callers that drive it without
 * that layer, so it waits long enough for an interrupt to finish.
 */
const BACKSTOP_SLACK_MS = INTERRUPT_GRACE_MS + 1_000;

type DroidResult = { tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean };

/**
 * Droid's whole result when the user picks "No, cancel" (each locale of its
 * common:toolExecution.cancelledByUser) or interrupts a tool. Droid sends it as
 * "Error: <text>" and then ends its own turn without another request.
 */
const USER_CANCELLATIONS = new Set([
  "Tool execution cancelled by user", "工具执行已被用户取消", "ツール実行がユーザーによりキャンセルされました",
  "사용자가 도구 실행을 취소했습니다", "Esecuzione dello strumento annullata dall'utente",
  "Tool execution was interrupted", "Request interrupted by user",
]);
const CANCELLED_TOOL_NOTE = "The user cancelled this tool call in Droid, so it did not run. Do not retry it or try another way. Acknowledge the cancellation in one short sentence, then end your turn.";
const CANCELLED_TURN_DENIAL = "BRIDGE_USER_CANCELLED: The user cancelled the previous tool call in Droid. Do not retry it or use any other tool now; acknowledge the cancellation and end your turn.";
/**
 * accountInfo() resolves only when Claude Code answers its initialize request,
 * so this bounds process startup. A Mission starting several workers and Task
 * subagents at once has taken over 10s. Until it answers, no prompt is sent.
 */
const SDK_START_TIMEOUT_MS = 60_000;
/** Longest a Task waits for the rest of its message before it goes to Droid alone. */
const TASK_BATCH_WAIT_MS = 30_000;

/** Claude Code had not started in time; its account was never examined. */
class SdkStartTimeout extends BridgeError {
  constructor(readonly timeoutMs: number) {
    super(503, "sdk_start_timeout", `Claude Code did not finish starting within ${timeoutMs}ms, so its account could not be verified and no prompt was sent. Retry the request.`);
  }
}

/** Official Claude Code owns the agent loop, tools, context, and compaction. */
export class SdkRuntime implements BridgeRuntime {
  readonly kind = "sdk" as const;
  private sdk?: SdkHandle;
  private selection?: UpstreamSelection;
  private selectionPromise?: Promise<UpstreamSelection | undefined>;
  private readonly lives = new Map<string, LiveSdk>();
  private readonly usageFile: string;
  private control?: RuntimeControl;
  private authVerification?: AuthVerification;

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
      overridesAnthropicEnv: this.config.authMode === "byok",
      authVerification: this.authVerification ?? null,
      upstream: this.selection ? publicSelection(this.selection) : { selected: false, authMode: this.config.authMode },
      ...(this.config.models !== undefined ? {
        modelRouting: "explicit-catalog",
        sessions: [...this.lives.entries()].map(([sessionId, live]) => ({
          sessionId, sdkSessionId: live.sdkSessionId, modelId: live.modelRoute?.id,
          nativeModel: live.modelRoute?.model, active: live.active, ended: Boolean(live.terminal),
        })),
      } : {}),
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
    if (this.config.authMode !== "byok") return undefined;
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
    // Resolve before allocating or changing a native session. A catalog typo or
    // missing explicit credential must never fall back to another model/login.
    const modelRoute = this.config.models !== undefined ? resolveRequestModel(this.config, input.request.model) : undefined;
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
      live.modelRoute = previous.modelRoute;
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
    // An approval left pending by an earlier request still pauses this one's idle limit.
    this.notifyApprovals(live);
    const requestKey = JSON.stringify({ request: input.request, role: input.role, cwd: resolveCwd(input, this.config), missionDir: input.headers["x-bridge-mission-dir"] });
    let waiting: Promise<RuntimeTurn> | undefined;
    try {
      if (requestKey === live.lastRequestKey && live.lastReply) return live.lastReply;
      let results = latestToolResults(input, live.active || live.pending.size > 0);
      // A conversation imported from history has no native callbacks to answer.
      // Its tool results are earlier history when the same message carries a new
      // user turn; the cold import below presents them as reference.
      if (results.length && !live.sdkSessionId && !live.sentUserTurns && hasNewUserContent(input)) results = [];
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
      if (modelRoute) await this.selectModel(live, modelRoute, results.length > 0);
      const context = buildHostContext(input, resolveCwd(input, this.config));
      // Droid ends its own turn when the user cancels a tool, without a request.
      // Whatever arrives with that result later is the user's next turn, never
      // context inside the tool result, where it would read as an injection.
      const followup = results.some(isUserCancellation) ? this.followupContent(input, live, context) : [];
      const continuation = results.length && !followup.length ? this.continuationContent(input, live, context) : [];
      if ((continuation.length || followup.length) && results.every((result) => live.resultFingerprints.has(result.tool_use_id))) {
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
        this.submitResults(live, results, continuation, followup);
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
      if (waiting) this.stop(live, this.sdkError(error));
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

  async interrupt(sessionId: string, reason: string): Promise<boolean> {
    const live = this.lives.get(sessionId);
    const query = live?.query;
    if (!live || live.terminal || live.interrupting || !query?.interrupt) return false;
    live.interrupting = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const woundDown = new Promise<boolean>((resolve) => {
        live.windDown = () => resolve(true);
        timer = setTimeout(() => resolve(false), INTERRUPT_GRACE_MS);
        timer.unref();
      });
      // Not awaited: the abort is acknowledged only when the turn's result arrives.
      try { void query.interrupt().catch(() => undefined); } catch { /* best effort */ }
      if (!(await woundDown)) return false;
    } finally {
      if (timer) clearTimeout(timer);
      live.interrupting = false;
      live.windDown = undefined;
    }
    // The turn stopped at a clean boundary. Retire the process but keep the
    // native checkpoint, so the next request resumes it like after a host exit.
    return (await this.endHostSession(sessionId, reason)).resumable;
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
      candidates: new Map(), handlerArrivals: new Set(), retiredCandidates: new Set(), batchChecks: new Set(), prefetched: new Set(),
      claimedHandlers: new Set(), resultFingerprints: new Map(), sentUserTurns: 0,
      hostResultConsumptions: new Map(), hostCompletionFingerprints: new Map(), approvals: new Set(),
      starting: false, queryEpoch: 0, lastTouched: Date.now(), backgroundTasks: new Set(),
    };
  }

  private async selectModel(live: LiveSdk, route: ModelRoute, hasResults: boolean): Promise<void> {
    const previous = live.modelRoute;
    if (!previous) { live.modelRoute = route; return; }
    if (previous.routeKey === route.routeKey && previous.id === route.id) return;
    if (hasResults || live.active || live.starting || live.pending.size || live.handlerArrivals.size
        || live.candidates.size || live.hostResultConsumptions.size || live.approvals.size
        || live.backgroundTasks.size || live.outbox.length) {
      throw new BridgeError(409, "model_switch_busy", "Finish the current turn, tools and background tasks before switching models.");
    }
    if (!this.config.persistSessions || !live.sdkSessionId) {
      throw new BridgeError(409, "model_switch_requires_persistence", "Switching models requires a persisted native session. Keep the current model or start a separate conversation.");
    }
    if (live.query && !live.query.close) {
      throw new BridgeError(409, "model_switch_unavailable", "The native query cannot be closed safely for model switching.");
    }

    // Model slots and BRIDGE_MODEL_ID are process environment. A setModel call
    // alone leaves native subagents and generator commands on the old model.
    // Retire the idle query, then resume its official transcript with one
    // consistent model/environment. Late callbacks retain the retired epoch.
    const query = live.query, loop = live.loop;
    live.queryEpoch++;
    live.inputs.close();
    live.abort?.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      query?.close!();
      if (loop) await Promise.race([
        loop,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Native query did not close")), Math.min(5_000, Math.max(1, this.config.requestTimeoutMs)));
        }),
      ]);
    } catch {
      const failure = new BridgeError(502, "model_switch_failed", "The old native query could not be closed safely; no new model was started.");
      this.stop(live, failure);
      throw failure;
    } finally { if (timer) clearTimeout(timer); }
    if (live.terminal) throw live.terminal;
    live.inputs = new InputQueue();
    live.query = undefined;
    live.loop = undefined;
    live.abort = undefined;
    live.modelRoute = route;
    live.lastReply = undefined;
    live.lastRequestKey = undefined;
    const change = {
      fromId: previous.id, toId: route.id, fromModel: previous.model, toModel: route.model,
      sdkSessionId: live.sdkSessionId, sessionId: live.current?.session.bridgeSessionId, strategy: "resume",
    };
    live.events.push({ at: now(), type: "sdk_model_changed", data: change });
    this.logger.info("sdk_model_changed", change);
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
    const content = trailingUserMessages(input.request.messages).flatMap((message) => buildDynamicUserContent({
      ...input, request: { ...input.request, messages: [message] },
    }, resolveCwd(input, this.config), { includeContext: false }));
    if (context !== live.lastHostContext) content.push({ type: "text", text: context });
    return content.length ? [{ type: "text", text: "Host continuation context supplied by Droid with these tool results (not an additional user turn):" }, ...content] : [];
  }

  /** The user's next turn after a cancellation, built like any new turn from all trailing user content. */
  private followupContent(input: RuntimeRequest, live: LiveSdk, context: string): ContentBlock[] {
    const blocks = trailingUserMessages(input.request.messages).flatMap((message) => asBlocks(message.content)).filter((block) => block.type !== "tool_result");
    if (!blocks.length) return [];
    return buildDynamicUserContent({ ...input, request: { ...input.request, messages: [{ role: "user", content: blocks }] } },
      resolveCwd(input, this.config), { includeContext: context !== live.lastHostContext });
  }

  private submitResults(live: LiveSdk, results: DroidResult[], continuation: ContentBlock[] = [], followup: ContentBlock[] = []): Array<"accepted" | "duplicate"> {
    if (results.some((result) => isUserCancellation(result) && !live.resultFingerprints.has(result.tool_use_id))) live.cancelledTurn = { followup };
    let attached = false;
    return results.map((result) => {
      const fresh = !live.resultFingerprints.has(result.tool_use_id);
      live.resultFingerprints.set(result.tool_use_id, resultFingerprint(result));
      live.pending.delete(result.tool_use_id);
      // validateResults already proved a repeat has the same fingerprint. What the
      // mailbox kept may carry host continuation text, so do not compare against it.
      if (!fresh) return "duplicate" as const;
      const extra: ContentBlock[] = isUserCancellation(result) ? [{ type: "text", text: CANCELLED_TOOL_NOTE }] : [];
      if (!attached && continuation.length) {
        extra.push(...continuation);
        attached = true;
      }
      return live.mailbox.submitResult(extra.length ? { ...result, content: [...asBlocks(result.content), ...extra] } : result);
    });
  }

  private async updateCatalog(live: LiveSdk, input: RuntimeRequest): Promise<void> {
    if (!live.catalog) throw new BridgeError(503, "dynamic_tools_unavailable", "The live SDK session has no mutable Droid MCP catalog");
    if (await live.catalog.update(selectDroidMcpTools(input.request.tools, this.config.desktopProfile))) {
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
    const route = live.modelRoute;
    const selection = route ? route.selection : await this.ensureSelection();
    if (selection) this.selection = selection;
    if (live.terminal) throw live.terminal;
    const droidTools = input.request.tools !== undefined ? selectDroidMcpTools(input.request.tools, this.config.desktopProfile) : live.catalog?.definitions() ?? [];
    const names = live.names ?? new StableDroidToolNames();
    live.names = names;
    live.policyKey = queryPolicy(input, this.config);
    const epoch = live.queryEpoch;
    const server = sdk.createSdkMcpServer({ name: "droid", version: "0.1.0", tools: [], alwaysLoad: true });
    const catalog = new DroidMcpCatalog(server, async (original, args, extra, mcpName) => {
        if (live.queryEpoch !== epoch) throw new BridgeError(409, "stale_native_query", "This native query has been retired.");
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
          // Sent to Droid with an earlier Task of its message; Droid already ran it alongside.
          const prefetched = live.prefetched.delete(call.id);
          if (!prefetched) {
            live.mailbox.registerCall({ callId: call.id, originalName: original, mcpName: mcpName ?? names.toMcp(original), input: call.input });
            live.pending.set(call.id, call);
          }
          let consumed!: () => void;
          live.hostResultConsumptions.set(call.id, { promise: new Promise<void>((resolve) => { consumed = resolve; }), resolve: () => consumed() });
          const batch = !prefetched && original === "Task" ? await this.taskBatch(live, call) : [];
          if (live.terminal) throw live.terminal;
          const waiting = live.mailbox.wait(call.id, this.config.toolWaitMs);
          if (!prefetched) {
            for (const sibling of batch) {
              live.mailbox.registerCall({ callId: sibling.id, originalName: sibling.name, mcpName: sibling.mcpName ?? names.toMcp(sibling.name), input: sibling.input });
              live.pending.set(sibling.id, sibling);
              live.prefetched.add(sibling.id);
            }
            if (batch.length) live.events.push({ at: now(), type: "task_batch", data: { toolUseIds: [call.id, ...batch.map((sibling) => sibling.id)] } });
            this.publish(live, this.makeTurn(live, [call, ...batch].map((item) => ({ type: "tool_use", id: item.id, name: item.name, input: item.input as Json })), "tool_use"));
          }
          const result = await waiting;
          const response = { content: mcpContent(result.content), isError: Boolean(result.isError) };
          live.hostResultConsumptions.get(call.id)?.resolve();
          live.hostResultConsumptions.delete(call.id);
          return response;
        } catch (error) {
          if (live.queryEpoch === epoch) this.stop(live, this.sdkError(error));
          throw error;
        }
      }, names);
    live.catalog = catalog;
    await catalog.update(droidTools);
    if (live.terminal) throw live.terminal;
    const env = this.config.authMode === "claude-config"
      ? buildChildEnv("claude-config", process.env, undefined, { bridgeListen: `${this.config.host}:${this.config.port}`, claudeConfig: this.config.claudeConfig })
      : sdkEnv(selection, `${this.config.host}:${this.config.port}`, this.config.authMode);
    // Project skills may run the local generator through native Bash. Bind its
    // client connection to this Bridge, not stale values in the parent shell.
    // These values stay in the process environment, never the model prompt.
    const clientHost = this.config.host === "0.0.0.0" ? "127.0.0.1" : this.config.host === "::" ? "[::1]" : this.config.host;
    env.BRIDGE_CLIENT_TOKEN = this.config.clientToken;
    if (route) env.BRIDGE_MODEL_ID = route.id;
    else delete env.BRIDGE_MODEL_ID;
    env.BRIDGE_CONTROL_URL = `http://${clientHost.includes(":") && !clientHost.startsWith("[") ? `[${clientHost}]` : clientHost}:${this.config.port}`;
    // The native worker receives its provider credential, never the host
    // controller's authority or Factory lifecycle generation.
    for (const name of ["BRIDGE_ADMIN_TOKEN", "BRIDGE_FACTORY_BINDING", "BRIDGE_FACTORY_LAUNCH_ID", "BRIDGE_LAUNCH_ID"]) delete env[name];
    // Subscription, anthropic-api and inherit need the user's own Claude config/login.
    // BYOK and cloud get an empty config dir so user settings cannot reroute them.
    if (this.config.authMode === "byok" || this.config.authMode === "cloud") {
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
      env, permissionMode: this.config.desktopProfile || this.config.permissionMode === "ask" ? "default" : "bypassPermissions",
      allowDangerouslySkipPermissions: !this.config.desktopProfile && this.config.permissionMode !== "ask", abortController: abort,
      systemPrompt: buildPresetSystemPrompt(this.config.desktopProfile),
      canUseTool: async (name: string, toolInput: Record<string, unknown>, context?: NativePermissionContext) => live.queryEpoch === epoch
        ? this.canUseTool(live, name, toolInput, context)
        : { behavior: "deny", message: "This native query has been retired." },
    };
    if (this.config.desktopProfile) options.disallowedTools = [...DESKTOP_DISALLOWED_TOOLS];
    // Empty setting sources keep settings.json env blocks and permissions.allow
    // from bypassing this bridge. inherit keeps the CLI default (all sources).
    if (this.config.desktopProfile || this.config.authMode !== "inherit") {
      options.settingSources = [];
      options.strictMcpConfig = true;
    }
    if (this.config.authMode === "claude-config" && this.config.claudeConfig?.helper) options.settings = { apiKeyHelper: this.config.claudeConfig.helper };
    if (this.config.authMode === "anthropic-api") {
      const helper = process.env.BRIDGE_API_KEY_HELPER?.trim();
      if (helper) {
        if (!isAbsolute(helper)) throw new BridgeError(400, "invalid_api_key_helper", "BRIDGE_API_KEY_HELPER must be an absolute path.");
        // SDK 0.3.300 loads this object as the --settings flag layer, above filesystem settings.
        options.settings = { apiKeyHelper: helper };
      }
    }
    // The host can change its tool capability between turns without rebuilding
    // native history. Check at invocation, including under native bypass mode.
    options.hooks = { PreToolUse: [{ hooks: [async (hook: { tool_name?: string; tool_use_id?: string }) => {
        if (live.queryEpoch !== epoch) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "This native query has been retired." } };
        if (live.terminal) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "The host session has ended." } };
        // Droid already ran a batched Task; its handler must return what Droid reported.
        const prefetched = hook.tool_use_id !== undefined && live.prefetched.has(hook.tool_use_id);
        if (live.cancelledTurn && !prefetched) {
          live.events.push({ at: now(), type: "cancelled_turn_tool_denied", data: { toolName: hook.tool_name, toolUseId: hook.tool_use_id } });
          return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: CANCELLED_TURN_DENIAL } };
        }
        if (this.config.desktopProfile && hook.tool_name && !hook.tool_name.startsWith("mcp__droid__") && !["Read", "Glob", "Grep", "LS"].includes(hook.tool_name)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DESKTOP_APPROVAL_DENIAL } };
        const denial = prefetched ? undefined : toolAccessDenial(live, hook.tool_name, this.control?.factoryPermissionMode?.(input.session.bridgeSessionId));
        if (!denial) return {};
        const data = { sessionId: input.session.bridgeSessionId, sdkSessionId: live.sdkSessionId, toolName: hook.tool_name, toolUseId: hook.tool_use_id, reason: denial };
        live.events.push({ at: now(), type: "host_tool_access_denied", data });
        this.logger.info("host_tool_access_denied", data);
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denial } };
      }] }] };
    if (route?.model) options.model = route.model;
    else if (selection) options.model = selection.provider.model;
    else if (process.env.ANTHROPIC_MODEL) options.model = process.env.ANTHROPIC_MODEL;
    if (this.config.claudeExecutable) options.pathToClaudeCodeExecutable = this.config.claudeExecutable;
    if (live.sdkSessionId) options.resume = live.sdkSessionId;
    const expectedResumeId = route ? live.sdkSessionId : undefined;
    live.events.push({ at: now(), type: "sdk_query_start", data: { resumed: Boolean(live.sdkSessionId), sdkSessionId: live.sdkSessionId, droidMcp: catalog.definitions().map((tool) => tool.name) } });
    try {
      live.query = sdk.query({ prompt: live.inputs, options });
      // Iterate the Query itself. Its close() owns process shutdown; never call raw generator.return().
      live.loop = this.consume(live, live.query, live.queryEpoch, expectedResumeId);
      // Gate before this method returns, so handle() has not pushed a user message yet.
      await this.verifyDeclaredAuth(live, input.session.bridgeSessionId);
    } catch (error) {
      this.stop(live, this.sdkError(error));
      throw this.sdkError(error);
    }
  }

  private async verifyDeclaredAuth(live: LiveSdk, sessionId: string): Promise<void> {
    const mode = this.config.authMode;
    if (mode === "inherit") {
      void this.observeInheritAuth(live);
      return;
    }
    if (mode !== "subscription" && mode !== "anthropic-api" && mode !== "claude-config") return;
    const query = live.query;
    if (!query?.accountInfo) {
      this.rejectAuth(live, mode, "unknown", `Declared BRIDGE_AUTH=${mode} but the SDK query does not expose accountInfo(). Refusing to send a prompt.`);
      return;
    }
    const timeoutMs = Math.min(SDK_START_TIMEOUT_MS, Math.max(1, this.config.requestTimeoutMs));
    const started = Date.now();
    let info: Record<string, unknown>;
    try {
      info = await withTimeout(query.accountInfo(), timeoutMs);
    } catch (error) {
      if (error instanceof SdkStartTimeout) {
        // Not an authentication result: keep the last real verification.
        this.logger.warn("sdk_start_timeout", { mode, timeoutMs, sessionId });
        this.stop(live, error);
        throw error;
      }
      const detail = error instanceof Error ? error.message : "accountInfo failed";
      const safe = mode === "claude-config" || /sk-ant-|Bearer /i.test(detail) ? "accountInfo failed or timed out" : detail;
      this.rejectAuth(live, mode, "unknown", `Declared BRIDGE_AUTH=${mode} but account verification did not succeed: ${safe}`);
      return;
    }
    const observed = observationFrom(info);
    live.accountSnapshot = observed;
    const email = maskEmail(stringField(info, "email"));
    const classification = classifyAuth(observed, live.initApiKeySource);
    this.rememberAuth(mode, classification, observed, email, Date.now() - started);
    if (mode === "claude-config") {
      if ((!this.config.claudeConfig || claudeConfigNeedsLogin(this.config.claudeConfig)) && classification.kind === "unknown") this.rejectAuth(live, mode, "unknown", CLAUDE_LOGIN_REQUIRED);
      return;
    }
    if (classification.kind !== mode) {
      const error = new BridgeError(401, "auth_mode_mismatch", mismatchMessage(mode, classification, observed));
      this.stop(live, error);
      throw error;
    }
  }

  private observeInheritAuth(live: LiveSdk): void {
    const query = live.query;
    if (!query?.accountInfo) return;
    const timeoutMs = Math.min(SDK_START_TIMEOUT_MS, Math.max(1, this.config.requestTimeoutMs));
    void withTimeout(query.accountInfo(), timeoutMs).then((info) => {
      if (live.terminal) return;
      const observed = observationFrom(info);
      live.accountSnapshot = observed;
      const classification = classifyAuth(observed, live.initApiKeySource);
      this.rememberAuth("inherit", classification, observed, maskEmail(stringField(info, "email")));
    }).catch(() => undefined);
  }

  private rememberAuth(mode: BridgeConfig["authMode"], classification: AuthClassification, observed: AuthObservation, email?: string, startupMs?: number): void {
    const record: AuthVerification = {
      mode, kind: classification.kind, reason: classification.reason,
      subscriptionType: observed.subscriptionType, apiKeySource: observed.apiKeySource, tokenSource: observed.tokenSource,
      email, at: now(),
    };
    this.authVerification = record;
    const gated = mode === "subscription" || mode === "anthropic-api";
    const ok = mode === "claude-config" ? Boolean(this.config.claudeConfig && !claudeConfigNeedsLogin(this.config.claudeConfig)) || classification.kind !== "unknown" : gated ? classification.kind === mode : true;
    this.logger.info("auth_verified", { ...record, ok, ...startupMs !== undefined && { startupMs } });
  }

  private rejectAuth(live: LiveSdk, mode: BridgeConfig["authMode"], kind: AuthClassification["kind"], message: string): never {
    const error = new BridgeError(401, "auth_mode_mismatch", message);
    this.authVerification = { mode, kind, at: now(), reason: message };
    this.logger.info("auth_verified", { mode, kind, ok: false, at: this.authVerification.at });
    this.stop(live, error);
    throw error;
  }

  private recheckInitAuth(live: LiveSdk): void {
    const mode = this.config.authMode;
    if (!live.accountSnapshot || (mode !== "subscription" && mode !== "anthropic-api" && mode !== "inherit")) return;
    const classification = classifyAuth(live.accountSnapshot, live.initApiKeySource);
    const email = this.authVerification?.email;
    this.rememberAuth(mode, classification, live.accountSnapshot, email);
    if ((mode === "subscription" || mode === "anthropic-api") && classification.kind !== mode) {
      this.stop(live, new BridgeError(401, "auth_mode_mismatch", mismatchMessage(mode, classification, live.accountSnapshot)));
    }
  }

  private async canUseTool(live: LiveSdk, name: string, input: Record<string, unknown>, context: NativePermissionContext = {}): Promise<RuntimePermissionDecision> {
    if (this.config.desktopProfile) return { behavior: "deny", message: ["Read", "Glob", "Grep", "LS"].includes(name) ? DESKTOP_READ_DENIAL : DESKTOP_APPROVAL_DENIAL };
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
    this.notifyApprovals(live);
    const cancel = () => approval.abort();
    context.signal?.addEventListener("abort", cancel, { once: true });
    if (context.signal?.aborted) approval.abort();
    // Approvals wait on a human, not on the model: they have their own limit.
    const timer = setTimeout(cancel, this.config.approvalTimeoutMs);
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
      this.notifyApprovals(live);
      approval.abort();
    }
  }

  /** Report how many approvals are pending, so the idle limit can pause while a human decides. */
  private notifyApprovals(live: LiveSdk): void {
    const pending = live.approvals.size;
    live.watchdog?.setPaused(pending > 0);
    live.sink?.approvalsPending?.(pending);
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

  /**
   * Claude Code runs Droid's MCP tools one after another, since none is read-only.
   * Its own Agent tool starts subagents together, and Droid runs the Task calls
   * of one response concurrently. So when a Task is invoked, wait for its message
   * to finish streaming, then hand Droid the Task calls that follow it there
   * without another tool between them. Each still reaches Claude Code through its
   * own handler, in order, and gets the result Droid returned for it. A call this
   * session would refuse, or whose input its handler would reject, ends the batch.
   */
  private taskBatch(live: LiveSdk, first: DroidCall): Promise<DroidCall[]> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (batch: DroidCall[]): void => {
        if (timer) clearTimeout(timer);
        live.batchChecks.delete(check);
        resolve(batch);
      };
      const check = (): void => {
        const turn = live.assistantTurn;
        if (live.terminal || !first.messageId || turn?.id !== first.messageId) return finish([]);
        if (!turn.stopped) return;
        const index = turn.toolUses.findIndex((item) => item.id === first.id);
        if (index < 0) return finish([]);
        const batch: DroidCall[] = [];
        for (const use of turn.toolUses.slice(index + 1)) {
          if (!isDroidMcpName(use.name) || live.names?.toOriginal(use.name.replace(/^mcp__droid__/, "")) !== "Task") break;
          // Each block also arrives as its own assistant message; wait for this one's input.
          if (!turn.seen.has(use.id)) return;
          const call = live.candidates.get(use.id);
          if (!call || !this.mayPrefetch(live, call)) break;
          batch.push(call);
        }
        finish(batch);
      };
      timer = setTimeout(() => finish([]), TASK_BATCH_WAIT_MS);
      live.batchChecks.add(check);
      check();
    });
  }

  private mayPrefetch(live: LiveSdk, call: DroidCall): boolean {
    return !live.cancelledTurn && !live.claimedHandlers.has(call.id) && !live.mailbox.hasCall(call.id)
      && Boolean(live.catalog?.accepts(call.name, call.input))
      && !toolAccessDenial(live, `mcp__droid__${call.mcpName}`, this.control?.factoryPermissionMode?.(live.current?.session.bridgeSessionId ?? ""));
  }

  private trackAssistantTurn(live: LiveSdk, message: Record<string, unknown>): void {
    const event = message.event as { type?: string; message?: { id?: unknown }; content_block?: { type?: string; id?: unknown; name?: unknown } } | undefined;
    if (event?.type === "message_start") {
      live.assistantTurn = typeof event.message?.id === "string" ? { id: event.message.id, toolUses: [], seen: new Set(), stopped: false } : undefined;
    } else if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
      const { id, name } = event.content_block;
      if (live.assistantTurn && typeof id === "string" && typeof name === "string") live.assistantTurn.toolUses.push({ id, name });
    } else if (event?.type === "message_stop" && live.assistantTurn) {
      live.assistantTurn.stopped = true;
      this.settleBatches(live);
    }
  }

  private settleBatches(live: LiveSdk): void {
    for (const check of [...live.batchChecks]) check();
  }

  private retireNativeToolResults(live: LiveSdk, message: Record<string, unknown>): void {
    const body = message.message as { content?: unknown } | undefined;
    if (!Array.isArray(body?.content)) return;
    for (const block of body.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const id = block.tool_use_id;
      live.candidates.delete(id);
      live.retiredCandidates.add(id);
      if (live.prefetched.delete(id)) live.events.push({ at: now(), type: "task_batch_unclaimed", data: { toolUseId: id } });
      for (const arrival of [...live.handlerArrivals]) {
        if (arrival.callId === id) arrival.reject(new BridgeError(409, "sdk_tool_rejected", "The native SDK rejected this tool invocation before handoff"));
      }
      if (live.pending.has(id)) throw new BridgeError(502, "sdk_tool_interrupted", "The native SDK completed a Droid tool before its external result arrived; do not replay it");
    }
  }

  private async consume(live: LiveSdk, iterator: AsyncIterable<Record<string, unknown>>, epoch: number, expectedResumeId?: string): Promise<void> {
    try {
      // Official Query.next()/return() manage its process; its raw iterator's
      // return() can remain parked waiting for another streaming-input turn.
      const query = iterator as AsyncIterable<Record<string, unknown>> & Partial<AsyncIterator<Record<string, unknown>>>;
      const source = typeof query.next === "function"
        ? { [Symbol.asyncIterator]: () => query as AsyncIterator<Record<string, unknown>> }
        : iterator;
      for await (const message of source) {
        if (live.terminal || live.queryEpoch !== epoch) return;
        live.watchdog?.touch();
        live.sink?.activity?.();
        if (message.type === "system" && message.subtype === "init" && typeof message.apiKeySource === "string" && !live.initApiKeySource) {
          live.initApiKeySource = message.apiKeySource;
          this.recheckInitAuth(live);
          if (live.terminal) return;
        }
        if (typeof message.session_id === "string") {
          if (expectedResumeId && !message.parent_tool_use_id && message.session_id !== expectedResumeId) {
            throw new BridgeError(502, "sdk_resume_identity_changed", "The SDK did not resume the requested native session; refusing to continue without its history.");
          }
          if (!expectedResumeId || !message.parent_tool_use_id) live.sdkSessionId = message.session_id;
        }
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
          this.trackAssistantTurn(live, message);
          // Separate text blocks (before and after a tool call, say) would otherwise
          // run together in the one text stream. Deltas of one block stay joined.
          if (startsTextBlock(message) && live.streamed) live.textBreak = true;
          const text = streamTextDelta(message);
          if (text) {
            const chunk = live.textBreak ? `\n\n${text}` : text;
            live.textBreak = false;
            live.streamed += chunk;
            live.sink?.textDelta(chunk);
          }
          continue;
        }
        if (message.type === "user") this.retireNativeToolResults(live, message);
        if (message.type === "assistant") {
          const uses = extractToolUses(message);
          const streaming = live.assistantTurn;
          if (!message.parent_tool_use_id && streaming && streaming.id === messageIdOf(message)) for (const use of uses) streaming.seen.add(use.id);
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
                const call = { ...use, name: original, mcpName: bare, messageId: messageIdOf(message) };
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
          this.settleBatches(live);
        }
        if (message.type === "result") {
          if (message.parent_tool_use_id) continue;
          if (live.interrupting) {
            // The aborted turn has ended, whatever subtype it reports. What it left
            // unmatched is moot: interrupt() now retires this process.
            for (const id of live.candidates.keys()) live.retiredCandidates.add(id);
            live.candidates.clear();
            live.cancelledTurn = undefined;
            live.windDown?.();
            continue;
          }
          if (message.is_error === true || (typeof message.subtype === "string" && message.subtype !== "success")) {
            const errors = Array.isArray(message.errors) ? message.errors.filter((item): item is string => typeof item === "string").join("; ") : "";
            throw new BridgeError(502, "sdk_execution_error", errors || extractText(message) || String(message.subtype ?? "SDK execution failed"));
          }
          if (!live.active) continue;
          if (live.pending.size || live.handlerArrivals.size) throw new BridgeError(502, "sdk_unfinished_tools", "SDK ended a turn while Droid tools were unresolved");
          for (const id of live.candidates.keys()) live.retiredCandidates.add(id);
          live.candidates.clear();
          for (const id of live.prefetched) live.events.push({ at: now(), type: "task_batch_unclaimed", data: { toolUseId: id } });
          live.prefetched.clear();
          const fallback = extractText(message);
          if (!live.streamed && !live.blocks.length && fallback) live.blocks.push({ type: "text", text: fallback });
          const cancelled = live.cancelledTurn;
          live.cancelledTurn = undefined;
          if (cancelled?.followup.length) {
            // The cancelled turn has wound down. The user's next message is a real
            // user turn whose reply continues this same HTTP response.
            live.sentUserTurns++;
            live.inputs.push({
              type: "user", message: { role: "user", content: cancelled.followup },
              parent_tool_use_id: null, session_id: live.sdkSessionId ?? "", uuid: randomUUID(),
            });
            live.events.push({ at: now(), type: "cancelled_turn_followup", data: { sdkSessionId: live.sdkSessionId } });
            continue;
          }
          live.active = false;
          this.publish(live, this.makeTurn(live, [], "end_turn"));
        }
      }
      if (!live.terminal && live.queryEpoch === epoch) {
        // Streaming mode must remain alive between turns; an unexpected EOF is not a successful reply.
        this.stop(live, new BridgeError(502, "sdk_stream_closed", "The Claude Code session ended unexpectedly; resume it in a new bridge process or start a new session"));
      }
    } catch (error) {
      if (!live.terminal && live.queryEpoch === epoch) this.stop(live, this.sdkError(error));
    }
  }

  private noteUsage(live: LiveSdk, message: Record<string, unknown>): void {
    const event = live.usage.ingest(message);
    if (!event) return;
    const data = { ...event, sessionId: live.current?.session.bridgeSessionId, sdkSessionId: live.sdkSessionId };
    mkdirSync(this.config.logDir, { recursive: true });
    appendLogLine(this.usageFile, JSON.stringify({ at: now(), ...data }));
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
    live.textBreak = false;
    return turn;
  }

  private publish(live: LiveSdk, turn: RuntimeTurn): void {
    if (live.terminal) return;
    if (live.waiter) live.waiter.resolve(turn);
    else live.outbox.push(turn);
  }

  private waitForTurn(live: LiveSdk): Promise<RuntimeTurn> {
    return new Promise((resolve, reject) => {
      const watchdog = new TurnWatchdog({
        idleMs: this.config.requestTimeoutMs + BACKSTOP_SLACK_MS,
        maxMs: this.config.turnMaxMs + BACKSTOP_SLACK_MS,
        onTimeout: (kind) => this.stop(live, new BridgeError(504, "sdk_turn_timeout",
          kind === "idle" ? "SDK turn made no progress and was cancelled" : "SDK turn exceeded its maximum duration and was cancelled")),
      });
      live.watchdog = watchdog;
      const finish = (): void => {
        watchdog.dispose();
        if (live.watchdog === watchdog) live.watchdog = undefined;
        live.waiter = undefined;
      };
      live.waiter = {
        resolve: (turn) => { finish(); resolve(turn); },
        reject: (error) => { finish(); reject(error); },
      };
      watchdog.setPaused(live.approvals.size > 0);
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

  private sdkError(error: unknown): BridgeError {
    const converted = asBridgeError(error);
    const message = redactClaudeConfigText(this.config.claudeConfig, converted.message);
    return message === converted.message ? converted : new BridgeError(converted.status, converted.code, message);
  }

  private stop(live: LiveSdk, error: BridgeError): void {
    if (live.terminal) return;
    error = this.sdkError(error);
    live.terminal = error;
    live.active = false;
    live.cancelledTurn = undefined;
    live.inputs.close();
    for (const approval of live.approvals) approval.abort();
    live.approvals.clear();
    live.mailbox.cancel(error.message);
    for (const consumption of live.hostResultConsumptions.values()) consumption.resolve();
    live.hostResultConsumptions.clear();
    for (const arrival of [...live.handlerArrivals]) arrival.reject(error);
    live.candidates.clear();
    live.prefetched.clear();
    this.settleBatches(live);
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

function latestToolResults(input: RuntimeRequest, includeTrailingUserMessages = false): DroidResult[] {
  const latest = input.request.messages.at(-1);
  if (!latest || latest.role !== "user") throw new BridgeError(400, "invalid_turn", "A new turn must end with a user message");
  const messages = includeTrailingUserMessages ? trailingUserMessages(input.request.messages) : [latest];
  return messages.flatMap((message) => asBlocks(message.content)).filter((block) => block.type === "tool_result").map((block) => {
    const result = block as { tool_use_id?: string; content?: string | ContentBlock[]; is_error?: boolean };
    return {
    tool_use_id: String(result.tool_use_id ?? ""), content: result.content ?? "", is_error: Boolean(result.is_error),
    };
  });
}

function isUserCancellation(result: DroidResult): boolean {
  if (!result.is_error) return false;
  const text = typeof result.content === "string" ? result.content
    : result.content.map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "\u0000").join("");
  // Droid's session file stores the bare text; only its API request adds the prefix.
  return USER_CANCELLATIONS.has(text.trim().replace(/^Error:\s*/, ""));
}

function hasNewUserContent(input: RuntimeRequest): boolean {
  const latest = input.request.messages.at(-1);
  return latest?.role === "user" && asBlocks(latest.content).some((block) => block.type !== "tool_result");
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
  return JSON.stringify({ ...(config.models === undefined ? { model: input.request.model } : {}), role: input.role, cwd: resolveCwd(input, config), permission: config.permissionMode });
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
  return resolveRequestCwd(input.headers, input.request, config);
}
function extractToolUses(message: Record<string, unknown>): DroidCall[] {
  const content = (message.message as { content?: unknown[] } | undefined)?.content ?? [];
  return content.filter((raw): raw is DroidCall & { type: string } => Boolean(raw && typeof raw === "object" && (raw as { type?: string }).type === "tool_use")).map((use) => ({ id: use.id, name: use.name, input: use.input ?? {} }));
}
function extractText(message: Record<string, unknown>): string {
  if (typeof message.result === "string") return message.result;
  const content = (message.message as { content?: ContentBlock[] } | undefined)?.content ?? [];
  return content.filter((block) => block.type === "text").map((block) => (block as { text?: string }).text ?? "").join("\n\n");
}
function messageIdOf(message: Record<string, unknown>): string | undefined {
  const id = (message.message as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}
function startsTextBlock(message: Record<string, unknown>): boolean {
  const event = message.event as { type?: string; content_block?: { type?: string } } | undefined;
  return event?.type === "content_block_start" && event.content_block?.type === "text";
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
interface AuthVerification {
  mode: BridgeConfig["authMode"];
  kind: AuthClassification["kind"];
  reason?: string;
  subscriptionType?: string;
  apiKeySource?: string;
  tokenSource?: string;
  /** Masked. Never the raw address. */
  email?: string;
  at: string;
}

function observationFrom(info: Record<string, unknown>): AuthObservation {
  return {
    subscriptionType: stringField(info, "subscriptionType"),
    apiKeySource: stringField(info, "apiKeySource"),
    tokenSource: stringField(info, "tokenSource"),
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function mismatchMessage(mode: string, classification: AuthClassification, observed: AuthObservation): string {
  return `Declared BRIDGE_AUTH=${mode} but Claude Code reported ${classification.kind} (${classification.reason}). `
    + `subscriptionType=${observed.subscriptionType ?? "unset"} apiKeySource=${observed.apiKeySource ?? "unset"} `
    + `tokenSource=${observed.tokenSource ?? "unset"}.`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SdkStartTimeout(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function now(): string { return new Date().toISOString(); }
