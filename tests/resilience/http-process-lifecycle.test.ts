import { afterEach, expect, it, vi } from "vitest";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig } from "../../src/config.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { SdkRuntime } from "../../src/runtime/sdk-runtime.js";
import { ProcessSdk } from "../helpers/process-sdk.js";
import { COMPACTION_SUMMARY } from "../../src/workspace.js";

const apps: BridgeApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.unstubAllEnvs(); });
async function fixture(extra = {}) {
  vi.stubEnv("BRIDGE_HTTP_PROCESS_KEY", "offline-placeholder");
  const config = loadConfig({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "relay-http-process-")), mode: "sdk", authMode: "byok", permissionMode: "bypass", maxSessions: 2, workerEndGraceMs: 20,
    clientToken: "client", adminToken: "admin", hookToken: "hook", upstreamBaseUrl: "https://offline.invalid/anthropic", upstreamModel: "offline", upstreamTokenEnv: "BRIDGE_HTTP_PROCESS_KEY", ...extra });
  const sdk = new ProcessSdk();
  const runtime = new SdkRuntime(config, { info() {}, warn() {}, error() {} }, sdk);
  const app = createBridgeApp(config, { info() {}, warn() {}, error() {} }, "", runtime); apps.push(app); await listen(app, config);
  const post = async (body: unknown, id: string = randomUUID()) => {
    const response = await fetch(`${app.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer client", "content-type": "application/json", "x-bridge-session": id }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), session: response.headers.get("x-bridge-session")! };
  };
  return { app, sdk, runtime, post, config };
}
const body = (tools: string[] = []) => ({ model: "relay-chat", max_tokens: 64, messages: [{ role: "user", content: "go" }], tools: tools.map((name) => ({ name, input_schema: { type: "object", properties: {} } })) });

it("kills the query when Droid disconnects before the first stream content", async () => {
  const { app, sdk, runtime } = await fixture(); sdk.mode = "hang";
  const client = request(`${app.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer client", "content-type": "application/json" } });
  client.on("error", () => undefined);
  client.end(JSON.stringify({ ...body(), stream: true }));
  await vi.waitFor(() => expect(sdk.children).toHaveLength(1));
  client.destroy();
  await vi.waitFor(() => expect(sdk.children[0]!.signalCode).not.toBeNull(), { timeout: 6000 });
  await vi.waitFor(() => expect(runtime.describe().slotsInUse).toBe(0), { timeout: 6000 });
});
it("releases an ended Mission worker's real query after its grace period", async () => {
  const { sdk, post, runtime } = await fixture(); sdk.mode = "tool";
  expect((await post(body(["EndFeatureRun"]))).status).toBe(200);
  await vi.waitFor(() => expect(sdk.children[0]!.signalCode).not.toBeNull(), { timeout: 6000 });
  await vi.waitFor(() => expect(runtime.describe().slotsInUse).toBe(0), { timeout: 6000 });
});
it("releases the old parked process after a confirmed Droid compaction", async () => {
  const { sdk, post, app } = await fixture(); sdk.mode = "tool";
  const old = await post(body(["StartMissionRun"]));
  expect(old.status).toBe(200);
  const summary = `<summary>\n1. **Chronological Play-by-Play**\n${"The orchestrator planned the feature and started the run.\n".repeat(8)}</summary>`;
  sdk.mode = "success"; sdk.result = summary;
  expect((await post({ ...body(), messages: [{ role: "user", content: 'Please summarize the following conversation:\n```\nUSER: go\n\nASSISTANT: Starting.\n\nTOOL_CALL: StartMissionRun input={}\n\n---\n\nTOOL: TOOL_RESULT: {"status":"paused"}\n```\nWrite the summary.' }] })).status).toBe(200);
  expect((await post({ ...body(["StartMissionRun"]), messages: [{ role: "user", content: `${COMPACTION_SUMMARY}\n${summary.replace("</summary>", "")}\nCurrent TODO List:\nContinue.` }] })).status).toBe(200);
  await vi.waitFor(() => expect(sdk.children[0]!.signalCode).not.toBeNull(), { timeout: 6000 });
  expect(app.store.require(old.session).hostEnded).toBe("interrupted");
});

it("keeps a retryable input rejection attached to its callback instead of stranding a live process on a FAILED record", async () => {
  const { sdk, post, app, runtime } = await fixture(); sdk.mode = "tool";
  const first = await post(body(["StartMissionRun"]));
  expect(first.status).toBe(200);
  const rejected = await post({ ...body(["StartMissionRun"]), messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "not-owned", content: "wrong" }] }] }, first.session);
  expect(rejected.status).toBe(409);
  expect(app.store.require(first.session).state).toBe("WAITING_DROID_TOOL");
  const call = runtime.pendingHostCalls(first.session)[0]!;
  const corrected = await post({ ...body(["StartMissionRun"]), messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: call.toolUseId, content: "done" }] }] }, first.session);
  expect(corrected.status).toBe(200);
  expect(app.store.require(first.session).state).toBe("IDLE");
  expect(sdk.children).toHaveLength(1);
});

