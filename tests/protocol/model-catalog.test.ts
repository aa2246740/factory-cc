import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postMessages, startTestBridge } from "../helpers/server.js";
import type { BridgeApp } from "../../src/http/app.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import { modelsFromIds } from "../../src/models.js";
import { BridgeError } from "../../src/types.js";

const runtime = vi.hoisted(() => ({ kind: "sdk", handle: vi.fn(), cancel: vi.fn(async () => undefined), deliverResults: vi.fn() }));
vi.mock("../../src/runtime/factory.js", () => ({ createRuntime: () => runtime }));
const apps: BridgeApp[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  runtime.handle.mockImplementation(async ({ request }: RuntimeRequest) => ({
    response: assistantMessage(request.model, [{ type: "text", text: "remembered" }], "end_turn"),
    pendingToolIds: [], sdkSessionId: "same-native-session",
  }));
});
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });
async function start() {
  const result = await startTestBridge({ mode: "sdk", authMode: "subscription", models: modelsFromIds(["sonnet", "haiku"], "subscription") });
  apps.push(result.app); return result;
}
const headers = { "x-bridge-session": "factory-conversation" };
const request = (model: string, text = "remember this") => ({ model, max_tokens: 32, messages: [{ role: "user", content: text }] });

describe("HTTP model selection", () => {
  it("publishes authenticated actual model choices without provider secrets", async () => {
    const { app, token } = await start();
    expect((await fetch(`${app.url}/v1/models`)).status).toBe(401);
    const response = await fetch(`${app.url}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(await response.json()).toEqual({ data: [
      { id: "sonnet", display_name: "Claude Sonnet", type: "model" },
      { id: "haiku", display_name: "Claude Haiku", type: "model" },
    ], has_more: false, first_id: "sonnet", last_id: "haiku" });
    expect(runtime.handle).not.toHaveBeenCalled();
  });
  it("rejects old role aliases before creating a session or native query", async () => {
    const { app, token } = await start();
    const result = await postMessages(app.url, token, request("relay-worker"), headers);
    expect(result.status).toBe(400); expect(result.json).toMatchObject({ error: { type: "unknown_model" } });
    expect(app.store.list()).toHaveLength(0); expect(runtime.handle).not.toHaveBeenCalled();
  });
  it("keeps a conversation identity when selecting another actual model", async () => {
    const { app, token } = await start();
    const first = await postMessages(app.url, token, request("sonnet"), headers);
    const second = await postMessages(app.url, token, request("haiku", "recall it"), headers);
    expect([first.status, second.status]).toEqual([200, 200]); expect(second.session).toBe(first.session);
    expect(app.store.list()).toHaveLength(1);
    expect(app.store.get(first.session!)).toMatchObject({ model: "haiku", sdkSessionId: "same-native-session", state: "IDLE" });
    expect(runtime.handle.mock.calls.map(([input]) => input.request.model)).toEqual(["sonnet", "haiku"]);
  });
  it.each(["model_switch_busy", "model_switch_requires_persistence", "model_switch_unavailable"])("leaves the original conversation usable after %s", async (code) => {
    const { app, token } = await start();
    const first = await postMessages(app.url, token, request("sonnet"), headers);
    const previous = structuredClone(app.store.get(first.session!)!);
    runtime.handle.mockRejectedValueOnce(new BridgeError(409, code, "Cannot switch yet"));
    expect((await postMessages(app.url, token, request("haiku", "recall it"), headers)).status).toBe(409);
    expect(app.store.get(first.session!)).toMatchObject({ state: "IDLE", model: "sonnet", contextHash: previous.contextHash,
      requestMessageHashes: previous.requestMessageHashes, historyMessageHashes: previous.historyMessageHashes });
    const retry = await postMessages(app.url, token, request("sonnet", "continue"), headers);
    expect(retry.status).toBe(200); expect(retry.session).toBe(first.session);
  });
  it("ends an unsafe native switch instead of restoring a damaged query", async () => {
    const { app, token } = await start();
    const first = await postMessages(app.url, token, request("sonnet"), headers);
    runtime.handle.mockRejectedValueOnce(new BridgeError(502, "model_switch_failed", "Cannot close old query"));
    expect((await postMessages(app.url, token, request("haiku"), headers)).status).toBe(502);
    expect(app.store.get(first.session!)?.state).toBe("FAILED");
  });
  it("does not overwrite a normal host exit arriving during a refused switch", async () => {
    const { app, token } = await start();
    const first = await postMessages(app.url, token, request("sonnet"), headers);
    runtime.handle.mockImplementationOnce(async () => {
      app.store.update(first.session!, { hostEnded: "resumable", state: "IDLE", notes: ["host-ended"] });
      throw new BridgeError(409, "model_switch_busy", "Host ended while switching");
    });
    expect((await postMessages(app.url, token, request("haiku"), headers)).status).toBe(409);
    expect(app.store.get(first.session!)).toMatchObject({ hostEnded: "resumable", state: "IDLE", notes: ["host-ended"] });
  });
});


it("desktop rejects missing cwd before session creation and isolates different project directories", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-desktop-http-")));
  const one = join(root, "one"), two = join(root, "two"); mkdirSync(one); mkdirSync(two);
  const { app, token } = await startTestBridge({ desktopProfile: true, dataDir: join(root, "state/bridge-data") });
  apps.push(app);
  // Droid's main requests advertise tools; only those need its project reminder.
  const tools = [{ name: "Execute", input_schema: { type: "object" } }];
  const missing = await postMessages(app.url, token, { ...request("sonnet"), tools }, { "x-bridge-cwd": one });
  expect(missing.status).toBe(400); expect(missing.json).toMatchObject({ error: { type: "invalid_project_directory", message: expect.stringContaining("Open a project folder in Droid") } });
  expect(app.store.list()).toHaveLength(0); expect(runtime.handle).not.toHaveBeenCalled();
  const body = (cwd: string) => ({ model: "sonnet", max_tokens: 32, tools, messages: [{ role: "user", content: [
    { type: "text", text: `<system-reminder>\nUser system info (fixture)\n% pwd\n${cwd}\n</system-reminder>` },
    { type: "text", text: "hello" },
  ] }] });
  const first = await postMessages(app.url, token, body(one), headers);
  expect(first.status).toBe(200);
  const switched = await postMessages(app.url, token, body(two), headers);
  expect(switched.status).toBe(409); expect(switched.json).toMatchObject({ error: { type: "session_context_changed" } });
  const fresh = await postMessages(app.url, token, body(two), { "x-bridge-session": "another-project" });
  expect(fresh.status).toBe(200); expect(app.store.list()).toHaveLength(2);
  // A tool-free request, such as Droid's compaction summary, needs no project.
  const summary = await postMessages(app.url, token, { ...request("sonnet"), tools: [] }, { "x-bridge-session": "summary" });
  expect(summary.status).toBe(200);
});
