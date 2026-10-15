import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { parseMessagesRequest } from "../protocol/validate.js";
import { apiError } from "../protocol/messages.js";
import { explicitSessionId, historyPrefixHash, resolveSession, roleFromHeaders } from "../sessions/correlate.js";
import { SessionStore } from "../sessions/store.js";
import { createRuntime } from "../runtime/factory.js";
import type { RuntimeTurn } from "../runtime/types.js";
import { requireAdminToken, requireClientToken } from "../security/auth.js";
import { assertBodySize } from "../security/limits.js";
import { redactHeaders, redactJson } from "../security/redact.js";
import { BridgeError, type RedactedRequestRecord } from "../types.js";
import { writeMessageSse } from "./sse.js";
import { SseWriter } from "./sse-stream.js";
import { statusPageHtml } from "./status-page.js";
import { messageId } from "../protocol/messages.js";

export interface BridgeApp {
  server: Server;
  store: SessionStore;
  records: RedactedRequestRecord[];
  url: string;
  close(): Promise<void>;
}

export function createBridgeApp(config: BridgeConfig, logger: Logger, canaryPath: string): BridgeApp {
  const store = new SessionStore(join(config.dataDir, "sessions"), config.persistSessions, config.maxSessions);
  const runtime = createRuntime(config, logger, canaryPath);
  const records: RedactedRequestRecord[] = [];
  mkdirSync(config.logDir, { recursive: true });
  const requestLog = join(config.logDir, "requests.jsonl");

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      writeError(res, error);
    }
  });

  const url = `http://${config.host}:${config.port}`;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlObj = new URL(req.url ?? "/", `http://${config.host}`);
    const path = urlObj.pathname;

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
      json(res, 200, {
        ok: true,
        mode: config.mode,
        sdk: config.mode === "sdk",
        upstream: runtime.describe?.() ?? null,
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
    const request = parseMessagesRequest(raw);
    const role = roleFromHeaders(headers);
    const resolved = resolveSession(store.list(), headers, request);
    const session = resolved.match
      ?? store.create({
        role,
        model: request.model,
        droidSessionId: explicitSessionId(headers, request),
        historyHash: historyPrefixHash(request),
        toolNames: (request.tools ?? []).map((t) => t.name),
      });

    store.update(session.bridgeSessionId, {
      role,
      model: request.model,
      historyHash: historyPrefixHash(request),
      toolNames: (request.tools ?? []).map((t) => t.name),
    });
    store.setState(session.bridgeSessionId, session.state === "WAITING_DROID_TOOL" ? "RESUMING" : "GENERATING");

    record(req, true, {
      role,
      sessionHint: session.bridgeSessionId,
      model: request.model,
      stream: request.stream,
      toolNames: (request.tools ?? []).map((t) => t.name),
      messageCount: request.messages.length,
      notes: [resolved.reason],
    });
    appendFileSync(
      requestLog,
      `${JSON.stringify({ at: new Date().toISOString(), path: "/v1/messages", headers: redactHeaders(headers as Record<string, string | string[] | undefined>), body: redactJson(raw), session: session.bridgeSessionId })}\n`,
    );

    res.setHeader("X-Bridge-Session", session.bridgeSessionId);
    res.setHeader("X-Bridge-Role", role);
    res.setHeader("X-Bridge-Mode", config.mode);

    const writer = request.stream
      ? new SseWriter(res, { id: messageId(), model: request.model })
      : undefined;
    if (writer) writer.start();

    let turn: RuntimeTurn;
    try {
      turn = await runtime.handle({ request, role, session, headers }, writer
        ? {
            textDelta: (text) => writer.textDelta(text),
            toolTrace: (name, detail) => writer.toolTrace(name, detail),
          }
        : undefined);
    } catch (error) {
      if (writer) {
        const message = error instanceof Error ? error.message : String(error);
        writer.textDelta(`\n[bridge error] ${message}\n`);
        writer.finish({
          id: messageId(),
          type: "message",
          role: "assistant",
          model: request.model,
          content: [{ type: "text", text: message }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0, estimated: true },
        });
        store.setState(session.bridgeSessionId, "FAILED");
        return;
      }
      throw error;
    }
    if (turn.notes?.length) session.notes.push(...turn.notes.filter((note) => !session.notes.includes(note)));
    store.update(session.bridgeSessionId, {
      pendingToolIds: turn.pendingToolIds,
      notes: session.notes,
      sdkSessionId: store.get(session.bridgeSessionId)?.sdkSessionId,
    });
    store.setState(session.bridgeSessionId, turn.pendingToolIds.length ? "WAITING_DROID_TOOL" : "IDLE");

    if (writer) {
      writer.finish(turn.response);
      return;
    }
    if (request.stream) {
      writeMessageSse(res, turn.response);
      return;
    }
    json(res, 200, turn.response);
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
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function listen(app: BridgeApp, config: BridgeConfig): Promise<BridgeApp> {
  return new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.port, config.host, () => resolve(app));
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
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function writeError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) return;
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

