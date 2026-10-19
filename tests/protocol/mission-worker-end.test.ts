import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeFactory from "../../src/runtime/factory.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import type { BridgeRuntime, RuntimeControl, RuntimeHostCall, RuntimeRequest, RuntimeTurn } from "../../src/runtime/types.js";
import type { BridgeApp } from "../../src/http/app.js";
import { postMessages, startTestBridge } from "../helpers/server.js";

const apps: BridgeApp[] = [];
let runtime: BridgeRuntime;
let control: RuntimeControl | undefined;
let calls: Map<string, RuntimeHostCall[]>;
const model = "relay-chat";
const GRACE = 120_000;
/** Only the Bridge's timers are controlled; sockets and fetch keep running for real. */
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const released = (logDir: string) => (existsSync(join(logDir, "bridge.jsonl")) ? readFileSync(join(logDir, "bridge.jsonl"), "utf8").trim().split("\n") : [])
  .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> }).filter((entry) => entry.event === "mission_worker_released").map((entry) => entry.data);

function toolTurn(id: string, name: string): RuntimeTurn {
  return { response: assistantMessage(model, [{ type: "tool_use", id, name, input: {} }], "tool_use"), pendingToolIds: [id] };
}
/** The runtime reports what it waits on as it publishes the tool, like the SDK runtime does. */
function parksOn(id: string, name: string) {
  return async (input: RuntimeRequest) => {
    calls.set(input.session.bridgeSessionId, [{ toolUseId: id, toolName: name, input: {} }]);
    return toolTurn(id, name);
  };
}
const history = (tool: string, result?: { content: string; is_error?: boolean }) => ({
  model, max_tokens: 64,
  messages: [
    { role: "user", content: "implement the feature" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_end", name: tool, input: {} }] },
    ...(result ? [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_end", ...result }] }] : []),
  ],
});

beforeEach(() => {
  calls = new Map();
  control = undefined;
  runtime = {
    kind: "sdk",
    handle: vi.fn(async () => ({ response: assistantMessage(model, [{ type: "text", text: "ok" }], "end_turn"), pendingToolIds: [] })),
    cancel: vi.fn(async () => undefined),
    deliverResults: vi.fn(async () => []),
    pendingHostCalls: vi.fn((sessionId: string) => calls.get(sessionId) ?? []),
    setControl: (next) => { control = next; },
    close: vi.fn(async () => undefined),
  };
  vi.spyOn(runtimeFactory, "createRuntime").mockReturnValue(runtime);
});
afterEach(async () => {
  vi.useRealTimers();
  while (apps.length) await apps.pop()!.close();
  vi.restoreAllMocks();
});

async function park(tool: string) {
  const started = await startTestBridge({ workerEndGraceMs: GRACE });
  apps.push(started.app);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.mocked(runtime.handle).mockImplementationOnce(parksOn("toolu_end", tool));
  const response = await postMessages(started.app.url, started.token, { model, max_tokens: 64, messages: [history(tool).messages[0]] });
  expect(response.status).toBe(200);
  const sessionId = response.session!;
  expect(started.app.store.require(sessionId)).toMatchObject({ state: "WAITING_DROID_TOOL", pendingToolIds: ["toolu_end"] });
  return { ...started, sessionId };
}

describe("a Mission worker whose EndFeatureRun Droid never answers", () => {
  it("has its native process released after the grace period, and a late result gets the clear 409", async () => {
    const { app, token, config, sessionId } = await park("EndFeatureRun");
    await advance(GRACE - 1);
    expect(runtime.cancel).not.toHaveBeenCalled();
    await advance(1);
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(sessionId, "mission-worker-ended");
    expect(app.store.require(sessionId)).toMatchObject({ state: "IDLE", hostEnded: "interrupted", pendingToolIds: [], endedToolIds: ["toolu_end"], notes: ["mission-worker-ended"] });
    expect(released(config.logDir)).toEqual([{ sessionId, toolUseIds: ["toolu_end"], graceMs: GRACE, generation: 1 }]);
    // Droid's result arriving after the release (as a loaded test runner can make it) is not replayed.
    const handled = vi.mocked(runtime.handle).mock.calls.length;
    const late = await postMessages(app.url, token, history("EndFeatureRun", { content: "Error: handoff is required", is_error: true }));
    expect(late.status).toBe(409);
    expect(late.json.error).toMatchObject({ type: "session_unavailable", message: expect.stringMatching(/will not be replayed/) });
    expect(vi.mocked(runtime.handle).mock.calls).toHaveLength(handled);
  });

  it("keeps working when EndFeatureRun comes back with an error, and the first timer never releases the retry", async () => {
    const { app, token, config, sessionId } = await park("EndFeatureRun");
    await advance(GRACE * 0.9);
    // Droid rejects the first attempt; the worker fixes its arguments and ends again.
    vi.mocked(runtime.handle).mockImplementationOnce(parksOn("toolu_end_retry", "EndFeatureRun"));
    const retried = await postMessages(app.url, token, history("EndFeatureRun", { content: "Error: handoff is required", is_error: true }));
    expect(retried.status).toBe(200);
    expect(retried.session).toBe(sessionId);
    expect(app.store.require(sessionId)).toMatchObject({ state: "WAITING_DROID_TOOL", pendingToolIds: ["toolu_end_retry"] });
    // Well past the first attempt's deadline, short of the retry's own.
    await advance(GRACE * 0.6);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(released(config.logDir)).toEqual([]);
    await advance(GRACE * 0.4);
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(sessionId, "mission-worker-ended");
    expect(released(config.logDir)).toEqual([{ sessionId, toolUseIds: ["toolu_end_retry"], graceMs: GRACE, generation: 2 }]);
  });

  it("is never released while waiting on any other Droid tool, such as a command awaiting approval", async () => {
    const { app, sessionId } = await park("Execute");
    await advance(GRACE * 3);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(app.store.require(sessionId)).toMatchObject({ state: "WAITING_DROID_TOOL", pendingToolIds: ["toolu_end"] });
  });

  it("is not released while EndFeatureRun shares the turn with another pending tool", async () => {
    const { app, sessionId } = await park("EndFeatureRun");
    calls.set(sessionId, [{ toolUseId: "toolu_end", toolName: "EndFeatureRun", input: {} }, { toolUseId: "toolu_cmd", toolName: "Execute", input: {} }]);
    await advance(GRACE * 3);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(app.store.require(sessionId).state).toBe("WAITING_DROID_TOOL");
  });

  it("is not released while a native approval for it is outstanding", async () => {
    const { app, sessionId } = await park("EndFeatureRun");
    const abort = new AbortController();
    const decision = control!.requestApproval({ bridgeSessionId: sessionId, toolName: "Bash", input: { command: "true" }, signal: abort.signal });
    await advance(GRACE * 3);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(app.store.require(sessionId).state).toBe("WAITING_DROID_TOOL");
    abort.abort();
    await decision;
  });
});
