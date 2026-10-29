import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeFactory from "../../src/runtime/factory.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import type { BridgeRuntime, RuntimeHostCall, RuntimeRequest, RuntimeTurn } from "../../src/runtime/types.js";
import type { BridgeApp } from "../../src/http/app.js";
import { COMPACTION_SUMMARY } from "../../src/workspace.js";
import { postMessages, startTestBridge } from "../helpers/server.js";

const apps: BridgeApp[] = [];
let runtime: BridgeRuntime;
let calls: Map<string, RuntimeHostCall[]>;
const model = "relay-chat";
const tools = [{ name: "StartMissionRun", input_schema: { type: "object", properties: {} } }];
const missionRun = { message: "Start mission workers for the current feature now." };
const SUMMARY = `<summary>\n1. **Chronological Play-by-Play**\n${"   • The orchestrator planned the feature, created the artifacts and started the run.\n".repeat(4)}</summary>`;

const text = (value: string): RuntimeTurn => ({ response: assistantMessage(model, [{ type: "text", text: value }], "end_turn"), pendingToolIds: [] });
/** Like Droid's summarizer: the transcript as text, its last tool call answered. */
const summarizer = (call: { name: string; input: unknown }) => ({ model, max_tokens: 4096, messages: [{ role: "user", content:
  `Please summarize the following conversation:\n\`\`\`\nUSER: run the mission\n\nASSISTANT: Starting.\n\nTOOL_CALL: ${call.name} input=${JSON.stringify(call.input)}\n\n---\n\nTOOL: TOOL_RESULT: {"status":"paused"}\n\`\`\`\nWrite the summary.` }] });
/** Like Droid after compacting: a new first message quoting the summary, without its closing tag. */
const continuation = (summary = SUMMARY) => ({ model, max_tokens: 64, tools, messages: [{ role: "user", content: [
  { type: "text", text: `${COMPACTION_SUMMARY}\n${summary.replace("</summary>", "")}\nCurrent TODO List:\nin_progress [high] Finish the feature` },
  { type: "text", text: "Continue." },
] }] });
const released = (logDir: string) => (existsSync(join(logDir, "bridge.jsonl")) ? readFileSync(join(logDir, "bridge.jsonl"), "utf8").trim().split("\n") : [])
  .map((line) => JSON.parse(line) as { event: string; data?: Record<string, unknown> }).filter((entry) => entry.event === "compacted_session_released").map((entry) => entry.data);

