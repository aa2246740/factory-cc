import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeFactory from "../../src/runtime/factory.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import { BridgeError } from "../../src/types.js";
import type { BridgeRuntime, RuntimeLifecycle, RuntimeTurn } from "../../src/runtime/types.js";
import type { BridgeApp } from "../../src/http/app.js";
import { postMessages, startTestBridge } from "../helpers/server.js";

const apps: BridgeApp[] = [];
let runtime: BridgeRuntime;
const model = "relay-chat";
const first = { role: "user" as const, content: "list the files" };
const toolUse = { role: "assistant" as const, content: [{ type: "tool_use", id: "toolu_pending", name: "Read", input: {} }] };
const toolResult = { type: "tool_result", tool_use_id: "toolu_pending", content: "interrupted by the user" };
const retry = { model, max_tokens: 64, messages: [first, toolUse, { role: "user", content: [toolResult] }] };
const merged = { model, max_tokens: 64, messages: [first, toolUse, { role: "user", content: [toolResult, { type: "text", text: "never mind, summarize instead" }] }] };
const consecutive = { model, max_tokens: 64, messages: [first, toolUse, { role: "user", content: [toolResult] }, { role: "user", content: "never mind, summarize instead" }] };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function toolTurn(): RuntimeTurn {
  return {
    response: assistantMessage(model, [{ type: "tool_use", id: "toolu_pending", name: "Read", input: {} }], "tool_use"),
    pendingToolIds: ["toolu_pending"],
  };
}
function textTurn(text = "ok"): RuntimeTurn {
  return { response: assistantMessage(model, [{ type: "text", text }], "end_turn"), pendingToolIds: [] };
}

