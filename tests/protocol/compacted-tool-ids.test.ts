import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeFactory from "../../src/runtime/factory.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import { collectLatestToolResults } from "../../src/protocol/content.js";
import { BridgeError, type Message, type MessagesRequest } from "../../src/types.js";
import type { BridgeApp } from "../../src/http/app.js";
import type { BridgeRuntime, RuntimeHostCall } from "../../src/runtime/types.js";
import { postMessages, startTestBridge } from "../helpers/server.js";

const apps: BridgeApp[] = [];
const model = "relay-chat";
const tools = ["Read", "Execute"].map((name) => ({ name, input_schema: { type: "object" } }));
const summary = `<summary>\n${"The earlier completed checks and original user constraints remain in force. ".repeat(5)}\n</summary>`;
const nativeId = "native-current-execute";
const desktopId = "call_0123456789abcdef_0";
const input = { command: "actual current operation", riskLevel: "low" };
const summarizerSystem = "Summarize this conversation or agent trajectory so the assistant can continue effectively after compaction.\nReturn the summary inside <summary> tags.";
const original: MessagesRequest = { model, max_tokens: 64, tools, messages: [
  { role: "user", content: "Original context before the retained portion." },
  { role: "assistant", content: [{ type: "tool_use", id: "earlier-read", name: "Read", input: { path: "retained-receipt.txt" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "earlier-read", content: "Actual earlier local data." }] },
  { role: "assistant", content: "The earlier operation finished." },
  { role: "user", content: "Continue the same existing operation." },
] };
let runtime: BridgeRuntime;
let calls: Map<string, RuntimeHostCall[]>;

beforeEach(() => {
  calls = new Map();
  runtime = {
    kind: "sdk",
    handle: vi.fn(async (request) => {
      const results = collectLatestToolResults(request.request.messages);
      if (results.some((result) => result.tool_use_id !== nativeId)) throw new BridgeError(409, "unknown_tool_use_id", results[0].tool_use_id);
      calls.delete(request.session.bridgeSessionId);
      return { response: assistantMessage(model, [{ type: "text", text: "Real native callback continued." }], "end_turn"), pendingToolIds: [] };
    }),
    pendingHostCalls: (sessionId) => calls.get(sessionId) ?? [],
    cancel: vi.fn(async () => undefined), deliverResults: vi.fn(async () => []), close: vi.fn(async () => undefined),
  };
  vi.spyOn(runtimeFactory, "createRuntime").mockReturnValue(runtime);
});
afterEach(async () => { while (apps.length) await apps.pop()!.close(); vi.restoreAllMocks(); });

async function fixture() {
  const { app, token } = await startTestBridge(); apps.push(app);
  vi.mocked(runtime.handle).mockImplementationOnce(async (request) => {
    calls.set(request.session.bridgeSessionId, [{ toolUseId: nativeId, toolName: "Execute", input }]);
    return { response: assistantMessage(model, [{ type: "tool_use", id: nativeId, name: "Execute", input }], "tool_use"), pendingToolIds: [nativeId], sdkSessionId: "same-native-worker" };
  });
  const first = await postMessages(app.url, token, original);
  expect(first.status, first.raw).toBe(200);
  return { app, token, sessionId: first.session! };
}
async function produceSummary(app: BridgeApp, token: string, repeatedCurrentCall = false) {
  vi.mocked(runtime.handle).mockResolvedValueOnce({ response: assistantMessage(model, [{ type: "text", text: summary }], "end_turn"), pendingToolIds: [] });
  // The summarizer consumes only the removed prefix. It does not show the
  // current Execute callback, which remains in Droid's retained tail.
  const renderedCall = repeatedCurrentCall ? `Execute input=${JSON.stringify(input)}` : 'Read input={"path":"old-prefix.txt"}';
  const response = await postMessages(app.url, token, { model, max_tokens: 2048, messages: [{ role: "user", content: `Summarize the removed prefix:\nASSISTANT: TOOL_CALL: ${renderedCall}\nTOOL: TOOL_RESULT: old prefix result` }] });
  expect(response.status).toBe(200);
}
function compacted(): MessagesRequest {
  return { ...original, messages: [
    { role: "user", content: `You summarized the conversation thus far earlier in this session, as follows:\n\n${summary}` },
    { role: "user", content: "<system-reminder>\nUser system info (fixture)\n% pwd\n/tmp\n</system-reminder>" },
    ...original.messages.slice(1),
    { role: "assistant", content: [{ type: "tool_use", id: desktopId, name: "Execute", input }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: desktopId, content: "Genuine current execution result." }] },
  ] };
}

