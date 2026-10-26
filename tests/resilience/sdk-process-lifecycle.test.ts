import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { SdkRuntime } from "../../src/runtime/sdk-runtime.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import { ProcessSdk } from "../helpers/process-sdk.js";

const runtimes: SdkRuntime[] = [];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); vi.unstubAllEnvs(); });
function fixture(overrides = {}) {
  vi.stubEnv("BRIDGE_PROCESS_TEST_KEY", "offline-placeholder");
  const config = loadConfig({ mode: "sdk", dataDir: mkdtempSync(join(tmpdir(), "relay-process-")), authMode: "byok", permissionMode: "bypass",
    upstreamBaseUrl: "https://offline.invalid/anthropic", upstreamModel: "offline", upstreamTokenEnv: "BRIDGE_PROCESS_TEST_KEY",
    persistSessions: true, maxSessions: 1, requestTimeoutMs: 5000, ...overrides });
  const sdk = new ProcessSdk();
  const runtime = new SdkRuntime(config, logger, sdk);
  runtimes.push(runtime);
  return { runtime, sdk, config };
}
function input(id = "one", model = "relay"): RuntimeRequest {
  return { request: { model, max_tokens: 16, messages: [{ role: "user", content: "go" }] }, role: "chat", headers: {},
    session: { bridgeSessionId: id, role: "chat", state: "NEW", model, toolNames: [], pendingToolIds: [], notes: [], cancelRequested: false, createdAt: "", updatedAt: "", usage: { input_tokens: 0, output_tokens: 0, estimated: true } } };
}
const dead = (sdk: ProcessSdk) => sdk.children.every((child) => child.exitCode !== null || child.signalCode !== null);

it.each(["cancel", "host-end", "shutdown"])("verifies process death on %s", async (path) => {
  const { runtime, sdk } = fixture();
  await runtime.handle(input());
  if (path === "cancel") await runtime.cancel("one", "disconnect");
  if (path === "host-end") expect((await runtime.endHostSession("one", "SessionEnd")).resumable).toBe(true);
  if (path === "shutdown") await runtime.close();
  expect(dead(sdk)).toBe(true);
  expect(runtime.describe().slotsInUse).toBe(0);
});

it("evicts the oldest idle process before admission and resumes its native checkpoint", async () => {
  const { runtime, sdk } = fixture();
  const first = await runtime.handle(input());
  await runtime.handle(input("two"));
  expect(sdk.children[0]!.signalCode).not.toBeNull();
  expect(runtime.describe().slotsInUse).toBe(1);
  const request = input(); request.request.messages[0]!.content = "next";
  await runtime.handle(request);
  expect(sdk.options[2]!.resume).toBe(first.sdkSessionId);
  expect(sdk.children[1]!.signalCode).not.toBeNull();
  expect(runtime.describe().slotsInUse).toBe(1);
});

it.each(["model", "reasoning"])("kills the retired process before %s resume", async (path) => {
  const { runtime, sdk } = fixture({ models: [{ id: "a", model: "a", displayName: "a" }, { id: "b", model: "b", displayName: "b" }] });
  const first = await runtime.handle(input("one", "a"));
  const next = input("one", path === "model" ? "b" : "a");
  if (path === "reasoning") next.request.output_config = { effort: "low" };
  await runtime.handle(next);
  expect(sdk.children[0]!.signalCode).not.toBeNull();
  expect(sdk.options[1]!.resume).toBe(first.sdkSessionId);
});

it.each(["timeout", "rejected"])("cleans the failed auth/start path: %s", async (account) => {
  // No ambient credential is used: subscription rejects this fake API account.
  const { runtime, sdk } = fixture({ authMode: "subscription", sdkStartTimeoutMs: 250 });
  sdk.account = account === "timeout" ? "timeout" : "rejected";
  await expect(runtime.handle(input())).rejects.toMatchObject({ code: account === "timeout" ? "sdk_start_timeout" : "auth_mode_mismatch" });
  expect(dead(sdk)).toBe(true);
  expect(runtime.describe().slotsInUse).toBe(0);
});

it("maps an upstream rate limit and frees its real process and slot", async () => {
  const { runtime, sdk } = fixture(); sdk.mode = "error";
  await expect(runtime.handle(input())).rejects.toMatchObject({ status: 429, code: "rate_limit_error", extra: { retry_after: 7 } });
  expect(dead(sdk)).toBe(true);
  expect(runtime.describe().slotsInUse).toBe(0);
});

it("refuses excess live work immediately without evicting a tool callback", async () => {
  const { runtime, sdk } = fixture(); sdk.mode = "tool";
  const first = input(); first.request.tools = [{ name: "StartMissionRun", input_schema: { type: "object", properties: {} } }];
  expect((await runtime.handle(first)).pendingToolIds).toHaveLength(1);
  await expect(runtime.handle(input("two"))).rejects.toMatchObject({ status: 429 });
  expect(sdk.children).toHaveLength(1);
  expect(sdk.children[0]!.signalCode).toBeNull();
  await runtime.cancel("one", "cancel pending callback");
  expect(dead(sdk)).toBe(true);
});


it("caps warm idle queries before the physical slot limit and fences a returning session during retirement", async () => {
  const { runtime, sdk } = fixture({ maxSessions: 8, maxIdleSessions: 1 });
  const first = await runtime.handle(input());
  await runtime.handle(input("two"));
  // Returning immediately races the background idle-pool trim. The old process
  // must die before this query can resume, even though its session is now busy.
  const next = input(); next.request.messages[0]!.content = "return now";
  await runtime.handle(next);
  expect(sdk.children[0]!.signalCode).not.toBeNull();
  expect(sdk.options[2]!.resume).toBe(first.sdkSessionId);
  await runtime.maintain();
  expect(runtime.describe().activeNativeSessions).toBe(1);
});
