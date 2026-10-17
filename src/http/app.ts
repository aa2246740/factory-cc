import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../config.js";
import { appendLogLine, type Logger } from "../logging.js";
import { parseMessagesRequest } from "../protocol/validate.js";
import { apiError } from "../protocol/messages.js";
import { explicitSessionId, historyMessageHashes, historyPrefixHash, resolveSession, roleFromHeaders, sessionContextHash } from "../sessions/correlate.js";
import { isEnded } from "../sessions/state.js";
import { SessionStore } from "../sessions/store.js";
import { createRuntime } from "../runtime/factory.js";
import type { RuntimeTurn, StreamSink } from "../runtime/types.js";
import { TurnWatchdog, type TurnTimeout } from "../runtime/turn-watchdog.js";
import { header, requireAdminOrHookToken, requireAdminToken, requireClientToken } from "../security/auth.js";
import { assertBodySize } from "../security/limits.js";
import { redactHeaders, redactJson } from "../security/redact.js";
import { BridgeError, type RedactedRequestRecord } from "../types.js";
import { SseWriter } from "./sse-stream.js";
import { statusPageHtml } from "./status-page.js";
import { messageId } from "../protocol/messages.js";
import { ControlBroker } from "../control/broker.js";
import { controlPageHtml, controlPageHeaders } from "./control-page.js";
import { configuredModels, resolveRequestModel } from "../models.js";

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

export function createBridgeApp(config: BridgeConfig, logger: Logger, canaryPath: string): BridgeApp {
  const store = new SessionStore(join(config.dataDir, "sessions"), config.persistSessions, config.maxSessions, logger);
  const runtime = createRuntime(config, logger, canaryPath);
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
  runtime.setLifecycle?.({
    toolWaitExpired: (sessionId) => {
      // A request in flight sees the ended native session itself and fails it.
      if (activeRequests.has(sessionId)) return;
      try {
        control.cancelApprovals(sessionId);
        store.interrupt(sessionId, "tool-wait-expired");
      } catch (error) {
        logger.warn("tool_wait_interrupt_failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

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
      json(res, 200, { ...runtime.describe?.(), control: control.describe(), authFailureCount });
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
    const cwd = process.env.BRIDGE_SDK_CWD || header(headers, "x-bridge-cwd") || config.sdkCwd;
    const prepared = control.prepareRequest(parsed, cwd);
    const request = prepared.request;
    const contextHash = sessionContextHash(headers, request, cwd);
    const resolved = resolveSession(store.list(), headers, request, {
      cwd, hostSessionId: control.hostSessionId(prepared.binding), allowModelSwitch: config.models !== undefined,
    });
    const session = resolved.match
      ?? store.create({
        role,
        model: request.model,
        droidSessionId: explicitSessionId(headers, request),
        historyHash: historyPrefixHash(request),
        contextHash,
        requestMessageHashes: historyMessageHashes(request.messages),
        toolNames: (request.tools ?? []).map((t) => t.name),
      });

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
      store.setState(sessionId, session.state === "WAITING_DROID_TOOL" ? "RESUMING" : "GENERATING");
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
        role,
        model: request.model,
        contextHash,
        historyHash: historyPrefixHash(request),
        requestMessageHashes: historyMessageHashes(request.messages),
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
      writer?.start();

      const turn: RuntimeTurn = await Promise.race([
        interrupted,
        runtime.handle({ request, role, session, headers }, sink),
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
      appendLogLine(turnLog, JSON.stringify(redactJson({
        at: new Date().toISOString(),
        session: sessionId,
        sdkSessionId: turn.sdkSessionId ?? session.sdkSessionId,
        responseId: turn.response.id,
        usage: turn.response.usage,
        sdkBillingUsage: turn.sdkBillingUsage,
        compactMetadata: turn.compactMetadata,
        events: (turn.events ?? []).filter((event) => /usage|compact/i.test(event.type)),
      })));
      completed = true;
      if (writer) writer.finish(turn.response);
      else json(res, 200, turn.response);
    } catch (error) {
      completed = true;
      const current = store.get(sessionId);
      const recoverableSwitch = error instanceof BridgeError && error.status === 409
        && ["model_switch_busy", "model_switch_requires_persistence", "model_switch_unavailable"].includes(error.code);
      if (recoverableSwitch) {
        if (!cancellationRequested && current && !current.cancelRequested && current.hostEnded === undefined
          && (current.state === "GENERATING" || current.state === "RESUMING")) {
          // Restore only our pending request, never a later host lifecycle event.
          store.update(sessionId, { ...previous, hostEnded: previous.hostEnded });
        }
      } else if (!timedOut && current?.state !== "CANCELLED" && !(error instanceof BridgeError && error.code === "host_session_ended")) {
        store.setState(sessionId, "FAILED");
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
    runtimeStatus: () => ({ ...runtime.describe?.(), control: control.describe(), authFailureCount }),
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      flushRequestIndex();
      control.close();
      // Stop accepting before SDK cleanup begins. Handle both promises at once
      // so a server failure cannot become an unhandled rejection during cleanup.
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      const runtimeClosed = Promise.resolve().then(() => runtime.close?.());
      closePromise = Promise.allSettled([serverClosed, runtimeClosed]).then((results) => {
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (errors.length === 1) throw errors[0]!.reason;
        if (errors.length > 1) throw new AggregateError(errors.map((error) => error.reason), "bridge shutdown failed");
      });
      return closePromise;
    },
  };
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
    json(res, error.status, {
      type: "error",
      error: { type: error.code, message: error.message, ...error.extra },
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  json(res, 500, { type: "error", error: { type: "internal_error", message } });
}

