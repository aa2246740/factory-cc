import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeFactory from "../../src/runtime/factory.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import { MISSION_SPAWN_TOOLS } from "../../src/runtime/mission-tools.js";
import type { BridgeRuntime, RuntimeHostCall, RuntimeTurn } from "../../src/runtime/types.js";
import type { BridgeApp } from "../../src/http/app.js";
import { postMessages, startTestBridge } from "../helpers/server.js";

const apps: BridgeApp[] = [];
let runtime: BridgeRuntime;
let calls: Map<string, RuntimeHostCall[]>;
const model = "relay-chat";
const HOUR = 60 * 60 * 1000;
const request = (text: string, extra: Record<string, unknown> = {}) => ({ model, max_tokens: 64, messages: [{ role: "user", content: text }], ...extra });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function toolTurn(id: string, name: string): RuntimeTurn {
  return {
    response: assistantMessage(model, [{ type: "tool_use", id, name, input: {} }], "tool_use"),
    pendingToolIds: [id],
  };
}
function textTurn(text = "ok"): RuntimeTurn {
  return { response: assistantMessage(model, [{ type: "text", text }], "end_turn"), pendingToolIds: [] };
}

beforeEach(() => {
  calls = new Map();
  runtime = {
    kind: "sdk",
    handle: vi.fn(async () => textTurn()),
    cancel: vi.fn(async () => undefined),
    deliverResults: vi.fn(async () => []),
    pendingHostCalls: vi.fn((sessionId: string) => calls.get(sessionId) ?? []),
    close: vi.fn(async () => undefined),
  };
  vi.spyOn(runtimeFactory, "createRuntime").mockReturnValue(runtime);
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  vi.restoreAllMocks();
});

async function bridge(overrides: Parameters<typeof startTestBridge>[0] = {}) {
  const started = await startTestBridge(overrides);
  apps.push(started.app);
  return started;
}

