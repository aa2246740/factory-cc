import { resolveRequestCwd } from "../workspace.js";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../config.js";
import { appendLogLine, type Logger } from "../logging.js";
import { parseMessagesRequest } from "../protocol/validate.js";
import { apiError } from "../protocol/messages.js";
import { explicitSessionId, historyMessageHashes, historyPrefixHash, resolveSession, roleFromHeaders, sessionContextHash } from "../sessions/correlate.js";
import { droidReasoningLevel } from "../runtime/reasoning.js";
import { isEnded } from "../sessions/state.js";
import { HUMAN_WAIT_TOOLS, MISSION_SPAWN_TOOLS, MISSION_WORKER_END_TOOL } from "../runtime/mission-tools.js";
import { compactedSummaryText, lastSummarizedToolCall, sameToolInput, summaryQuote } from "../sessions/compaction.js";
import { hostAllowsAnyTools } from "../runtime/native-tool-policy.js";
import { DEFAULT_SESSION_RETENTION, SessionStore } from "../sessions/store.js";
import { createRuntime } from "../runtime/factory.js";
import type { BridgeRuntime, RuntimeTurn, StreamSink } from "../runtime/types.js";
import { TurnWatchdog, type TurnTimeout } from "../runtime/turn-watchdog.js";
import { header, requireAdminOrHookToken, requireAdminToken, requireClientToken } from "../security/auth.js";
import { assertBodySize } from "../security/limits.js";
import { redactHeaders, redactJson } from "../security/redact.js";
import { BridgeError, type MessagesRequest, type RedactedRequestRecord } from "../types.js";
import { SseWriter } from "./sse-stream.js";
import { statusPageHtml } from "./status-page.js";
import { messageId } from "../protocol/messages.js";
import { ControlBroker } from "../control/broker.js";
import { controlPageHtml, controlPageHeaders } from "./control-page.js";
import { configuredModels, providerFromModelId, resolveRequestModel, type ModelProvider } from "../models.js";

export interface BridgeApp {
  server: Server;
  store: SessionStore;
  records: RedactedRequestRecord[];
  readonly authFailureCount: number;
  url: string;
  runtimeStatus(): Record<string, unknown>;
  close(): Promise<void>;
}

const RECORD_LIMIT = 500;

function formatListenHost(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `[${bare}]` : bare;
}

function listenUrl(host: string, port: number): string {
  return `http://${formatListenHost(host)}:${port}`;
}