describe("renamed worker callbacks across host compaction", () => {
  it.each(["failed", "cancelled"])("rejects replay after the first aliased continuation is %s", async (ending) => {
    const { app, token, sessionId } = await fixture(); await produceSummary(app, token);
    vi.mocked(runtime.handle).mockImplementationOnce(async () => {
      if (ending === "cancelled") app.store.setState(sessionId, "CANCELLED");
      throw new BridgeError(ending === "cancelled" ? 499 : 500, ending, "The native continuation ended.");
    });
    const first = await postMessages(app.url, token, compacted());
    expect(first.status).toBe(ending === "cancelled" ? 499 : 500);
    const replay = await postMessages(app.url, token, compacted());
    expect(replay.status, replay.raw).toBe(409);
    expect(replay.json.error).toMatchObject({ type: "session_unavailable" });
    expect(runtime.handle).toHaveBeenCalledTimes(3);
  });

  it("restores a rejected alias continuation so the real callback can be retried", async () => {
    const { app, token, sessionId } = await fixture(); await produceSummary(app, token);
    runtime.isSessionUsable = () => true;
    vi.mocked(runtime.handle).mockRejectedValueOnce(new BridgeError(422, "invalid_tool_result", "Retry the original genuine result."));
    expect((await postMessages(app.url, token, compacted())).status).toBe(422);
    const next = await postMessages(app.url, token, compacted());
    expect(next.status, next.raw).toBe(200); expect(next.session).toBe(sessionId);
  });

  it("keeps a compacted callback before an assistant separator and a new user instruction", async () => {
    const { app, token, sessionId } = await fixture(); await produceSummary(app, token);
    const request = compacted();
    request.messages.push({ role: "assistant", content: "The previous response ended." }, { role: "user", content: "Also report the next step." });
    const next = await postMessages(app.url, token, request);
    expect(next.status, next.raw).toBe(200); expect(next.session).toBe(sessionId);
    const delivered = vi.mocked(runtime.handle).mock.calls.at(-1)?.[0];
    expect(delivered?.session.sdkSessionId).toBe("same-native-worker");
    expect(delivered?.request.messages[7]?.content).toEqual([{ type: "tool_result", tool_use_id: nativeId, content: "Genuine current execution result." }]);
    expect(delivered?.request.messages.at(-1)?.content).toEqual([{ type: "text", text: "Also report the next step." }]);
    expect(runtime.cancel).not.toHaveBeenCalledWith(sessionId, expect.anything());
  });

  it.each(["environment-only", "worker-startup"])("continues when the removed %s prefix contains no tool calls", async (kind) => {
    const { app, token, sessionId } = await fixture();
    vi.mocked(runtime.handle).mockResolvedValueOnce({ response: assistantMessage(model, [{ type: "text", text: summary }], "end_turn"), pendingToolIds: [] });
    const transcript = kind === "environment-only" ? "USER: [System reminder omitted at compaction boundary.]" : "USER: [System reminder omitted at compaction boundary.]\n\nUSER: The worker startup instructions remain in force.";
    const produced = await postMessages(app.url, token, { model, max_tokens: 2048, system: summarizerSystem, messages: [{ role: "user", content: `Please summarize the following conversation:\n\`\`\`\n${transcript}\n\`\`\`\n\nRemember to wrap your final summary in <summary> tags.` }] });
    expect(produced.status, produced.raw).toBe(200);
    const next = await postMessages(app.url, token, compacted());
    expect(next.status, next.raw).toBe(200); expect(next.session).toBe(sessionId);
    const delivered = vi.mocked(runtime.handle).mock.calls.at(-1)?.[0];
    expect(delivered?.session.sdkSessionId).toBe("same-native-worker");
    expect(delivered?.request.messages.at(-1)?.content).toEqual([{ type: "tool_result", tool_use_id: nativeId, content: "Genuine current execution result." }]);
    expect(runtime.cancel).not.toHaveBeenCalledWith(sessionId, expect.anything());
  });

  it.each(["ordinary-reply", "missing-summary-system", "tools-enabled"])("does not treat %s as a compaction receipt", async (kind) => {
    const { app, token, sessionId } = await fixture();
    vi.mocked(runtime.handle).mockResolvedValueOnce({ response: assistantMessage(model, [{ type: "text", text: summary }], "end_turn"), pendingToolIds: [] });
    const produced = await postMessages(app.url, token, { model, max_tokens: 2048,
      ...(kind !== "missing-summary-system" ? { system: summarizerSystem } : {}),
      ...(kind === "tools-enabled" ? { tools } : {}),
      messages: [{ role: "user", content: kind === "ordinary-reply" ? "Write a title for this conversation." : "Please summarize the following conversation:\n```\nUSER: Startup instructions.\n```\n\nRemember to wrap your final summary in <summary> tags." }],
    });
    expect(produced.status, produced.raw).toBe(200);
    const next = await postMessages(app.url, token, compacted());
    expect(next.status).toBe(409);
    expect(app.store.require(sessionId).state).toBe("WAITING_DROID_TOOL");
    expect(runtime.cancel).not.toHaveBeenCalledWith(sessionId, expect.anything());
  });

  it("keeps the same native worker when its Bridge-produced summary and complete retained tail prove continuity", async () => {
    const { app, token, sessionId } = await fixture(); await produceSummary(app, token);
    const next = await postMessages(app.url, token, compacted());
    expect(next.status, next.raw).toBe(200); expect(next.session).toBe(sessionId);
    const delivered = vi.mocked(runtime.handle).mock.calls.at(-1)?.[0];
    expect(delivered?.session.sdkSessionId).toBe("same-native-worker");
    expect(delivered?.request.messages.at(-1)?.content).toEqual([{ type: "tool_result", tool_use_id: nativeId, content: "Genuine current execution result." }]);
    expect(runtime.cancel).not.toHaveBeenCalledWith(sessionId, expect.anything());
  });

  it("prefers the proven live callback over releasing a same-input older call quoted in the summarized prefix", async () => {
    const { app, token, sessionId } = await fixture(); await produceSummary(app, token, true);
    const next = await postMessages(app.url, token, compacted());
    expect(next.status, next.raw).toBe(200); expect(next.session).toBe(sessionId);
    expect(runtime.cancel).not.toHaveBeenCalledWith(sessionId, expect.anything());
  });

  it("rejects two native conversations with the same retained tail instead of guessing from their different removed prefixes", async () => {
    const { app, token, sessionId } = await fixture();
    vi.mocked(runtime.handle).mockImplementationOnce(async (request) => {
      calls.set(request.session.bridgeSessionId, [{ toolUseId: nativeId, toolName: "Execute", input }]);
      return { response: assistantMessage(model, [{ type: "tool_use", id: nativeId, name: "Execute", input }], "tool_use"), pendingToolIds: [nativeId] };
    });
    const other = await postMessages(app.url, token, { ...original, messages: [{ role: "user", content: "Other original context." }, ...original.messages.slice(1)] }, { "x-bridge-session": "different-conversation" });
    expect(other.status).toBe(200); await produceSummary(app, token);
    const next = await postMessages(app.url, token, compacted());
    expect(next.status).toBe(409); expect(next.json.error).toMatchObject({ type: "ambiguous_session" });
    expect(app.store.require(sessionId).state).toBe("WAITING_DROID_TOOL");
    expect(runtime.cancel).not.toHaveBeenCalledWith(sessionId, expect.anything());
  });

  it.each(["unproduced-summary", "changed-summary", "changed-tail", "changed-input", "unretained-user-text", "short-tail"])("does not infer callback ownership for %s", async (kind) => {
    const { app, token, sessionId } = await fixture();
    if (kind !== "unproduced-summary") await produceSummary(app, token);
    const request = compacted();
    if (kind === "changed-summary") request.messages[0] = { role: "user", content: String(request.messages[0].content).replace("earlier", "different") };
    if (kind === "changed-tail") request.messages[3] = { role: "user", content: [{ type: "tool_result", tool_use_id: "earlier-read", content: "Changed historical data." }] };
    if (kind === "changed-input") request.messages[6] = { role: "assistant", content: [{ type: "tool_use", id: desktopId, name: "Execute", input: { command: "different operation" } }] };
    if (kind === "unretained-user-text") request.messages[1] = { role: "user", content: "Unproven new task instructions." };
    if (kind === "short-tail") request.messages.splice(2, 2);
    const next = await postMessages(app.url, token, request);
    expect(next.status).toBe(409);
    expect(app.store.require(sessionId).state).toBe("WAITING_DROID_TOOL");
    expect(runtime.cancel).not.toHaveBeenCalledWith(sessionId, expect.anything());
  });
});