beforeEach(() => {
  runtime = {
    kind: "fake",
    handle: vi.fn(async () => textTurn()),
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

async function waitingSession() {
  vi.mocked(runtime.handle).mockResolvedValueOnce(toolTurn());
  const { app, token, config } = await startTestBridge();
  apps.push(app);
  const started = await postMessages(app.url, token, { model, max_tokens: 64, messages: [first] });
  expect(started.status).toBe(200);
  const session = app.store.get(started.session!)!;
  expect(session).toMatchObject({ state: "WAITING_DROID_TOOL", pendingToolIds: ["toolu_pending"] });
  return { app, token, config, session };
}

const cancelSession = (app: BridgeApp, sessionId: string) => fetch(`${app.url}/internal/cancel`, {
  method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" }, body: JSON.stringify({ sessionId }),
});

describe("a conversation survives the end of the session that owned its tool call", () => {
  it("answers a retried tool result with a clear 409 after cancel, and never replays the tool", async () => {
    const { app, token, session } = await waitingSession();
    expect((await cancelSession(app, session.bridgeSessionId)).status).toBe(200);
    expect(app.store.require(session.bridgeSessionId)).toMatchObject({ state: "CANCELLED", pendingToolIds: [], endedToolIds: ["toolu_pending"] });

    const retried = await postMessages(app.url, token, retry);
    expect(retried.status).toBe(409);
    expect(retried.json.error).toMatchObject({ type: "session_unavailable", message: expect.stringMatching(/cancelled, timed out or interrupted.*will not be replayed/) });
    expect(runtime.handle).toHaveBeenCalledTimes(1);
    expect(runtime.deliverResults).not.toHaveBeenCalled();
    expect(app.store.list()).toHaveLength(1);
  });

  it.each([
    ["a message merged with the tool result", merged],
    ["a message following the tool result", consecutive],
  ])("starts a new session from history for %s", async (_label, next) => {
    const { app, token, session } = await waitingSession();
    expect((await cancelSession(app, session.bridgeSessionId)).status).toBe(200);

    const resumed = await postMessages(app.url, token, next);
    expect(resumed.status).toBe(200);
    expect(resumed.session).toBeDefined();
    expect(resumed.session).not.toBe(session.bridgeSessionId);
    expect(app.store.list()).toHaveLength(2);
    const imported = vi.mocked(runtime.handle).mock.calls.at(-1)![0];
    expect(imported.session.bridgeSessionId).toBe(resumed.session);
    expect(imported.request.messages).toEqual(next.messages);
    expect(app.store.get(session.bridgeSessionId)).toMatchObject({ state: "CANCELLED", pendingToolIds: [] });
    expect(app.store.get(resumed.session!)).toMatchObject({ state: "IDLE", pendingToolIds: [] });
  });

  it("recovers the same way when the owner failed instead of being cancelled", async () => {
    const { app, token, session } = await waitingSession();
    app.store.setState(session.bridgeSessionId, "FAILED");
    expect((await postMessages(app.url, token, retry)).status).toBe(409);
    expect((await postMessages(app.url, token, merged)).status).toBe(200);
  });

  it("keeps the new conversation continuable without matching the dead one", async () => {
    const { app, token, session } = await waitingSession();
    expect((await cancelSession(app, session.bridgeSessionId)).status).toBe(200);
    const resumed = await postMessages(app.url, token, merged);
    expect(resumed.status).toBe(200);
    const next = await postMessages(app.url, token, {
      model, max_tokens: 64,
      messages: [...merged.messages, { role: "assistant", content: resumed.json.content }, { role: "user", content: "and one more thing" }],
    });
    expect(next.status).toBe(200);
    expect(next.session).toBe(resumed.session);
    expect(app.store.list()).toHaveLength(2);
  });

  it("still routes a tool result to a live session that owns it", async () => {
    const { app, token, session } = await waitingSession();
    vi.mocked(runtime.handle).mockResolvedValueOnce(textTurn("done"));
    const delivered = await postMessages(app.url, token, retry);
    expect(delivered.status).toBe(200);
    expect(delivered.session).toBe(session.bridgeSessionId);
    expect(app.store.require(session.bridgeSessionId)).toMatchObject({ state: "IDLE", pendingToolIds: [] });
  });

  it("frees the slot of a session whose wait for a Droid tool result expired", async () => {
    let lifecycle: RuntimeLifecycle | undefined;
    runtime.setLifecycle = vi.fn((value) => { lifecycle = value; });
    vi.mocked(runtime.handle).mockResolvedValueOnce(toolTurn());
    const { app, token } = await startTestBridge({ maxSessions: 1 });
    apps.push(app);
    const parked = await postMessages(app.url, token, { model, max_tokens: 64, messages: [first] });
    const another = { model, max_tokens: 64, messages: [{ role: "user", content: "a different conversation" }] };
    expect((await postMessages(app.url, token, another)).status).toBe(429);

    lifecycle!.toolWaitExpired(parked.session!);
    expect(app.store.require(parked.session!)).toMatchObject({
      state: "IDLE", hostEnded: "interrupted", pendingToolIds: [], endedToolIds: ["toolu_pending"], notes: ["tool-wait-expired"],
    });
    expect((await postMessages(app.url, token, another)).status).toBe(200);
    // Droid coming back later gets the clear answer, and the tool is not replayed.
    expect((await postMessages(app.url, token, retry)).status).toBe(409);
    expect(runtime.deliverResults).not.toHaveBeenCalled();
    expect(vi.mocked(runtime.handle)).toHaveBeenCalledTimes(2);
  });

  it("leaves a request that is still running to fail its own session when the tool wait expires", async () => {
    let lifecycle: RuntimeLifecycle | undefined;
    runtime.setLifecycle = vi.fn((value) => { lifecycle = value; });
    const release = deferred<RuntimeTurn>();
    vi.mocked(runtime.handle).mockReturnValueOnce(release.promise);
    const { app, token } = await startTestBridge();
    apps.push(app);
    const running = postMessages(app.url, token, { model, max_tokens: 64, messages: [first] });
    await vi.waitFor(() => expect(app.store.list()).toHaveLength(1));
    const [active] = app.store.list();
    lifecycle!.toolWaitExpired(active!.bridgeSessionId);
    expect(app.store.require(active!.bridgeSessionId).hostEnded).toBeUndefined();
    release.resolve(textTurn());
    expect((await running).status).toBe(200);
  });

  it("does not leave a failed turn holding its tool IDs", async () => {
    vi.mocked(runtime.handle).mockImplementationOnce(async () => { throw new BridgeError(502, "upstream_error", "provider unavailable"); });
    const { app, token } = await startTestBridge();
    apps.push(app);
    const failed = await postMessages(app.url, token, { model, max_tokens: 64, messages: [first] });
    expect(failed.status).toBe(502);
    expect(app.store.list()[0]).toMatchObject({ state: "FAILED", pendingToolIds: [] });
  });
});
