import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import * as runtimeFactory from "../../src/runtime/factory.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import { BridgeError } from "../../src/types.js";
import type { BridgeRuntime, RuntimeTurn, StreamSink } from "../../src/runtime/types.js";
import type { BridgeApp } from "../../src/http/app.js";
import { postMessages, startTestBridge } from "../helpers/server.js";
import { contentFromSse } from "../helpers/sse.js";

const apps: BridgeApp[] = [];
let runtime: BridgeRuntime;
const body = { model: "relay-chat", max_tokens: 64, messages: [{ role: "user", content: "hello" }] };

function result(text = "ok"): RuntimeTurn {
  return { response: assistantMessage("relay-chat", [{ type: "text", text }], "end_turn"), pendingToolIds: [] };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  runtime = {
    kind: "fake",
    handle: vi.fn(async () => result()),
    cancel: vi.fn(async () => undefined),
    deliverResults: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
  };
  vi.spyOn(runtimeFactory, "createRuntime").mockReturnValue(runtime);
});

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  vi.restoreAllMocks();
});

describe("HTTP execution lifecycle", () => {
  it("stops accepting before SDK cleanup and rejects previously accepted request bodies during shutdown", async () => {
    const cleanup = deferred<void>();
    const cleanupStarted = deferred<void>();
    vi.mocked(runtime.close!).mockImplementation(async () => {
      cleanupStarted.resolve();
      await cleanup.promise;
    });
    const { app, token } = await startTestBridge();
    apps.push(app);
    const accepted = new Promise<void>((resolve) => app.server.once("request", () => resolve()));
    const payload = JSON.stringify(body);
    const request = httpRequest(`${app.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    });
    const response = new Promise<{ status: number; raw: string }>((resolve, reject) => {
      request.once("error", reject);
      request.once("response", (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { raw += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, raw }));
      });
    });
    request.flushHeaders();
    await accepted;
    const shutdown = app.close();
    expect(app.close()).toBe(shutdown);
    await cleanupStarted.promise;
    expect(app.server.listening).toBe(false);
    request.end(payload);
    const rejected = await response;
    expect(rejected.status).toBe(503);
    expect(JSON.parse(rejected.raw).error.type).toBe("bridge_shutting_down");
    expect(runtime.handle).not.toHaveBeenCalled();
    cleanup.resolve();
    await shutdown;
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it.each(["model-deltas", "trace-only"])("resumes the actual SSE transcript with traces and whitespace without an explicit ID (%s)", async (mode) => {
    vi.mocked(runtime.handle).mockImplementationOnce(async (_input, sink) => {
      sink?.toolTrace("Read", " file.ts ");
      if (mode === "model-deltas") {
        sink?.textDelta("\n  Answer");
        sink?.textDelta(" \n");
      }
      return { ...result(mode === "model-deltas" ? "Answer" : "  fallback answer\n"), sdkSessionId: "wire-sdk-session" };
    });
    const { app, token } = await startTestBridge();
    apps.push(app);
    const stream = await fetch(`${app.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, stream: true }),
    });
    const content = contentFromSse(await stream.text());
    expect(content).toEqual(mode === "model-deltas"
      ? [{ type: "text", text: "\n[Read]  file.ts \n\n  Answer \n" }]
      : [{ type: "text", text: "\n[Read]  file.ts \n" }, { type: "text", text: "  fallback answer\n" }]);
    const second = await postMessages(app.url, token, {
      ...body,
      messages: [...body.messages, { role: "assistant", content }, { role: "user", content: "continue" }],
    });
    expect(second.status).toBe(200);
    expect(second.session).toBe(stream.headers.get("x-bridge-session"));
    expect(app.store.list()).toHaveLength(1);
    expect(app.records.at(-1)?.notes).toContain("history-prefix");
    expect(vi.mocked(runtime.handle).mock.calls[1]?.[0].session.sdkSessionId).toBe("wire-sdk-session");
  });

  it("exposes the same upstream failure in JSON and an SSE error event", async () => {
    vi.mocked(runtime.handle).mockImplementation(async (_input, sink) => {
      sink?.textDelta("partial output");
      throw new BridgeError(502, "upstream_error", "provider unavailable");
    });
    const { app, token } = await startTestBridge();
    apps.push(app);
    const plain = await postMessages(app.url, token, body, { "x-bridge-session": "plain" });
    expect(plain.status).toBe(502);
    expect(plain.json).toEqual({ type: "error", error: { type: "upstream_error", message: "provider unavailable" } });
    const stream = await fetch(`${app.url}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-bridge-session": "stream" },
      body: JSON.stringify({ ...body, stream: true }),
    });
    const raw = await stream.text();
    expect(raw).toContain("partial output");
    expect(raw).toContain(`event: error\ndata: ${JSON.stringify(plain.json)}`);
    expect(raw).not.toContain("event: message_stop");
    expect(raw).not.toContain('"stop_reason":"end_turn"');
    expect(app.store.list().every((session) => session.state === "FAILED")).toBe(true);
  });

  it("cancels timed out work and ignores its late completion", async () => {
    const pending = deferred<RuntimeTurn>();
    vi.mocked(runtime.handle).mockReturnValue(pending.promise);
    const { app, token } = await startTestBridge({ requestTimeoutMs: 30 });
    apps.push(app);
    const response = await postMessages(app.url, token, body);
    expect(response.status).toBe(504);
    expect(response.json.error).toMatchObject({ type: "request_timeout" });
    const session = app.store.list()[0]!;
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(session.bridgeSessionId, "request-timeout");
    pending.resolve(result("late"));
    await Promise.resolve();
    expect(session.state).toBe("FAILED");
  });

  it("cancels only the active session when its streaming client disconnects", async () => {
    vi.mocked(runtime.handle).mockImplementation(async (input, sink) => {
      if (input.session.droidSessionId === "alive") return result();
      sink?.textDelta("started");
      return new Promise<RuntimeTurn>(() => undefined);
    });
    const { app, token } = await startTestBridge();
    apps.push(app);
    const alive = await postMessages(app.url, token, body, { "x-bridge-session": "alive" });
    const abort = new AbortController();
    const response = await fetch(`${app.url}/v1/messages`, {
      method: "POST", signal: abort.signal,
      headers: { authorization: `Bearer ${token}`, "x-bridge-session": "disconnect" },
      body: JSON.stringify({ ...body, stream: true }),
    });
    const disconnectedSession = response.headers.get("x-bridge-session")!;
    abort.abort();
    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(disconnectedSession, "client-disconnect"));
    expect(app.store.get(disconnectedSession)?.state).toBe("CANCELLED");
    expect(app.store.get(alive.session!)?.state).toBe("IDLE");
  });

  it("rejects overlapping requests before mutating the active session", async () => {
    const pending = deferred<RuntimeTurn>();
    const started = deferred<void>();
    vi.mocked(runtime.handle).mockImplementation(async () => { started.resolve(); return pending.promise; });
    const { app, token } = await startTestBridge();
    apps.push(app);
    const first = postMessages(app.url, token, body, { "x-bridge-session": "shared" });
    await started.promise;
    const before = structuredClone(app.store.list()[0]);
    const second = await postMessages(app.url, token, { ...body, messages: [{ role: "user", content: "conflicting request" }] }, { "x-bridge-session": "shared" });
    expect(second.status).toBe(409);
    expect(second.json.error).toMatchObject({ type: "session_busy" });
    expect(app.store.list()[0]).toEqual(before);
    expect(runtime.handle).toHaveBeenCalledTimes(1);
    pending.resolve(result());
    expect((await first).status).toBe(200);
  });

  it("does not cancel the next turn when the previous stream finishes", async () => {
    const pending = deferred<RuntimeTurn>();
    const started = deferred<void>();
    vi.mocked(runtime.handle)
      .mockResolvedValueOnce(result())
      .mockImplementationOnce(async (_input, sink?: StreamSink) => {
        sink?.textDelta("next");
        started.resolve();
        return pending.promise;
      });
    const { app, token } = await startTestBridge();
    apps.push(app);
    const headers = { authorization: `Bearer ${token}`, "x-bridge-session": "shared" };
    const first = await fetch(`${app.url}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }) });
    await first.text();
    const second = fetch(`${app.url}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true, messages: [{ role: "user", content: "next" }] }) });
    await started.promise;
    expect(runtime.cancel).not.toHaveBeenCalled();
    pending.resolve(result("next"));
    expect(await (await second).text()).toContain("event: message_stop");
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it("persists SDK identity and records cache/compaction evidence for the completed turn", async () => {
    const turn = result();
    turn.sdkSessionId = "official-sdk-session";
    turn.response.usage = { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 900, estimated: false };
    turn.events = [
      { at: "2026-10-15T00:00:00.000Z", type: "usage", data: { cacheRead: 900 } },
      { at: "2026-10-15T00:00:00.000Z", type: "compact_boundary", data: { before: 10000, after: 1000 } },
    ];
    vi.mocked(runtime.handle).mockResolvedValue(turn);
    const { app, token, config } = await startTestBridge({ persistSessions: true });
    apps.push(app);
    const response = await postMessages(app.url, token, body);
    expect(response.status).toBe(200);
    expect(app.store.get(response.session!)?.sdkSessionId).toBe("official-sdk-session");
    expect(readFileSync(join(config.dataDir, "sessions", "sessions.jsonl"), "utf8")).toContain("official-sdk-session");
    const logged = JSON.parse(readFileSync(join(config.logDir, "turns.jsonl"), "utf8").trim());
    expect(logged.usage.cache_read_input_tokens).toBe(900);
    expect(logged.events).toEqual(turn.events);
  });

  it("continues an unambiguous full transcript without an explicit session ID", async () => {
    vi.mocked(runtime.handle).mockResolvedValue({ ...result(), sdkSessionId: "continued-sdk-session" });
    const { app, token } = await startTestBridge();
    apps.push(app);
    const first = await postMessages(app.url, token, body);
    const second = await postMessages(app.url, token, {
      ...body,
      messages: [...body.messages, { role: "assistant", content: first.json.content }, { role: "user", content: "continue" }],
    });
    expect(second.status).toBe(200);
    expect(second.session).toBe(first.session);
    expect(app.store.list()).toHaveLength(1);
    expect(vi.mocked(runtime.handle).mock.calls[1]?.[0].session.sdkSessionId).toBe("continued-sdk-session");
  });

  it("allows sequential idle sessions, but capacity rejection leaves an idle session unchanged", async () => {
    const { app, token } = await startTestBridge({ maxSessions: 1 });
    apps.push(app);
    const first = await postMessages(app.url, token, body, { "x-bridge-session": "idle-a" });
    const second = await postMessages(app.url, token, body, { "x-bridge-session": "idle-b" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const pending = deferred<RuntimeTurn>();
    const started = deferred<void>();
    vi.mocked(runtime.handle).mockImplementationOnce(async () => { started.resolve(); return pending.promise; });
    const active = postMessages(app.url, token, body, { "x-bridge-session": "active" });
    await started.promise;
    const before = structuredClone(app.store.get(first.session!));
    const resume = await postMessages(app.url, token, { ...body, messages: [{ role: "user", content: "changed input" }] }, { "x-bridge-session": first.session! });
    expect(resume.status).toBe(429);
    expect(app.store.get(first.session!)).toEqual(before);
    pending.resolve(result());
    expect((await active).status).toBe(200);
  });
});