beforeEach(() => {
  calls = new Map();
  runtime = {
    kind: "sdk",
    handle: vi.fn(async () => text("ok")),
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

async function bridge() {
  const started = await startTestBridge();
  apps.push(started.app);
  return started;
}
/** An orchestrator conversation waiting on StartMissionRun while Droid runs the workers. */
async function parkOrchestrator(app: BridgeApp, token: string, label: string, input: unknown = missionRun, name = "StartMissionRun") {
  const toolUseId = `toolu_${label}`;
  vi.mocked(runtime.handle).mockImplementationOnce(async (request: RuntimeRequest) => {
    calls.set(request.session.bridgeSessionId, [{ toolUseId, toolName: name, input }]);
    return { response: assistantMessage(model, [{ type: "tool_use", id: toolUseId, name, input: input as Record<string, string> }], "tool_use"), pendingToolIds: [toolUseId] };
  });
  const response = await postMessages(app.url, token, { model, max_tokens: 64, tools: [{ name, input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: `run the mission ${label}` }] });
  expect(response.status).toBe(200);
  return { sessionId: response.session!, toolUseId };
}
async function compact(app: BridgeApp, token: string, call: { name: string; input: unknown } = { name: "StartMissionRun", input: missionRun }, summary = SUMMARY) {
  vi.mocked(runtime.handle).mockResolvedValueOnce(text(summary));
  expect((await postMessages(app.url, token, summarizer(call))).status).toBe(200);
}

describe("a conversation Droid compacted away while it waited on a tool", () => {
  it("releases the answered TaskOutput rendered with Droid's ASSISTANT prefix", async () => {
    const { app, token } = await bridge();
    const input = { task_id: "fixture-review", block: true };
    const old = await parkOrchestrator(app, token, "task-output", input, "TaskOutput");
    vi.mocked(runtime.handle).mockResolvedValueOnce(text(SUMMARY));
    const request = summarizer({ name: "TaskOutput", input });
    request.messages[0]!.content = request.messages[0]!.content.replace("TOOL_CALL: TaskOutput", "ASSISTANT: TOOL_CALL: TaskOutput");
    expect((await postMessages(app.url, token, request)).status).toBe(200);
    expect(runtime.cancel).not.toHaveBeenCalled();

    expect((await postMessages(app.url, token, continuation())).status).toBe(200);
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(old.sessionId, "compacted-by-droid");
    expect(app.store.require(old.sessionId)).toMatchObject({ state: "IDLE", pendingToolIds: [], endedToolIds: [old.toolUseId] });
  });

  it("ignores tool-call text inside a result when linking the answered outer call", async () => {
    const { app, token } = await bridge();
    const input = { task_id: "fixture-review", block: true };
    const old = await parkOrchestrator(app, token, "outer-output", input, "TaskOutput");
    vi.mocked(runtime.handle).mockResolvedValueOnce(text(SUMMARY));
    const request = summarizer({ name: "TaskOutput", input });
    request.messages[0]!.content = request.messages[0]!.content
      .replace("TOOL_CALL: TaskOutput", "ASSISTANT: TOOL_CALL: TaskOutput")
      .replace('TOOL: TOOL_RESULT: {"status":"paused"}', 'TOOL: TOOL_RESULT: {"status":"done"}\nTOOL_CALL: Execute input={"command":"nested fixture text"}\nTOOL_RESULT: nested fixture result');
    expect((await postMessages(app.url, token, request)).status).toBe(200);
    expect((await postMessages(app.url, token, continuation())).status).toBe(200);
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(old.sessionId, "compacted-by-droid");
  });

  it("keeps an active Mission when another tool result only quotes its pending call", async () => {
    const { app, token } = await bridge();
    const old = await parkOrchestrator(app, token, "still-running");
    vi.mocked(runtime.handle).mockResolvedValueOnce(text(SUMMARY));
    const request = summarizer({ name: "Execute", input: { command: "fixture command" } });
    request.messages[0]!.content = request.messages[0]!.content
      .replace("TOOL_CALL: Execute", "ASSISTANT: TOOL_CALL: Execute")
      .replace('TOOL: TOOL_RESULT: {"status":"paused"}', `TOOL: TOOL_RESULT: nested transcript\nTOOL_CALL: StartMissionRun input=${JSON.stringify(missionRun)}\nTOOL_RESULT: nested transcript result`);
    expect((await postMessages(app.url, token, request)).status).toBe(200);
    expect((await postMessages(app.url, token, continuation())).status).toBe(200);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(app.store.require(old.sessionId).state).toBe("WAITING_DROID_TOOL");
  });

  it("is released when Droid continues with the summary this Bridge produced, before the new one takes a slot", async () => {
    const { app, token, config } = await bridge();
    const old = await parkOrchestrator(app, token, "old");
    await compact(app, token);
    // The summary alone proves nothing: Droid might still fail to compact.
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(app.store.require(old.sessionId).state).toBe("WAITING_DROID_TOOL");

    const next = await postMessages(app.url, token, continuation());
    expect(next.status).toBe(200);
    expect(next.session).not.toBe(old.sessionId);
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(old.sessionId, "compacted-by-droid");
    expect(app.store.require(old.sessionId)).toMatchObject({ state: "IDLE", hostEnded: "interrupted", pendingToolIds: [], endedToolIds: [old.toolUseId], notes: ["compacted-by-droid"] });
    expect(released(config.logDir)).toEqual([{ sessionId: old.sessionId, toolUseIds: [old.toolUseId] }]);
  });

  it("is kept when the continuation quotes some other summary", async () => {
    const { app, token } = await bridge();
    const old = await parkOrchestrator(app, token, "old");
    await compact(app, token);
    expect((await postMessages(app.url, token, continuation(SUMMARY.replace("planned", "abandoned")))).status).toBe(200);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(app.store.require(old.sessionId).state).toBe("WAITING_DROID_TOOL");
  });

  it("is kept when two conversations wait on the same call, since the summary cannot tell them apart", async () => {
    const { app, token } = await bridge();
    const first = await parkOrchestrator(app, token, "first");
    const second = await parkOrchestrator(app, token, "second");
    await compact(app, token);
    expect((await postMessages(app.url, token, continuation())).status).toBe(200);
    expect(runtime.cancel).not.toHaveBeenCalled();
    for (const parked of [first, second]) expect(app.store.require(parked.sessionId).state).toBe("WAITING_DROID_TOOL");
  });

  it("is kept when the summary's last answered call is not the one it waits on", async () => {
    const { app, token } = await bridge();
    const old = await parkOrchestrator(app, token, "old");
    await compact(app, token, { name: "StartMissionRun", input: { message: "a different run" } });
    expect((await postMessages(app.url, token, continuation())).status).toBe(200);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(app.store.require(old.sessionId).state).toBe("WAITING_DROID_TOOL");
  });

  it("matches the waiting call whatever the key order Droid wrote", async () => {
    const { app, token } = await bridge();
    const input = { message: "go", milestone: "m1" };
    const old = await parkOrchestrator(app, token, "old", input);
    await compact(app, token, { name: "StartMissionRun", input: { milestone: "m1", message: "go" } });
    expect((await postMessages(app.url, token, continuation())).status).toBe(200);
    expect(runtime.cancel).toHaveBeenCalledExactlyOnceWith(old.sessionId, "compacted-by-droid");
  });
});
