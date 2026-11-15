import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as runtimeFactory from "../../src/runtime/factory.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import type { BridgeApp } from "../../src/http/app.js";
import type { BridgeRuntime } from "../../src/runtime/types.js";
import type { ContentBlock } from "../../src/types.js";
import { postMessages, startTestBridge } from "../helpers/server.js";
import { contentFromSse } from "../helpers/sse.js";

const apps: BridgeApp[] = [];
const nativeId = "toolu_offline_script_status";
const input = { toolCallId: "call_existing_host_script_2", action: "status" };
const project = realpathSync(mkdtempSync(join(tmpdir(), "relay-desktop-tool-id-project-")));
const body = { model: "claude-opus-5-5", max_tokens: 64, tools: [{ name: "WaitForScript", input_schema: { type: "object" } }], messages: [{ role: "user", content: [
  { type: "text", text: `<system-reminder>\nUser system info (fixture)\n% pwd\n${project}\n</system-reminder>` },
  { type: "text", text: "Continue the existing Mission." },
] }] };
let runtime: BridgeRuntime;

beforeEach(() => {
  runtime = {
    kind: "sdk",
    handle: vi.fn(async () => ({
      response: assistantMessage(body.model, [{ type: "tool_use", id: nativeId, name: "WaitForScript", input }], "tool_use"),
      pendingToolIds: [nativeId], sdkSessionId: "offline-native-checkpoint",
    })),
    cancel: vi.fn(async () => undefined), deliverResults: vi.fn(async () => []), close: vi.fn(async () => undefined),
  };
  vi.spyOn(runtimeFactory, "createRuntime").mockReturnValue(runtime);
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  vi.restoreAllMocks();
});

describe("Droid desktop tool identity compatibility", () => {
  it.each([false, true])("delivers a genuine result after Droid rewrites the response tool ID (stream=%s)", async (stream) => {
    const { app, token } = await startTestBridge({ desktopProfile: true, dataDir: join(project, "state", "bridge-data") });
    apps.push(app);
    const response = await fetch(`${app.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...body, stream }),
    });
    const raw = await response.text();
    expect(response.status, raw).toBe(200);
    const content: ContentBlock[] = stream ? contentFromSse(raw) : JSON.parse(raw).content;
    const call = content.find((block) => block.type === "tool_use");
    if (!call || call.type !== "tool_use") throw new Error("Expected the pending script-status call");
    expect(call.input).toEqual(input);
    const desktopId = "call_0123456789abcdef_0";
    const desktopContent = content.map((block) => block.type === "tool_use" ? { ...block, id: desktopId } : block);
    vi.mocked(runtime.handle).mockImplementationOnce(async () => ({ response: assistantMessage(body.model, [{ type: "text", text: "Existing Mission continued." }], "end_turn"), pendingToolIds: [], sdkSessionId: "offline-native-checkpoint" }));
    const next = await postMessages(app.url, token, { ...body, messages: [...body.messages, { role: "assistant", content: desktopContent }, { role: "user", content: [{ type: "tool_result", tool_use_id: desktopId, content: "Actual script completed." }] }] });
    expect(next.status).toBe(200);
    expect(next.session).toBe(response.headers.get("x-bridge-session"));
    expect(app.store.list()).toHaveLength(1);
    const delivered = vi.mocked(runtime.handle).mock.calls[1]?.[0];
    expect(delivered?.session.sdkSessionId).toBe("offline-native-checkpoint");
    expect(delivered?.request.messages.at(-1)?.content).toEqual([{ type: "tool_result", tool_use_id: nativeId, content: "Actual script completed." }]);
    expect(app.store.list()[0]?.state).toBe("IDLE");
  });

  it("keeps identical native IDs in different conversations isolated and rejects cross-session results", async () => {
    const { app, token } = await startTestBridge({ desktopProfile: true, dataDir: join(project, "state", "bridge-data") });
    apps.push(app);
    const first = await postMessages(app.url, token, body, { "x-bridge-session": "desktop-a" });
    const second = await postMessages(app.url, token, body, { "x-bridge-session": "desktop-b" });
    expect(first.status, first.raw).toBe(200);
    expect(second.status, second.raw).toBe(200);
    const callA = JSON.parse(first.raw).content[0];
    const callB = JSON.parse(second.raw).content[0];
    expect(callA.id).toBe(nativeId);
    expect(callB.id).toBe(nativeId);
    const desktopId = "call_0123456789abcdef_0";
    const mixed = await postMessages(app.url, token, { ...body, messages: [...body.messages, { role: "assistant", content: [{ ...callA, id: desktopId }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: desktopId, content: "Not owned by desktop-b." }] }] }, { "x-bridge-session": "desktop-b" });
    expect(mixed.status).toBe(409);
    expect(mixed.json.error).toMatchObject({ type: "cross_session_tool_result" });
    expect(runtime.handle).toHaveBeenCalledTimes(2);
  });

  it("does not replay an aliased result after its original native session ended", async () => {
    const { app, token } = await startTestBridge({ desktopProfile: true, dataDir: join(project, "state", "bridge-data") });
    apps.push(app);
    const first = await postMessages(app.url, token, body);
    expect(first.status, first.raw).toBe(200);
    const call = JSON.parse(first.raw).content[0];
    if (!first.session) throw new Error("Expected a native session");
    app.store.setState(first.session, "CANCELLED");
    const desktopId = "call_0123456789abcdef_0";
    const retry = await postMessages(app.url, token, { ...body, messages: [...body.messages, { role: "assistant", content: [{ ...call, id: desktopId }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: desktopId, content: "Old result must not replay." }] }] });
    expect(retry.status).toBe(409);
    expect(retry.json.error).toMatchObject({ type: "session_unavailable" });
    expect(runtime.handle).toHaveBeenCalledTimes(1);
  });
});
