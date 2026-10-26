import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { CursorSdkRuntime } from "../../src/runtime/cursor/sdk-runtime.js";
import { cursorMenuFromCatalog } from "../../src/runtime/cursor/catalog.js";
import { cursorLiveCatalogFixture } from "../../src/runtime/cursor/fixture.js";
import type { CursorAgentApi, CursorAgentLike, CursorRunLike } from "../../src/runtime/cursor/agent-api.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
const runtimes: CursorSdkRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); });
function fixture(api: CursorAgentApi) {
  const config = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "cursor-cleanup-")), authMode: "subscription", mode: "sdk", maxSessions: 1,
    models: cursorMenuFromCatalog(cursorLiveCatalogFixture, "default") });
  const runtime = new CursorSdkRuntime(config, { info() {}, warn() {}, error() {} }, { api, env: {}, interruptGraceMs: 20 }); runtimes.push(runtime); return runtime;
}
function input(id = "one"): RuntimeRequest {
  return { request: { model: "cursor:composer-2.5", max_tokens: 16, messages: [{ role: "user", content: "go" }] }, headers: {}, role: "chat",
    session: { bridgeSessionId: id, provider: "cursor", model: "cursor:composer-2.5", role: "chat", state: "NEW", createdAt: "", updatedAt: "", pendingToolIds: [], toolNames: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true } } };
}
const never = () => new Promise<void>(() => undefined);
it("closes agents and releases a hung cancellation within a bounded time", async () => {
  const close = vi.fn();
  const run: CursorRunLike = { id: "run", status: "running", cancel: never, wait: () => new Promise(() => undefined) };
  const agent: CursorAgentLike = { agentId: "agent", close, async send() { return run; } };
  const runtime = fixture({ async create() { return agent; }, async resume() { return agent; }, cancelRun: never });
  const handling = runtime.handle(input()); void handling.catch(() => undefined);
  await vi.waitFor(() => expect(runtime.describe().agents).toBe(1));
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.cancel("one", "disconnect");
  await expect(handling).rejects.toMatchObject({ code: "cancelled" });
  expect(close).toHaveBeenCalledOnce();
  expect(runtime.describe().agents).toBe(0);
});
it("closes a late agent creation after the request was cancelled", async () => {
  let created!: (agent: CursorAgentLike) => void;
  const creating = new Promise<CursorAgentLike>((resolve) => { created = resolve; });
  const close = vi.fn();
  const api: CursorAgentApi = { create: vi.fn(() => creating), resume: vi.fn(() => creating) };
  const runtime = fixture(api);
  const handling = runtime.handle(input()); void handling.catch(() => undefined);
  await vi.waitFor(() => expect(api.create).toHaveBeenCalled());
  await runtime.cancel("one", "disconnect");
  await expect(handling).rejects.toMatchObject({ code: "cancelled" });
  created({ agentId: "late", close, async send() { throw new Error("must not send"); } });
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(runtime.describe().agents).toBe(0);
});
it("closes an agent on a failed upstream request and preserves rate limit status", async () => {
  const close = vi.fn();
  const agent: CursorAgentLike = { agentId: "agent", close, async send() { throw Object.assign(new Error("rate_limit_error"), { status: 429 }); } };
  const runtime = fixture({ async create() { return agent; }, async resume() { return agent; } });
  await expect(runtime.handle(input())).rejects.toMatchObject({ status: 429, code: "rate_limit_error" });
  expect(close).toHaveBeenCalledOnce();
  expect(runtime.describe().agents).toBe(0);
});
it("evicts a checkpointed idle agent under slot pressure and resumes later", async () => {
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  const create = async () => {
    const close = vi.fn(); closes.push(close);
    return { agentId: `agent-${closes.length}`, close, async send() { return { id: "run", status: "finished" as const, async cancel() {}, async wait() { return { status: "finished" as const, result: "ok" }; } }; } };
  };
  const resume = vi.fn(create);
  const runtime = fixture({ create, resume });
  const turn = await runtime.handle(input());
  await runtime.handle(input("two"));
  expect(closes[0]).toHaveBeenCalledOnce();
  const returning = input(); returning.session.sdkSessionId = turn.sdkSessionId;
  await runtime.handle(returning);
  expect(resume).toHaveBeenCalledWith(turn.sdkSessionId, expect.any(Object));
  expect(runtime.describe().agents).toBe(1);
});

it("deletes only an expired agent checkpoint through the SDK store and disposes its handle", async () => {
  const deletes = vi.fn(async (_input: { filter: { agentIds: [string] } }) => undefined);
  const dispose = vi.fn(async () => undefined);
  const config = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "cursor-store-prune-")), authMode: "subscription", mode: "sdk", models: cursorMenuFromCatalog(cursorLiveCatalogFixture, "default") });
  const agent: CursorAgentLike = { agentId: "expired-agent", close() {}, async send() { return { id: "run", status: "finished", async cancel() {}, async wait() { return { status: "finished", result: "ok" }; } }; } };
  const runtime = new CursorSdkRuntime(config, { info() {}, warn() {}, error() {} }, { api: { async create() { return agent; }, async resume() { return agent; } }, env: {},
    openStore: async () => ({ agents: { delete: deletes }, dispose }) }); runtimes.push(runtime);
  await runtime.handle(input());
  await runtime.forget({ bridgeSessionId: "one", sdkSessionId: "expired-agent", provider: "cursor" });
  expect(deletes).toHaveBeenCalledExactlyOnceWith({ filter: { agentIds: ["expired-agent"] } });
  await runtime.forget({ bridgeSessionId: "shared", provider: "cursor" });
  expect(deletes).toHaveBeenCalledTimes(1);
  await runtime.close(); expect(dispose).toHaveBeenCalledOnce();
});