/** Park a conversation on a Droid tool, then pretend nothing has happened to it for `idleMs`. */
async function park(app: BridgeApp, token: string, label: string, options: { idleMs?: number; tool?: string; content?: string } = {}) {
  const toolUseId = `toolu_${label}`;
  const name = options.tool ?? "TaskOutput";
  vi.mocked(runtime.handle).mockResolvedValueOnce(toolTurn(toolUseId, name));
  const response = await postMessages(app.url, token, request(options.content ?? `start ${label}`), { "x-bridge-session": label });
  expect(response.status).toBe(200);
  const sessionId = response.session!;
  calls.set(sessionId, [{ toolUseId, toolName: name, input: {} }]);
  expect(app.store.require(sessionId)).toMatchObject({ state: "WAITING_DROID_TOOL", pendingToolIds: [toolUseId] });
  if (options.idleMs !== undefined) app.store.require(sessionId).updatedAt = new Date(Date.now() - options.idleMs).toISOString();
  return { sessionId, toolUseId };
}
const fresh = (text = "a brand new conversation") => request(text);
const returnResult = (label: string) => ({
  model, max_tokens: 64,
  messages: [
    { role: "user", content: `start ${label}` },
    { role: "assistant", content: [{ type: "tool_use", id: `toolu_${label}`, name: "TaskOutput", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${label}`, content: "finally done" }] },
  ],
});

describe("a parked session is reclaimed only when its slot is needed", () => {
  it("is left alone while slots are free, however long it has been idle, and still takes its result", async () => {
    const { app, token } = await bridge({ maxSessions: 4 });
    const parked = await park(app, token, "a", { idleMs: 5 * HOUR });
    expect((await postMessages(app.url, token, fresh())).status).toBe(200);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(app.store.require(parked.sessionId)).toMatchObject({ state: "WAITING_DROID_TOOL", pendingToolIds: [parked.toolUseId] });
    vi.mocked(runtime.handle).mockResolvedValueOnce(textTurn("done"));
    const delivered = await postMessages(app.url, token, returnResult("a"));
    expect(delivered.status).toBe(200);
    expect(delivered.session).toBe(parked.sessionId);
    expect(app.store.require(parked.sessionId)).toMatchObject({ state: "IDLE", pendingToolIds: [] });
  });

  it("gives up the least recently active eligible session, one per refused request, and admits the new one", async () => {
    const { app, token, config } = await bridge({ maxSessions: 2 });
    const oldest = await park(app, token, "a", { idleMs: 3 * HOUR });
    const older = await park(app, token, "b", { idleMs: 2 * HOUR });
    expect((await postMessages(app.url, token, fresh())).status).toBe(200);

    expect(app.store.require(oldest.sessionId)).toMatchObject({
      state: "IDLE", hostEnded: "interrupted", pendingToolIds: [], endedToolIds: [oldest.toolUseId], notes: ["session-reclaimed"],
    });
    expect(app.store.require(older.sessionId)).toMatchObject({ state: "WAITING_DROID_TOOL", pendingToolIds: [older.toolUseId] });
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(oldest.sessionId, "session-reclaimed");
    const logged = readFileSync(join(config.logDir, "bridge.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; data?: { sessionId: string; idleMs: number } });
    const reclaimed = logged.filter((entry) => entry.event === "session_reclaimed");
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.data).toMatchObject({ sessionId: oldest.sessionId });
    expect(reclaimed[0]!.data!.idleMs).toBeGreaterThanOrEqual(3 * HOUR);

    // Another parked conversation now fills the slot again. The next refusal skips
    // the one that has only just parked and takes the one that has been idle.
    const newest = await park(app, token, "c");
    expect((await postMessages(app.url, token, fresh("one more"))).status).toBe(200);
    expect(app.store.require(older.sessionId)).toMatchObject({ state: "IDLE", hostEnded: "interrupted" });
    expect(app.store.require(newest.sessionId).state).toBe("WAITING_DROID_TOOL");
    expect(runtime.cancel).toHaveBeenCalledTimes(2);
  });

  it("also frees a slot for an idle conversation that resumes", async () => {
    const { app, token } = await bridge({ maxSessions: 1 });
    const resumed = await postMessages(app.url, token, request("first turn"), { "x-bridge-session": "idle-conversation" });
    expect(app.store.require(resumed.session!).state).toBe("IDLE");
    const parked = await park(app, token, "parked", { idleMs: 2 * HOUR });
    const again = await postMessages(app.url, token, request("second turn"), { "x-bridge-session": "idle-conversation" });
    expect(again.status).toBe(200);
    expect(again.session).toBe(resumed.session);
    expect(app.store.require(parked.sessionId)).toMatchObject({ state: "IDLE", hostEnded: "interrupted" });
  });

  it("answers the result Droid later returns for a reclaimed session with the clear 409, without replaying the tool", async () => {
    const { app, token } = await bridge({ maxSessions: 1 });
    const parked = await park(app, token, "a", { idleMs: 2 * HOUR });
    expect((await postMessages(app.url, token, fresh())).status).toBe(200);
    const handled = vi.mocked(runtime.handle).mock.calls.length;
    const late = await postMessages(app.url, token, returnResult("a"));
    expect(late.status).toBe(409);
    expect(late.json.error).toMatchObject({ type: "session_unavailable", message: expect.stringMatching(/will not be replayed/) });
    expect(vi.mocked(runtime.handle).mock.calls).toHaveLength(handled);
    expect(runtime.deliverResults).not.toHaveBeenCalled();
    expect(app.store.require(parked.sessionId).pendingToolIds).toEqual([]);
  });
});

describe("a session that is still in use is never reclaimed; the request gets the 429", () => {
  async function expectRefused(app: BridgeApp, token: string, sessionId: string, expectedState = "WAITING_DROID_TOOL") {
    const refused = await postMessages(app.url, token, fresh());
    expect(refused.status).toBe(429);
    expect(refused.json.error).toMatchObject({ type: "session_limit" });
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(app.store.require(sessionId)).toMatchObject({ state: expectedState });
    expect(app.store.require(sessionId).hostEnded).toBeUndefined();
  }

  it("has been idle for less than BRIDGE_TOOL_WAIT_TIMEOUT_MS", async () => {
    const { app, token } = await bridge({ maxSessions: 1, toolWaitTimeoutMs: 60_000 });
    const parked = await park(app, token, "a", { idleMs: 59_000 });
    await expectRefused(app, token, parked.sessionId);
    app.store.require(parked.sessionId).updatedAt = new Date(Date.now() - 61_000).toISOString();
    expect((await postMessages(app.url, token, fresh())).status).toBe(200);
    expect(app.store.require(parked.sessionId).hostEnded).toBe("interrupted");
  });

  it("measures idleness from its last activity, so a recent result keeps it", async () => {
    const { app, token } = await bridge({ maxSessions: 1, toolWaitTimeoutMs: 60_000 });
    const parked = await park(app, token, "a", { idleMs: 5 * HOUR });
    vi.mocked(runtime.handle).mockResolvedValueOnce(toolTurn("toolu_a2", "TaskOutput"));
    // Droid answers the first tool and the session parks on the next one: that is activity.
    expect((await postMessages(app.url, token, returnResult("a"))).status).toBe(200);
    expect(app.store.require(parked.sessionId)).toMatchObject({ state: "WAITING_DROID_TOOL", pendingToolIds: ["toolu_a2"] });
    await expectRefused(app, token, parked.sessionId);
  });

  it.each(MISSION_SPAWN_TOOLS)("is waiting on %s, whose Mission workers can run for hours", async (tool) => {
    const { app, token } = await bridge({ maxSessions: 1 });
    const parked = await park(app, token, "mission", { idleMs: 6 * HOUR, tool });
    await expectRefused(app, token, parked.sessionId);
  });

  it("is waiting on a Mission tool among several pending tools", async () => {
    const { app, token } = await bridge({ maxSessions: 1 });
    const parked = await park(app, token, "mixed", { idleMs: 6 * HOUR });
    calls.set(parked.sessionId, [
      { toolUseId: "toolu_other", toolName: "Execute", input: {} },
      { toolUseId: parked.toolUseId, toolName: "StartMissionRun", input: {} },
    ]);
    await expectRefused(app, token, parked.sessionId);
  });

  it("is bound to a live Factory host, which releases it with its own end event", async () => {
    const { app, token, config } = await bridge({ maxSessions: 1 });
    const cwd = process.env.BRIDGE_SDK_CWD || config.sdkCwd;
    const started = await fetch(`${app.url}/internal/host-events`, {
      method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ eventId: "reclaim-start", event: { hook_event_name: "SessionStart", session_id: "factory-live", cwd, source: "startup" } }),
    });
    const marker = ((await started.json()) as { additionalContext: string }).additionalContext;
    const parked = await park(app, token, "bound", { idleMs: 6 * HOUR, content: `${marker} start bound` });
    expect(app.store.require(parked.sessionId).factorySessionId).toBe("factory-live");
    await expectRefused(app, token, parked.sessionId);
  });

  it("has a request in flight, even though it was parked and long idle", async () => {
    const { app, token } = await bridge({ maxSessions: 1 });
    const parked = await park(app, token, "a", { idleMs: 6 * HOUR });
    const release = deferred<RuntimeTurn>();
    const started = deferred<void>();
    vi.mocked(runtime.handle).mockImplementationOnce(async () => { started.resolve(); return release.promise; });
    const resuming = postMessages(app.url, token, returnResult("a"));
    await started.promise;
    await expectRefused(app, token, parked.sessionId, "RESUMING");
    release.resolve(textTurn("done"));
    expect((await resuming).status).toBe(200);
    expect(app.store.require(parked.sessionId)).toMatchObject({ state: "IDLE", pendingToolIds: [] });
  });

  it("belongs to a runtime that cannot say what it is waiting on", async () => {
    delete runtime.pendingHostCalls;
    const { app, token } = await bridge({ maxSessions: 1 });
    const parked = await park(app, token, "a", { idleMs: 6 * HOUR });
    await expectRefused(app, token, parked.sessionId);
  });

  it("is not parked on a tool at all but still generating", async () => {
    const { app, token } = await bridge({ maxSessions: 1 });
    const release = deferred<RuntimeTurn>();
    const started = deferred<void>();
    vi.mocked(runtime.handle).mockImplementationOnce(async () => { started.resolve(); return release.promise; });
    const generating = postMessages(app.url, token, request("long answer"), { "x-bridge-session": "busy" });
    await started.promise;
    const [busy] = app.store.list();
    busy!.updatedAt = new Date(Date.now() - 6 * HOUR).toISOString();
    await expectRefused(app, token, busy!.bridgeSessionId, "GENERATING");
    release.resolve(textTurn());
    expect((await generating).status).toBe(200);
  });
});
