import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { parseMessagesRequest } from "../protocol/validate.js";
import { apiError } from "../protocol/messages.js";
import { explicitSessionId, historyMessageHashes, historyPrefixHash, resolveSession, roleFromHeaders, sessionContextHash } from "../sessions/correlate.js";
import { SessionStore } from "../sessions/store.js";
import { createRuntime } from "../runtime/factory.js";
import type { RuntimeTurn } from "../runtime/types.js";
import { header, requireAdminToken, requireClientToken } from "../security/auth.js";
import { assertBodySize } from "../security/limits.js";
import { redactHeaders, redactJson } from "../security/redact.js";
import { BridgeError, type RedactedRequestRecord } from "../types.js";
import { SseWriter } from "./sse-stream.js";
import { statusPageHtml } from "./status-page.js";
import { messageId } from "../protocol/messages.js";
import { ControlBroker } from "../control/broker.js";
import { controlPageHtml, controlPageHeaders } from "./control-page.js";

export interface BridgeApp {
  server: Server;
  store: SessionStore;
  records: RedactedRequestRecord[];
  url: string;
  runtimeStatus(): Record<string, unknown>;
  close(): Promise<void>;
}

export function createBridgeApp(config: BridgeConfig, logger: Logger, canaryPath: string): BridgeApp {
  const store = new SessionStore(join(config.dataDir, "sessions"), config.persistSessions, config.maxSessions);
  const runtime = createRuntime(config, logger, canaryPath);
  const control = new ControlBroker(runtime, store, Math.min(config.toolWaitMs, config.requestTimeoutMs));
  runtime.setControl?.(control);
  const records: RedactedRequestRecord[] = [];
  mkdirSync(config.logDir, { recursive: true });
  const requestLog = join(config.logDir, "requests.jsonl");
  const turnLog = join(config.logDir, "turns.jsonl");
  const activeRequests = new Map<string, symbol>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      writeError(res, error);
    }
  });

  const url = `http://${config.host}:${config.port}`;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closing) {
      res.setHeader("Connection", "close");
      throw new BridgeError(503, "bridge_shutting_down", "bridge is shutting down");
    }
    const urlObj = new URL(req.url ?? "/", `http://${config.host}`);
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
      requireAdminToken(req.headers, config.adminToken);
      const envelope = await readJson(req, config.maxBodyBytes);
      const result = await control.hostEvent(envelope);
      const event = (envelope as { event?: Record<string, unknown> }).event;
      appendFileSync(join(config.logDir, "host-events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), eventId: (envelope as { eventId?: string }).eventId, hook: event?.hook_event_name, hostSessionId: event?.session_id, toolName: event?.tool_name, matched: result.matched, ended: result.ended, sessions: result.sessions })}\n`);
      json(res, 200, result);
      return;
    }
    if (req.method === "GET" && path === "/internal/runtime") {
      requireAdminToken(req.headers, config.adminToken);
      json(res, 200, { ...runtime.describe?.(), control: control.describe() });
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
      const { fatalErrors: _errors, ...publicRuntime } = runtime.describe?.() ?? {};
      json(res, 200, {
        ok: true,
        mode: config.mode,
        sdk: config.mode === "sdk",
        upstream: publicRuntime,
      });
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
      json(res, 501, apiError(501, "not_supported_error", "token counting is estimated-only; refusing to fake exact counts").error);
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

    const raw = await readJson(req, config.maxBodyBytes);
    if (res.destroyed || req.aborted) return;
    // Shutdown may begin while an already accepted request is uploading its
    // body. Such requests must not create an SDK query after runtime.close().
    if (closing) {
      res.setHeader("Connection", "close");
      throw new BridgeError(503, "bridge_shutting_down", "bridge is shutting down");
    }
    const parsed = parseMessagesRequest(raw);
    const role = roleFromHeaders(headers);
    const cwd = process.env.BRIDGE_SDK_CWD || header(headers, "x-bridge-cwd") || config.sdkCwd;
    const prepared = control.prepareRequest(parsed, cwd);
    const request = prepared.request;
    const contextHash = sessionContextHash(headers, request, cwd);
    const resolved = resolveSession(store.list(), headers, request, { cwd, hostSessionId: control.hostSessionId(prepared.binding) });
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
    control.bind(prepared.binding, sessionId);
    if (activeRequests.has(sessionId)) {
      throw new BridgeError(409, "session_busy", "another request is already running for this session");
    }
    if (session.state === "CANCELLED" || session.state === "FAILED" || session.hostEnded === "terminal" || session.hostEnded === "interrupted") {
      throw new BridgeError(409, "session_unavailable", "this session has ended; start a new session");
    }
    const owner = Symbol(sessionId);
    activeRequests.set(sessionId, owner);
    try {
      store.setState(sessionId, session.state === "WAITING_DROID_TOOL" ? "RESUMING" : "GENERATING");
    } catch (error) {
      activeRequests.delete(sessionId);
      throw error;
    }
    const writer = request.stream
      ? new SseWriter(res, { id: messageId(), model: request.model })
      : undefined;
    let completed = false;
    let cancellationRequested = false;
    let rejectInterrupted!: (error: BridgeError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    const cancelOwnedRequest = (reason: string, error: BridgeError): void => {
      if (completed || cancellationRequested || activeRequests.get(sessionId) !== owner) return;
      cancellationRequested = true;
      store.update(sessionId, { cancelRequested: true });
      store.setState(sessionId, reason === "request-timeout" ? "FAILED" : "CANCELLED");
      rejectInterrupted(error);
      void runtime.cancel(sessionId, reason).catch(() => {
        logger.error("runtime_cancel_failed", { sessionId, reason });
      });
    };
    const onDisconnect = (): void => {
      if (!res.writableFinished) cancelOwnedRequest("client-disconnect", new BridgeError(499, "cancelled", "client disconnected"));
    };
    res.once("close", onDisconnect);
    const timer = setTimeout(() => {
      cancelOwnedRequest("request-timeout", new BridgeError(504, "request_timeout", "request timed out; SDK execution was cancelled"));
    }, config.requestTimeoutMs);
    timer.unref();
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
      appendFileSync(
        requestLog,
        `${JSON.stringify({ at: new Date().toISOString(), path: "/v1/messages", headers: redactHeaders(headers as Record<string, string | string[] | undefined>), body: redactJson(raw), session: sessionId })}\n`,
      );
      res.setHeader("X-Bridge-Session", sessionId);
      res.setHeader("X-Bridge-Role", role);
      res.setHeader("X-Bridge-Mode", config.mode);
      writer?.start();

      const turn: RuntimeTurn = await Promise.race([
        interrupted,
        runtime.handle({ request, role, session, headers }, writer
          ? {
              textDelta: (text) => { if (!completed && !cancellationRequested) writer.textDelta(text); },
              toolTrace: (name, detail) => { if (!completed && !cancellationRequested) writer.toolTrace(name, detail); },
            }
          : undefined),
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
      appendFileSync(turnLog, `${JSON.stringify(redactJson({
        at: new Date().toISOString(),
        session: sessionId,
        sdkSessionId: turn.sdkSessionId ?? session.sdkSessionId,
        responseId: turn.response.id,
        usage: turn.response.usage,
        sdkBillingUsage: turn.sdkBillingUsage,
        compactMetadata: turn.compactMetadata,
        events: (turn.events ?? []).filter((event) => /usage|compact/i.test(event.type)),
      }))}\n`);
      completed = true;
      if (writer) writer.finish(turn.response);
      else json(res, 200, turn.response);
    } catch (error) {
      completed = true;
      if (store.get(sessionId)?.state !== "CANCELLED" && !(error instanceof BridgeError && error.code === "host_session_ended")) store.setState(sessionId, "FAILED");
      if (writer) writer.fail(error);
      else throw error;
    } finally {
      clearTimeout(timer);
      res.off("close", onDisconnect);
      if (activeRequests.get(sessionId) === owner) activeRequests.delete(sessionId);
    }
  }

  function record(req: IncomingMessage, authOk: boolean, extra: Partial<RedactedRequestRecord>): void {
    const item: RedactedRequestRecord = {
      at: new Date().toISOString(),
      method: req.method ?? "GET",
      path: req.url ?? "/",
      role: extra.role ?? "unknown",
      authOk,
      ...extra,
    };
    records.push(item);
    writeFileSync(join(config.logDir, "request-index.json"), JSON.stringify(records, null, 2));
  }

  return {
    server,
    store,
    records,
    url,
    runtimeStatus: () => ({ ...runtime.describe?.(), control: control.describe() }),
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
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
        const url = new URL(app.url);
        url.port = String(address.port);
        app.url = url.toString().replace(/\/$/, "");
      }
      resolve(app);
    });
  });
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    assertBodySize(size, max);
    chunks.push(buf);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new BridgeError(400, "invalid_request_error", "Request body must contain valid JSON."); }
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