export function createBridgeApp(config: BridgeConfig, logger: Logger, canaryPath: string, runtime: BridgeRuntime = createRuntime(config, logger, canaryPath)): BridgeApp {
  const store = new SessionStore(join(config.dataDir, "sessions"), config.persistSessions, config.maxSessions, logger, {
    ...DEFAULT_SESSION_RETENTION, maxRecords: config.sessionMaxRecords ?? 1000, maxAgeMs: config.sessionRetentionMs ?? DEFAULT_SESSION_RETENTION.maxAgeMs,
  });
  // Approvals wait on a person, so they get their own limit rather than the turn's idle limit.
  const control = new ControlBroker(runtime, store, config.approvalTimeoutMs);
  runtime.setControl?.(control);
  const records: RedactedRequestRecord[] = [];
  let authFailureCount = 0;
  let indexTimer: ReturnType<typeof setTimeout> | undefined;
  let indexDirty = false;
  mkdirSync(config.logDir, { recursive: true });
  const requestLog = join(config.logDir, "requests.jsonl");
  const turnLog = join(config.logDir, "turns.jsonl");
  const activeRequests = new Map<string, symbol>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let maintenanceRunning: Promise<void> | undefined;
  const maintenance = setInterval(() => {
    if (maintenanceRunning || closing) return;
    maintenanceRunning = (async () => {
      const protectedIds = new Set(store.list().filter((session) => activeRequests.has(session.bridgeSessionId)
        || control.hasLiveHost(session.bridgeSessionId) || control.hasApprovals(session.bridgeSessionId)
        || runtime.pendingHostCalls?.(session.bridgeSessionId).length).map((session) => session.bridgeSessionId));
      for (const id of runtime.protectedSessionIds?.() ?? []) protectedIds.add(id);
      const previous = new Map(store.list().map((session) => [session.bridgeSessionId, session]));
      const removed = store.prune(protectedIds);
      for (const id of removed) {
        const session = previous.get(id)!;
        // Native checkpoints can be referenced by another retained bridge record.
        const shared = store.list().some((other) => other.sdkSessionId === session.sdkSessionId && other.provider === session.provider);
        await runtime.forget?.({ ...session, sdkSessionId: shared ? undefined : session.sdkSessionId });
      }
      control.prune();
      if (removed.length) logger.info("sessions_pruned", { count: removed.length });
    })().catch(() => logger.error("session_maintenance_failed")).finally(() => { maintenanceRunning = undefined; });
  }, 60_000);
  maintenance.unref();

  /**
   * Run a step that takes a session slot. At the limit, free one slot first by
   * retiring a parked session whose Droid has evidently left, instead of
   * refusing. The store throws before it changes anything, so retrying is safe.
   */
  function withSlot<T>(admit: () => T): T {
    try {
      return admit();
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "session_limit" || !reclaimParkedSession()) throw error;
      return admit();
    }
  }

  /**
   * Nothing is stopped while slots are free: a parked session may just be waiting
   * for a long tool or for Mission workers. Only when a slot is needed is the
   * least recently active session that qualifies given up. It qualifies if it is
   * parked on Droid tools with no request attached; its last store update (when it
   * parked, or when it last received a result) is at least toolWaitTimeoutMs old;
   * it is not bound to a live Factory host, whose own end event releases it; and
   * it is not waiting on a Mission spawn tool, whose workers can run for hours, or
   * on AskUser, whose answer comes from a person.
   */
  function reclaimParkedSession(): boolean {
    const now = Date.now();
    let oldest: { sessionId: string; idleMs: number } | undefined;
    for (const session of store.list()) {
      const sessionId = session.bridgeSessionId;
      if (session.state !== "WAITING_DROID_TOOL" || activeRequests.has(sessionId)) continue;
      const idleMs = now - Date.parse(session.updatedAt);
      if (!(idleMs >= config.toolWaitTimeoutMs) || control.hasLiveHost(sessionId)) continue;
      // A runtime that cannot say what the session waits on gets the benefit of the doubt.
      const calls = runtime.pendingHostCalls?.(sessionId);
      if (!calls || calls.some((call) => ([...MISSION_SPAWN_TOOLS, ...HUMAN_WAIT_TOOLS] as readonly string[]).includes(call.toolName))) continue;
      if (!oldest || idleMs > oldest.idleMs) oldest = { sessionId, idleMs };
    }
    if (!oldest) return false;
    const { sessionId, idleMs } = oldest;
    control.cancelApprovals(sessionId);
    // Marked interrupted, so its late tool_result gets the clear 409 and is never replayed.
    store.interrupt(sessionId, "session-reclaimed");
    void runtime.cancel(sessionId, "session-reclaimed").catch(() => {
      logger.error("runtime_cancel_failed", { sessionId, reason: "session-reclaimed" });
    });
    logger.info("session_reclaimed", { sessionId, idleMs });
    return true;
  }

  /**
   * Droid ends a Mission worker as soon as its EndFeatureRun succeeds, records
   * the call as cancelled and never returns it, so that worker's native process
   * would wait for a result forever. An EndFeatureRun that fails comes back
   * within seconds and the worker carries on, which clears this timer. Only a
   * session waiting on nothing but EndFeatureRun, with no request attached, no
   * approval outstanding and no live Factory host (whose end event releases it),
   * is released. Its late result then gets the 409 of any interrupted session.
   */
  const workerEndTimers = new Map<string, { generation: number; timer: ReturnType<typeof setTimeout> }>();
  let workerEndGeneration = 0;
  function clearWorkerEnd(sessionId: string): void {
    const armed = workerEndTimers.get(sessionId);
    if (armed) clearTimeout(armed.timer);
    workerEndTimers.delete(sessionId);
  }
  function scheduleWorkerEnd(sessionId: string, pendingToolIds: string[]): void {
    clearWorkerEnd(sessionId);
    const calls = runtime.pendingHostCalls?.(sessionId);
    if (!calls?.length || !calls.every((call) => call.toolName === MISSION_WORKER_END_TOOL)) return;
    const generation = ++workerEndGeneration;
    const timer = setTimeout(() => {
      // A later turn replaced this timer: never act on an earlier generation.
      if (workerEndTimers.get(sessionId)?.generation !== generation) return;
      workerEndTimers.delete(sessionId);
      const session = store.get(sessionId);
      if (closing || !session || session.state !== "WAITING_DROID_TOOL" || activeRequests.has(sessionId)) return;
      if (session.pendingToolIds.join("\n") !== pendingToolIds.join("\n") || control.hasLiveHost(sessionId) || control.hasApprovals(sessionId)) return;
      const waiting = runtime.pendingHostCalls?.(sessionId);
      if (!waiting?.length || !waiting.every((call) => call.toolName === MISSION_WORKER_END_TOOL)) return;
      store.interrupt(sessionId, "mission-worker-ended");
      void runtime.cancel(sessionId, "mission-worker-ended").catch(() => {
        logger.error("runtime_cancel_failed", { sessionId, reason: "mission-worker-ended" });
      });
      logger.info("mission_worker_released", { sessionId, toolUseIds: pendingToolIds, graceMs: config.workerEndGraceMs, generation });
    }, config.workerEndGraceMs);
    timer.unref();
    workerEndTimers.set(sessionId, { generation, timer });
  }

  /**
   * Droid compacts a long conversation with a tool-free summarizer and continues
   * with a new first message that quotes the summary, which here is a new
   * conversation. The tool the old one was waiting on was answered inside that
   * summary, so it would hold its process and session slot for good (sessions
   * waiting on StartMissionRun are never reclaimed). Link a summarizer to the one
   * parked session waiting on exactly the last tool call it shows answered, and
   * release that session only once Droid continues with the summary this Bridge
   * produced. Anything ambiguous or unmatched releases nothing.
   */
  const compactions = new Map<string, { sessionId: string; pendingToolIds: string; at: number }>();
  const COMPACTION_LINK_MS = 60 * 60 * 1000;
  function summarizedSession(request: MessagesRequest): { sessionId: string; pendingToolIds: string } | undefined {
    if (hostAllowsAnyTools(request)) return undefined;
    const call = lastSummarizedToolCall(request);
    if (!call) return undefined;
    const parked = store.list().filter((session) => session.state === "WAITING_DROID_TOOL" && !activeRequests.has(session.bridgeSessionId)
      && (runtime.pendingHostCalls?.(session.bridgeSessionId) ?? []).some((pending) => pending.toolName === call.name && sameToolInput(pending.input, call.input)));
    return parked.length === 1 ? { sessionId: parked[0]!.bridgeSessionId, pendingToolIds: parked[0]!.pendingToolIds.join("\n") } : undefined;
  }
  function rememberCompaction(link: { sessionId: string; pendingToolIds: string }, summary: string): void {
    const quote = summaryQuote(summary);
    // A short reply is not a summary Droid would continue from.
    if (quote.length < 200) return;
    const now = Date.now();
    for (const [key, entry] of compactions) if (now - entry.at > COMPACTION_LINK_MS) compactions.delete(key);
    compactions.set(quote, { ...link, at: now });
    if (compactions.size > 256) compactions.delete(compactions.keys().next().value!);
  }
  function releaseCompacted(request: MessagesRequest): void {
    const text = compactedSummaryText(request);
    if (!text) return;
    for (const [quote, entry] of compactions) {
      if (!text.includes(quote)) continue;
      compactions.delete(quote);
      const session = store.get(entry.sessionId);
      if (!session || session.state !== "WAITING_DROID_TOOL" || activeRequests.has(entry.sessionId) || session.pendingToolIds.join("\n") !== entry.pendingToolIds) return;
      const toolUseIds = [...session.pendingToolIds];
      clearWorkerEnd(entry.sessionId);
      store.interrupt(entry.sessionId, "compacted-by-droid");
      void runtime.cancel(entry.sessionId, "compacted-by-droid").catch(() => {
        logger.error("runtime_cancel_failed", { sessionId: entry.sessionId, reason: "compacted-by-droid" });
      });
      logger.info("compacted_session_released", { sessionId: entry.sessionId, toolUseIds });
      return;
    }
  }

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      writeError(res, error);
    }
  });

  const url = listenUrl(config.host, config.port);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    assertRequestTarget(req);
    if (closing) {
      res.setHeader("Connection", "close");
      throw new BridgeError(503, "bridge_shutting_down", "bridge is shutting down");
    }
    const urlObj = new URL(req.url ?? "/", "http://localhost");
    const path = urlObj.pathname;

    if (req.method === "GET" && path === "/control") {
      for (const [key, value] of Object.entries(controlPageHeaders())) res.setHeader(key, value);
      html(res, controlPageHtml());
      return;
    }
    if (path.startsWith("/internal/")) res.setHeader("Cache-Control", "no-store");
    if (req.method === "GET" && path === "/internal/approvals") {
      requireAdminToken(req.headers, config.adminToken);
      json(res, 200, { approvals: control.listApprovals() });
      return;
    }
    if (req.method === "POST" && path === "/internal/launches") {
      requireAdminToken(req.headers, config.adminToken);
      json(res, 200, control.createLaunch(await readJson(req, config.maxBodyBytes)));
      return;
    }
    const launchAction = path.match(/^\/internal\/launches\/([^/]+)\/(cancel|end)$/);
    if (req.method === "POST" && launchAction) {
      requireAdminToken(req.headers, config.adminToken);
      json(res, 200, await control.endLaunch(launchAction[1]!, launchAction[2] === "cancel"));
      return;
    }
    if (req.method === "POST" && /^\/internal\/approvals\/[^/]+$/.test(path)) {
      requireAdminToken(req.headers, config.adminToken);
      control.decide(path.slice("/internal/approvals/".length), await readJson(req, config.maxBodyBytes));
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && path === "/internal/host-events") {
      requireAdminOrHookToken(req.headers, config.adminToken, config.hookToken);
      const envelope = await readJson(req, config.maxBodyBytes);
      const result = await control.hostEvent(envelope);
      const event = (envelope as { event?: Record<string, unknown> }).event;
      appendLogLine(join(config.logDir, "host-events.jsonl"), JSON.stringify({ at: new Date().toISOString(), eventId: (envelope as { eventId?: string }).eventId, hook: event?.hook_event_name, hostSessionId: event?.session_id, toolName: event?.tool_name, matched: result.matched, ended: result.ended, sessions: result.sessions }));
      json(res, 200, result);
      return;
    }
    if (req.method === "GET" && path === "/internal/runtime") {
      requireAdminToken(req.headers, config.adminToken);
      json(res, 200, runtimeStatus());
      return;
    }

    if (req.method === "GET" && path === "/") {
      html(
        res,
        statusPageHtml({
          mode: config.mode,
          host: config.host,
          port: config.port,
          healthy: true,
          sessions: store.list().length,
          requests: records.length,
        }),
      );
      return;
    }
    if (req.method === "GET" && path === "/healthz") {
      json(res, 200, { ok: true, mode: config.mode });
      return;
    }
    if (req.method === "GET" && path === "/internal/sessions") {
      requireAdminToken(req.headers, config.adminToken);
      json(res, 200, { sessions: store.list() });
      return;
    }
    if (req.method === "POST" && path === "/internal/cancel") {
      requireAdminToken(req.headers, config.adminToken);
      const body = (await readJson(req, config.maxBodyBytes)) as { sessionId?: string };
      if (!body.sessionId) throw new BridgeError(400, "invalid_request_error", "sessionId required");
      control.cancelApprovals(body.sessionId);
      store.update(body.sessionId, { cancelRequested: true });
      store.setState(body.sessionId, "CANCELLED");
      await runtime.cancel(body.sessionId, "admin-cancel");
      json(res, 200, { cancelled: body.sessionId });
      return;
    }
    if (req.method === "POST" && (path === "/v1/messages/count_tokens" || path === "/v1/messages/count_tokens/")) {
      requireClientToken(req.headers, config.clientToken);
      // 404 rather than 5xx: this is permanent, so clients must not retry it.
      json(res, 404, { type: "error", error: { type: "not_found_error", message: "token counting is not supported: only estimates are possible and this bridge refuses to fake exact counts" } });
      return;
    }
    if (req.method === "GET" && (path === "/v1/models" || path === "/v1/models/")) {
      requireClientToken(req.headers, config.clientToken);
      const data = (config.models === undefined ? [] : configuredModels(config))
        .map((model) => ({ id: model.id, display_name: model.displayName, type: "model" }));
      json(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
      return;
    }
    if (req.method === "POST" && (path === "/v1/messages" || path === "/v1/messages/")) {
      await handleMessages(req, res);
      return;
    }
    json(res, 404, apiError(404, "not_found_error", `no route ${req.method} ${path}`));
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headers = req.headers;
    try {
      requireClientToken(headers, config.clientToken);
    } catch (error) {
      record(req, false, { notes: ["auth-failed-no-sdk"] });
      throw error;
    }

    const rawBody = await readBody(req, config.maxBodyBytes);
    const admissionStarted = Date.now();
    const raw = parseJsonBody(rawBody);
    if (res.destroyed || req.aborted) return;
    // Shutdown may begin while an already accepted request is uploading its
    // body. Such requests must not create an SDK query after runtime.close().
    if (closing) {
      res.setHeader("Connection", "close");
      throw new BridgeError(503, "bridge_shutting_down", "bridge is shutting down");
    }
    const parsed = parseMessagesRequest(raw);
    // Reject stale menu entries before binding a host or creating a session.
    if (config.models !== undefined) {
      if (!configuredModels(config).some((model) => model.id === parsed.model)) {
        throw new BridgeError(400, "unknown_model", "This model is not configured. Select a model from this Bridge's model list.");
      }
      if (config.mode === "sdk") resolveRequestModel(config, parsed.model);
    }
    const role = roleFromHeaders(headers);
    const cwd = resolveRequestCwd(headers, parsed, config);
    const prepared = control.prepareRequest(parsed, cwd);
    const request = prepared.request;
    const listed = configuredModels(config).find((model) => model.id === request.model);
    const provider: ModelProvider = listed?.provider ?? providerFromModelId(request.model);
    // Before this conversation takes a slot, free the one it replaces.
    releaseCompacted(request);
    const summarized = summarizedSession(request);
    const contextHash = sessionContextHash(headers, request, cwd, provider);
    const incomingHashes = historyMessageHashes(request.messages);
    const requestFingerprint = createHash("sha256").update(JSON.stringify({ request, role, cwd, provider, contextHash, host: control.hostSessionId(prepared.binding) ?? null })).digest("hex");
    const explicit = explicitSessionId(headers, request);
    const retries = store.list().filter((session) => session.state === "IDLE" && session.hostEnded === undefined && !session.pendingToolIds.length
      && session.retryableRequestHash === requestFingerprint && (!explicit || session.bridgeSessionId === explicit || session.droidSessionId === explicit));
    if (retries.length > 1) throw new BridgeError(409, "ambiguous_session", "Multiple failed requests match; supply X-Bridge-Session");
    const resolved = retries[0] ? { match: retries[0], reason: "upstream-retry" } : resolveSession(store.list(), headers, request, {
      cwd, hostSessionId: control.hostSessionId(prepared.binding), allowModelSwitch: config.models !== undefined, provider,
      // Droid desktop has no conversation ID header or hooks to disambiguate.
      continueIdenticalTranscripts: config.desktopProfile,
    });
    const session = resolved.match
      ?? withSlot(() => store.create({
        role,
        model: request.model,
        ...(provider === "cursor" ? { provider } : {}),
        droidSessionId: explicitSessionId(headers, request),
        historyHash: historyPrefixHash(request),
        contextHash,
        reasoning: droidReasoningLevel(request),
        requestMessageHashes: incomingHashes,
        toolNames: (request.tools ?? []).map((t) => t.name),
      }));

    const sessionId = session.bridgeSessionId;
    if (activeRequests.has(sessionId)) {
      throw new BridgeError(409, "session_busy", "another request is already running for this session");
    }
    if (isEnded(session)) {
      throw new BridgeError(409, "session_unavailable", "this session has ended; start a new session");
    }
    const owner = Symbol(sessionId);
    const previous = structuredClone(session);
    activeRequests.set(sessionId, owner);
    try {
      // The state write can be refused (session limit); the binding cannot be
      // undone. So write the state first and bind last, and if only the bind is
      // refused give the session back exactly as it was.
      clearWorkerEnd(sessionId);
      withSlot(() => store.setState(sessionId, session.state === "WAITING_DROID_TOOL" ? "RESUMING" : "GENERATING"));
      try {
        control.bind(prepared.binding, sessionId);
      } catch (error) {
        // A session this request just created has no history worth keeping, and a
        // lingering NEW one would hold a slot forever.
        if (resolved.match) store.update(sessionId, { state: previous.state });
        else store.setState(sessionId, "FAILED");
        throw error;
      }
    } catch (error) {
      activeRequests.delete(sessionId);
      throw error;
    }
    const writer = request.stream
      ? new SseWriter(res, { id: messageId(), model: request.model })
      : undefined;
    let completed = false;
    let cancellationRequested = false;
    let timedOut = false;
    let timeoutSettled: Promise<void> | undefined;
    let rejectInterrupted!: (error: BridgeError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    const cancelOwnedRequest = (reason: string, error: BridgeError): void => {
      if (completed || cancellationRequested || activeRequests.get(sessionId) !== owner) return;
      cancellationRequested = true;
      watchdog.dispose();
      store.update(sessionId, { cancelRequested: true });
      store.setState(sessionId, "CANCELLED");
      rejectInterrupted(error);
      void runtime.cancel(sessionId, reason).catch(() => {
        logger.error("runtime_cancel_failed", { sessionId, reason });
      });
    };
    // A timed-out turn is interrupted first. If it winds down in time its native
    // checkpoint stays resumable (IDLE); otherwise the process is killed (FAILED).
    const settleExpiredTurn = async (): Promise<void> => {
      control.cancelApprovals(sessionId);
      let resumable = false;
      if (runtime.interrupt) {
        try { resumable = await runtime.interrupt(sessionId, "request-timeout"); }
        catch { logger.warn("runtime_interrupt_failed", { sessionId }); }
      }
      if (resumable) {
        store.update(sessionId, { cancelRequested: false, notes: [...store.require(sessionId).notes, "request-timeout-interrupted"] });
        store.setState(sessionId, "IDLE");
        return;
      }
      store.setState(sessionId, "FAILED");
      await runtime.cancel(sessionId, "request-timeout").catch(() => {
        logger.error("runtime_cancel_failed", { sessionId, reason: "request-timeout" });
      });
    };
    const expireOwnedRequest = (kind: TurnTimeout): void => {
      if (completed || cancellationRequested || activeRequests.get(sessionId) !== owner) return;
      cancellationRequested = true;
      timedOut = true;
      // Fence the late completion of this turn before anything else happens.
      store.update(sessionId, { cancelRequested: true });
      rejectInterrupted(new BridgeError(504, "request_timeout", kind === "idle"
        ? `request timed out: no progress for ${duration(config.requestTimeoutMs)}; the SDK turn was interrupted`
        : `request exceeded the turn limit of ${duration(config.turnMaxMs)} (BRIDGE_TURN_MAX_MS); the SDK turn was interrupted`));
      timeoutSettled = settleExpiredTurn().catch((error: unknown) => {
        logger.error("request_timeout_settle_failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
      });
    };
    const onDisconnect = (): void => {
      if (!res.writableFinished) cancelOwnedRequest("client-disconnect", new BridgeError(499, "cancelled", "client disconnected"));
    };
    res.once("close", onDisconnect);
    // Idle limit: any SDK message, delta or tool event restarts it, and a pending
    // approval pauses it. The absolute cap applies however much progress is made.
    const watchdog = new TurnWatchdog({ idleMs: config.requestTimeoutMs, maxMs: config.turnMaxMs, onTimeout: expireOwnedRequest });
    const sink: StreamSink = {
      textDelta: (text) => { watchdog.touch(); if (writer && !completed && !cancellationRequested) writer.textDelta(text); },
      toolTrace: (name, detail) => { watchdog.touch(); if (writer && !completed && !cancellationRequested) writer.toolTrace(name, detail); },
      activity: () => watchdog.touch(),
      approvalsPending: (count) => watchdog.setPaused(count > 0),
    };
    try {
      store.update(sessionId, {
        hostEnded: undefined,
        retryableRequestHash: undefined,
        role,
        model: request.model,
        ...(provider === "cursor" ? { provider } : {}),
        contextHash,
        reasoning: droidReasoningLevel(request),
        historyHash: historyPrefixHash(request),
        requestMessageHashes: incomingHashes,
        toolNames: (request.tools ?? []).map((t) => t.name),
      });
      record(req, true, {
        role,
        sessionHint: sessionId,
        model: request.model,
        stream: request.stream,
        toolNames: (request.tools ?? []).map((t) => t.name),
        messageCount: request.messages.length,
        notes: [resolved.reason],
      });
      // Message text and prompts stay out of the log unless the operator opts in.
      const loggedBody = config.logBodies
        ? redactJson(raw)
        : { sha256: createHash("sha256").update(rawBody).digest("hex"), bytes: rawBody.length, toolNames: (request.tools ?? []).map((t) => t.name) };
      appendLogLine(
        requestLog,
        JSON.stringify({ at: new Date().toISOString(), path: "/v1/messages", headers: redactHeaders(headers as Record<string, string | string[] | undefined>), body: loggedBody, session: sessionId }),
      );
      res.setHeader("X-Bridge-Session", sessionId);
      res.setHeader("X-Bridge-Role", role);
      res.setHeader("X-Bridge-Mode", config.mode);
      logger.info("request_admitted", { sessionId, admissionMs: Date.now() - admissionStarted, messages: request.messages.length });

      const turn: RuntimeTurn = await Promise.race([
        interrupted,
        runtime.handle({ request, role, session, headers, ...(resolved.reason === "upstream-retry" ? { recovery: "cold-import" as const } : {}) }, sink),
      ]);
      if (cancellationRequested || store.get(sessionId)?.cancelRequested) {
        throw new BridgeError(499, "cancelled", "session cancelled");
      }
      const notes = [...new Set([...session.notes, ...(turn.notes ?? [])])];
      const assistantContent = writer ? writer.completeContent(turn.response) : turn.response.content;
      store.update(sessionId, {
        pendingToolIds: turn.pendingToolIds,
        notes,
        sdkSessionId: turn.sdkSessionId ?? session.sdkSessionId,
        historyMessageHashes: historyMessageHashes([...request.messages, { role: "assistant", content: assistantContent }]),
        usage: { ...turn.response.usage, estimated: turn.response.usage.estimated ?? false },
      });
      store.setState(sessionId, turn.pendingToolIds.length ? "WAITING_DROID_TOOL" : "IDLE");
      if (turn.pendingToolIds.length) scheduleWorkerEnd(sessionId, turn.pendingToolIds);
      if (summarized) rememberCompaction(summarized, turn.response.content.map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : "")).join("\n"));
      appendLogLine(turnLog, JSON.stringify(redactJson({
        at: new Date().toISOString(),
        session: sessionId,
        sdkSessionId: turn.sdkSessionId ?? session.sdkSessionId,
        responseId: turn.response.id,
        usage: turn.response.usage,
        sdkBillingUsage: turn.sdkBillingUsage,
        compactMetadata: turn.compactMetadata,
        // Cancellation and Task batch events carry only IDs and tool names: how a cancelled Droid tool was handled, which Task calls went to Droid together.
        events: (turn.events ?? []).filter((event) => /usage|compact|cancelled_turn|task_batch/i.test(event.type)),
      })));
      completed = true;
      if (writer) writer.finish(turn.response);
      else json(res, 200, turn.response);
    } catch (error) {
      completed = true;
      const current = store.get(sessionId);
      const recoverableSwitch = error instanceof BridgeError && error.status === 409
        && ["model_switch_busy", "model_switch_requires_persistence", "model_switch_unavailable", "reasoning_switch_busy", "reasoning_switch_requires_persistence", "reasoning_switch_unavailable"].includes(error.code);
      const rejectedInput = error instanceof BridgeError && [400, 409, 422].includes(error.status) && runtime.isSessionUsable?.(sessionId) === true;
      const retryableUpstream = error instanceof BridgeError && ([429, 529].includes(error.status) || error.code === "sdk_start_timeout") && error.extra.retry_from_history === true
        && !cancellationRequested && current && !current.cancelRequested && current.hostEnded === undefined
        && (current.state === "GENERATING" || current.state === "RESUMING")
        && (previous.historyMessageHashes ?? []).every((hash, index) => incomingHashes[index] === hash);
      if (retryableUpstream) {
        await runtime.cancel(sessionId, "upstream-backoff").catch(() => logger.error("runtime_cancel_failed", { sessionId, reason: "upstream-backoff" }));
        if (!current.cancelRequested && current.hostEnded === undefined && activeRequests.get(sessionId) === owner
            && (current.state === "GENERATING" || current.state === "RESUMING")) {
          store.update(sessionId, { pendingToolIds: [], sdkSessionId: undefined, retryableRequestHash: requestFingerprint });
          store.setState(sessionId, "IDLE");
        }
      } else if (recoverableSwitch || rejectedInput) {
        if (!cancellationRequested && current && !current.cancelRequested && current.hostEnded === undefined
          && (current.state === "GENERATING" || current.state === "RESUMING")) {
          // Restore only our pending request, never a later host lifecycle event.
          store.update(sessionId, { ...previous, hostEnded: previous.hostEnded });
        }
      } else if (!timedOut && current?.state !== "CANCELLED" && !(error instanceof BridgeError && error.code === "host_session_ended")) {
        store.setState(sessionId, "FAILED");
        await runtime.cancel(sessionId, "request-failed").catch(() => logger.error("runtime_cancel_failed", { sessionId, reason: "request-failed" }));
      }
      // Answer now; the slot below may still be held while a timed-out turn stops.
      if (writer) writer.fail(error);
      else writeError(res, error);
    } finally {
      watchdog.dispose();
      writer?.dispose();
      res.off("close", onDisconnect);
      // Keep the slot until a timed-out turn is interrupted or killed, so a retry
      // never meets a half-stopped native session.
      if (timeoutSettled) await timeoutSettled;
      if (activeRequests.get(sessionId) === owner) activeRequests.delete(sessionId);
    }
  }

  function boundPort(): number {
    const address = server.address();
    if (address && typeof address === "object") return address.port;
    return config.port;
  }

  function assertRequestTarget(req: IncomingMessage): void {
    const port = boundPort();
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (config.allowRemote) {
      allowedHosts.add(`${formatListenHost(config.host)}:${port}`);
      // The names remote clients dial. A wildcard bind cannot know them itself.
      for (const name of config.allowedHosts) allowedHosts.add(`${name}:${port}`);
    }
    const requestHost = header(req.headers, "host");
    if (!requestHost || ![...allowedHosts].some((item) => item.toLowerCase() === requestHost.toLowerCase())) {
      throw new BridgeError(403, "permission_error", "Host is not allowed for this bridge.");
    }
    const origin = header(req.headers, "origin");
    if (!origin) return;
    const allowedOrigins = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ]);
    if (config.allowRemote) {
      allowedOrigins.add(listenUrl(config.host, port));
      for (const name of config.allowedHosts) allowedOrigins.add(`http://${name}:${port}`);
    }
    if (![...allowedOrigins].some((item) => item.toLowerCase() === origin.toLowerCase())) {
      throw new BridgeError(403, "permission_error", "Origin is not allowed for this bridge.");
    }
  }

  function record(req: IncomingMessage, authOk: boolean, extra: Partial<RedactedRequestRecord>): void {
    if (!authOk) {
      authFailureCount += 1;
      return;
    }
    const item: RedactedRequestRecord = {
      at: new Date().toISOString(),
      method: req.method ?? "GET",
      path: req.url ?? "/",
      role: extra.role ?? "unknown",
      authOk,
      ...extra,
    };
    records.push(item);
    if (records.length > RECORD_LIMIT) records.splice(0, records.length - RECORD_LIMIT);
    indexDirty = true;
    if (indexTimer) return;
    indexTimer = setTimeout(() => {
      indexTimer = undefined;
      flushRequestIndex();
    }, 1000);
    indexTimer.unref();
  }

  function flushRequestIndex(): void {
    if (indexTimer) {
      clearTimeout(indexTimer);
      indexTimer = undefined;
    }
    if (!indexDirty) return;
    indexDirty = false;
    const target = join(config.logDir, "request-index.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(records, null, 2), { mode: 0o600, flag: "wx" });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  return {
    server,
    store,
    records,
    get authFailureCount() { return authFailureCount; },
    url,
    runtimeStatus,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      clearInterval(maintenance);
      for (const sessionId of [...workerEndTimers.keys()]) clearWorkerEnd(sessionId);
      flushRequestIndex();
      control.close();
      // Stop accepting before SDK cleanup begins. Handle both promises at once
      // so a server failure cannot become an unhandled rejection during cleanup.
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      const runtimeClosed = Promise.resolve(maintenanceRunning).then(() => runtime.close?.());
      closePromise = Promise.allSettled([serverClosed, runtimeClosed]).then((results) => {
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (errors.length === 1) throw errors[0]!.reason;
        if (errors.length > 1) throw new AggregateError(errors.map((error) => error.reason), "bridge shutdown failed");
      });
      return closePromise;
    },
  };

  function runtimeStatus(): Record<string, unknown> {
    return { ...runtime.describe?.(), control: control.describe(), authFailureCount, activeRequests: activeRequests.size,
      retainedSessions: store.list().length, workerEndTimers: workerEndTimers.size, compactionLinks: compactions.size,
      memory: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed }, closing };
  }
}

export function listen(app: BridgeApp, config: BridgeConfig): Promise<BridgeApp> {
  return new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.port, config.host, () => {
      const address = app.server.address();
      if (address && typeof address !== "string") {
        // The runtime shares this config and supplies the local client URL to
        // native skill commands, including when the OS chose an ephemeral port.
        config.port = address.port;
        app.url = listenUrl(config.host, address.port);
      }
      resolve(app);
    });
  });
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    assertBodySize(size, max);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return {};
  try { return JSON.parse(body.toString("utf8")); }
  catch { throw new BridgeError(400, "invalid_request_error", "Request body must contain valid JSON."); }
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  return parseJsonBody(await readBody(req, max));
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function writeError(res: ServerResponse, error: unknown): void {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  if (error instanceof BridgeError) {
    if (typeof error.extra?.retry_after === "number") res.setHeader("retry-after", String(error.extra.retry_after));
    json(res, error.status, {
      type: "error",
      error: { type: error.code, message: error.message, ...error.extra },
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  json(res, 500, { type: "error", error: { type: "internal_error", message } });
}

