import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeFactory from "../../src/runtime/factory.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import { BridgeError } from "../../src/types.js";
import type { BridgeRuntime, RuntimeControl, RuntimeTurn } from "../../src/runtime/types.js";
import type { BridgeApp } from "../../src/http/app.js";
import { postMessages, startTestBridge } from "../helpers/server.js";

const apps: BridgeApp[] = [];
let runtime: BridgeRuntime;
const body = { model: "relay-chat", max_tokens: 64, messages: [{ role: "user", content: "hello" }] };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function result(text = "ok"): RuntimeTurn {
  return { response: assistantMessage("relay-chat", [{ type: "text", text }], "end_turn"), pendingToolIds: [] };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const never = () => new Promise<RuntimeTurn>(() => undefined);

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
  vi.useRealTimers();
  while (apps.length) await apps.pop()!.close();
  vi.restoreAllMocks();
});

async function bridge(overrides: Parameters<typeof startTestBridge>[0] = {}) {
  const started = await startTestBridge(overrides);
  apps.push(started.app);
  return started;
}

describe("idle limit for a native turn", () => {
  it("lets a turn run far past the limit while it keeps reporting progress", async () => {
    vi.mocked(runtime.handle).mockImplementationOnce(async (_input, sink) => {
      for (let step = 0; step < 14; step += 1) {
        await sleep(50);
        if (step % 3 === 0) sink?.textDelta(`part ${step} `);
        else if (step % 3 === 1) sink?.toolTrace("Read", "file.ts");
        else sink?.activity?.();
      }
      return result("finished");
    });
    const { app, token } = await bridge({ requestTimeoutMs: 200, turnMaxMs: 60_000 });
    const response = await postMessages(app.url, token, body);
    expect(response.status).toBe(200);
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it("times out a turn that goes quiet, saying that no progress was made", async () => {
    vi.mocked(runtime.handle).mockImplementationOnce(async (_input, sink) => { sink?.activity?.(); return never(); });
    const { app, token } = await bridge({ requestTimeoutMs: 80 });
    const response = await postMessages(app.url, token, body);
    expect(response.status).toBe(504);
    expect(response.json.error).toMatchObject({ type: "request_timeout", message: expect.stringContaining("no progress") });
    const session = app.store.list()[0]!;
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(session.bridgeSessionId, "request-timeout");
    expect(session).toMatchObject({ state: "FAILED", pendingToolIds: [] });
  });

  it("restarts the idle window at each sign of life rather than at the request start", async () => {
    const started = Date.now();
    vi.mocked(runtime.handle).mockImplementationOnce(async (_input, sink) => {
      await sleep(80);
      sink?.activity?.();
      return never();
    });
    const { app, token } = await bridge({ requestTimeoutMs: 150 });
    const response = await postMessages(app.url, token, body);
    expect(response.status).toBe(504);
    expect(Date.now() - started).toBeGreaterThanOrEqual(80 + 150 - 15);
  });

  it("pauses the limit while a person decides on an approval, and answers when they do", async () => {
    vi.mocked(runtime.handle).mockImplementationOnce(async (_input, sink) => {
      sink?.approvalsPending?.(1);
      await sleep(500);
      sink?.approvalsPending?.(0);
      await sleep(40);
      return result("approved and finished");
    });
    const { app, token } = await bridge({ requestTimeoutMs: 100, turnMaxMs: 60_000 });
    const response = await postMessages(app.url, token, body);
    expect(response.status).toBe(200);
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it("starts a fresh idle window once the approval is decided", async () => {
    const started = Date.now();
    vi.mocked(runtime.handle).mockImplementationOnce(async (_input, sink) => {
      sink?.approvalsPending?.(1);
      await sleep(400);
      sink?.approvalsPending?.(0);
      return never();
    });
    const { app, token } = await bridge({ requestTimeoutMs: 100, turnMaxMs: 60_000 });
    const response = await postMessages(app.url, token, body);
    expect(response.status).toBe(504);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400 + 100 - 15);
  });

  it("still enforces the absolute cap on a turn that never stops reporting progress", async () => {
    let stopped = false;
    vi.mocked(runtime.cancel).mockImplementation(async () => { stopped = true; });
    vi.mocked(runtime.handle).mockImplementationOnce(async (_input, sink) => {
      while (!stopped) { sink?.activity?.(); await sleep(20); }
      throw new BridgeError(499, "cancelled", "stopped");
    });
    const { app, token } = await bridge({ requestTimeoutMs: 120, turnMaxMs: 300 });
    const response = await postMessages(app.url, token, body);
    expect(response.status).toBe(504);
    expect(response.json.error).toMatchObject({ type: "request_timeout", message: expect.stringContaining("BRIDGE_TURN_MAX_MS") });
    expect(runtime.cancel).toHaveBeenCalledTimes(1);
  });

  it("applies the approval limit to approvals, not the turn's idle limit", async () => {
    let control: RuntimeControl | undefined;
    runtime.setControl = vi.fn((value) => { control = value; });
    const { app, config } = await bridge({ approvalTimeoutMs: 7_000_000, requestTimeoutMs: 50 });
    void control!.requestApproval({ bridgeSessionId: "session", toolName: "Bash", input: {}, signal: new AbortController().signal });
    const listed = await fetch(`${app.url}/internal/approvals`, { headers: { authorization: `Bearer ${config.adminToken}` } }).then((response) => response.json()) as {
      approvals: Array<{ createdAt: string; expiresAt: string }>;
    };
    expect(listed.approvals).toHaveLength(1);
    const window = Date.parse(listed.approvals[0]!.expiresAt) - Date.parse(listed.approvals[0]!.createdAt);
    expect(Math.abs(window - 7_000_000)).toBeLessThan(1_000);
  });
});

describe("what happens to the session after a timeout", () => {
  const headers = { "x-bridge-session": "timed-out" };

  it("keeps it resumable when the turn winds down after the interrupt", async () => {
    runtime.interrupt = vi.fn(async () => true);
    vi.mocked(runtime.handle).mockImplementationOnce(() => never());
    const { app, token } = await bridge({ requestTimeoutMs: 60 });
    const response = await postMessages(app.url, token, body, headers);
    expect(response.status).toBe(504);
    const session = app.store.get(response.session!)!;
    expect(runtime.interrupt).toHaveBeenCalledExactlyOnceWith(session.bridgeSessionId, "request-timeout");
    // The 504 is sent first; the session settles to IDLE once the interrupt has wound the turn down.
    await vi.waitFor(() => expect(session.state).toBe("IDLE"));
    expect(session).toMatchObject({ cancelRequested: false, notes: expect.arrayContaining(["request-timeout-interrupted"]) });
    expect(runtime.cancel).not.toHaveBeenCalled();

    const again = await postMessages(app.url, token, body, headers);
    expect(again.status).toBe(200);
    expect(again.session).toBe(session.bridgeSessionId);
  });

  it.each([
    ["does not wind down in time", async () => false],
    ["fails", async () => { throw new Error("interrupt transport closed"); }],
  ])("fails it and kills the turn when the interrupt %s", async (_label, interrupt) => {
    runtime.interrupt = vi.fn(interrupt);
    vi.mocked(runtime.handle).mockImplementationOnce(() => never());
    const { app, token } = await bridge({ requestTimeoutMs: 60 });
    const response = await postMessages(app.url, token, body, headers);
    expect(response.status).toBe(504);
    const session = app.store.get(response.session!)!;
    await vi.waitFor(() => expect(session.state).toBe("FAILED"));
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(session.bridgeSessionId, "request-timeout");
    const again = await postMessages(app.url, token, body, headers);
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ type: "session_unavailable" });
  });

  it("answers the client at once but keeps the session busy until the turn has stopped", async () => {
    const settled = deferred<boolean>();
    runtime.interrupt = vi.fn(() => settled.promise);
    vi.mocked(runtime.handle).mockImplementationOnce(() => never());
    const { app, token } = await bridge({ requestTimeoutMs: 60 });
    const response = await postMessages(app.url, token, body, headers);
    expect(response.status).toBe(504);
    const session = app.store.get(response.session!)!;
    expect(session.state).toBe("GENERATING");
    const busy = await postMessages(app.url, token, body, headers);
    expect(busy.status).toBe(409);
    expect(busy.json.error).toMatchObject({ type: "session_busy" });
    settled.resolve(true);
    await vi.waitFor(() => expect(session.state).toBe("IDLE"));
    expect((await postMessages(app.url, token, body, headers)).status).toBe(200);
  });

  it("never lets the interrupted turn's late completion change the session", async () => {
    const late = deferred<RuntimeTurn>();
    runtime.interrupt = vi.fn(async () => true);
    vi.mocked(runtime.handle).mockReturnValueOnce(late.promise);
    const { app, token } = await bridge({ requestTimeoutMs: 60 });
    const response = await postMessages(app.url, token, body, headers);
    const session = app.store.get(response.session!)!;
    await vi.waitFor(() => expect(session.state).toBe("IDLE"));
    const before = structuredClone(session);
    late.resolve({ ...result("late"), pendingToolIds: ["late-tool"] });
    await sleep(20);
    expect(session).toEqual(before);
  });
});

describe("SSE keepalive end to end", () => {
  it("defers headers until the first content, then pings every 15 seconds until it ends", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const release = deferred<RuntimeTurn>();
    let begin: (() => void) | undefined;
    vi.mocked(runtime.handle).mockImplementationOnce((_input, sink) => { begin = () => sink?.textDelta("started"); return release.promise; });
    const { app, token } = await bridge();
    const opening = fetch(`${app.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
    });
    await vi.waitFor(() => expect(begin).toBeDefined());
    const maintenanceTimers = vi.getTimerCount();
    begin!();
    const response = await opening;
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    const read = async (until: (text: string) => boolean) => {
      while (!until(raw)) { const chunk = await reader.read(); if (chunk.done) return; raw += decoder.decode(chunk.value); }
    };
    await read((text) => text.includes("event: message_start"));
    expect(raw).not.toContain("event: ping");
    vi.advanceTimersByTime(30_000);
    const ping = 'event: ping\ndata: {"type": "ping"}\n\n';
    await read((text) => text.split(ping).length - 1 >= 2);
    expect(raw.split(ping).length - 1).toBe(2);
    release.resolve(result("done"));
    await read((text) => text.includes("event: message_stop"));
    expect(raw).toContain("event: message_stop");
    await reader.read();
    expect(vi.getTimerCount()).toBe(maintenanceTimers);
  });
});