it.each(["error", "retry"] as const)("returns backoff and accepts an exact cold-import retry after %s", async (mode) => {
  const { sdk, post, app } = await fixture(); sdk.mode = mode;
  const accepted = body();
  const failed = await post(accepted, "backoff-owner");
  expect(failed.status).toBe(mode === "retry" ? 529 : 429);
  expect(app.store.require(failed.session)).toMatchObject({ state: "IDLE", pendingToolIds: [], sdkSessionId: undefined, retryableRequestHash: expect.any(String) });
  expect(sdk.children[0]!.signalCode).not.toBeNull();
  sdk.mode = "success";
  const retried = await post(accepted, "backoff-owner");
  expect(retried.status).toBe(200); expect(retried.session).toBe(failed.session);
  expect(sdk.options[1]).not.toHaveProperty("resume");
  expect(app.store.require(failed.session).retryableRequestHash).toBeUndefined();
});

it("retries a rate-limited tool continuation from full reference history without executing its old callback again", async () => {
  const { sdk, post, runtime, app } = await fixture(); sdk.mode = "tool";
  const initial = body(["StartMissionRun"]);
  const first = await post(initial, "tool-retry");
  const call = runtime.pendingHostCalls(first.session)[0]!;
  const continuation = { ...initial, messages: [
    ...initial.messages,
    { role: "assistant", content: z.object({ content: z.array(z.unknown()) }).parse(first.body).content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: call.toolUseId, content: "completed in Droid" }] },
  ] };
  sdk.failAfterTool = true;
  expect((await post(continuation, "tool-retry")).status).toBe(429);
  expect(app.store.require(first.session).retryableRequestHash).toBeDefined();
  sdk.mode = "success";
  expect((await post(continuation, "tool-retry")).status).toBe(200);
  expect(sdk.hostToolInvocations).toBe(1);
  expect(sdk.options[1]).not.toHaveProperty("resume");
  expect(JSON.stringify(sdk.inputs.at(-1)?.message.content)).toContain("Historical tool result");
});

it("keeps SDK retry inside the native session while a real host callback is unresolved", async () => {
  const { sdk, post, runtime } = await fixture(); sdk.mode = "tool"; sdk.retryWhileTool = true;
  const first = await post(body(["StartMissionRun"]));
  expect(first.status).toBe(200);
  await vi.waitFor(() => expect(runtime.describe().upstreamBackoffs).toEqual([expect.objectContaining({ status: 529, heldForNativeWork: true })]));
  expect(sdk.children[0]!.signalCode).toBeNull();
  const call = runtime.pendingHostCalls(first.session)[0]!;
  const returned = await post({ ...body(["StartMissionRun"]), messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: call.toolUseId, content: "done" }] }] }, first.session);
  expect(returned.status).toBe(200);
  expect(sdk.children).toHaveLength(1);
});

it("allows an exact retry after startup timeout without leaving a process or rejecting the session forever", async () => {
  const { sdk, post, app } = await fixture({ authMode: "subscription", sdkStartTimeoutMs: 250 });
  sdk.account = "timeout";
  const first = await post(body(), "start-retry");
  expect(first.status).toBe(503);
  expect(app.store.require(first.session).state).toBe("IDLE");
  expect(sdk.children[0]!.signalCode).not.toBeNull();
  sdk.account = "ok";
  expect((await post(body(), "start-retry")).status).toBe(200);
});
