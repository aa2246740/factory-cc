import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import type { Logger } from "../../src/logging.js";
import type { CursorAgentApi, CursorRunLike, CursorRunResult, CursorSendOptions } from "../../src/runtime/cursor/agent-api.js";
import { cursorMenuFromCatalog } from "../../src/runtime/cursor/catalog.js";
import { writeCursorCredential } from "../../src/runtime/cursor/credentials.js";
import { applyCursorUpdate, emptyCursorDraft } from "../../src/runtime/cursor/events.js";
import { cursorCatalogFixture } from "../../src/runtime/cursor/fixture.js";
import { installCursorRejectionGuard } from "../../src/runtime/cursor/sdk-load.js";
import { CursorSdkRuntime } from "../../src/runtime/cursor/sdk-runtime.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { MessagesRequest } from "../../src/types.js";

const dirs: string[] = [];
const logger: Logger = { info() {}, warn() {}, error() {} };
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

function config(): BridgeConfig {
  const dir = mkdtempSync(join(tmpdir(), "cursor-runtime-"));
  dirs.push(dir);
  return loadConfig({
    dataDir: dir, mode: "sdk", authMode: "subscription",
    models: [{ id: "sonnet", model: "sonnet", displayName: "Claude Sonnet" }, ...cursorMenuFromCatalog(cursorCatalogFixture, "default")],
  });
}

function session(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    bridgeSessionId: "bridge-cursor", role: "chat", state: "IDLE", model: "cursor:composer-2.5", provider: "cursor",
    toolNames: ["Execute"], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [],
    usage: { input_tokens: 0, output_tokens: 0, estimated: true }, ...patch,
  };
}

function input(record: SessionRecord, request: MessagesRequest): RuntimeRequest {
  return { request, role: "chat", session: record, headers: { "x-bridge-role": "chat" } };
}

function userTurn(text: string, model = "cursor:composer-2.5"): MessagesRequest {
  return { model, max_tokens: 32, tools: [{ name: "Execute", input_schema: { type: "object" } }], messages: [{ role: "user", content: text }] };
}

interface FakeCursor {
  api: CursorAgentApi;
  created: Array<Record<string, unknown>>;
  resumed: string[];
  sends: string[];
  whenSent(): Promise<void>;
}

function fakeCursor(script: {
  onSend?: (options: CursorSendOptions | undefined) => Promise<void> | void;
  wait?: () => Promise<CursorRunResult>;
  cancel?: (run: CursorRunLike) => Promise<void>;
} = {}): FakeCursor {
  const created: Array<Record<string, unknown>> = [];
  const resumed: string[] = [];
  const sends: string[] = [];
  const waiters: Array<() => void> = [];
  const build = () => ({
    agentId: "agent-1",
    close: vi.fn(),
    send: vi.fn(async (message: string | { text: string }, options?: CursorSendOptions) => {
      sends.push(typeof message === "string" ? message : message.text);
      await script.onSend?.(options);
      const run: CursorRunLike = {
        id: "run-1",
        status: "running",
        cancel: vi.fn(async () => { if (script.cancel) await script.cancel(run); else run.status = "cancelled"; }),
        wait: async () => {
          const result = script.wait ? await script.wait() : { status: "finished" as const, result: "Hello", usage: { inputTokens: 2, outputTokens: 3 } };
          run.status = result.status;
          return result;
        },
      };
      waiters.splice(0).forEach((resolve) => resolve());
      return run;
    }),
  });
  const api: CursorAgentApi = {
    create: vi.fn(async (options: Record<string, unknown>) => { created.push(options); return build(); }),
    resume: vi.fn(async (agentId: string) => { resumed.push(agentId); return build(); }),
    cancelRun: vi.fn(async () => undefined),
  };
  return { api, created, resumed, sends, whenSent: () => new Promise((resolve) => waiters.push(resolve)) };
}

describe("CursorSdkRuntime", () => {
  it("installs one rejection guard and only ignores sandbox helper failures", () => {
    const listeners: Array<(reason: unknown) => void> = [];
    const target = { on: (_event: string, listener: (reason: unknown) => void) => { listeners.push(listener); } };
    installCursorRejectionGuard(target);
    installCursorRejectionGuard(target);
    expect(listeners).toHaveLength(1);
    expect(() => listeners[0]?.(new Error("spawn dump_zsh_state ENOENT"))).not.toThrow();
    expect(() => listeners[0]?.(new Error("real failure"))).toThrow(/real failure/);
  });

  it("maps text, thinking and tool updates", () => {
    const draft = emptyCursorDraft();
    applyCursorUpdate(draft, { type: "thinking-delta", text: "hmm" });
    applyCursorUpdate(draft, { type: "text-delta", text: "Hello" });
    applyCursorUpdate(draft, { type: "tool-call-started", callId: "call-1", toolCall: { type: "mcp", args: { toolName: "Execute", providerIdentifier: "custom-user-tools", args: { cmd: "pwd" } } } });
    applyCursorUpdate(draft, { type: "step-completed" });
    applyCursorUpdate(draft, { type: "ignored-future-event" });
    expect(draft.blocks).toEqual([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Hello" },
      { type: "tool_use", id: "call-1", name: "mcp__droid__Execute", input: { cmd: "pwd" } },
    ]);
  });

  it("tells Droid to log in again when the stored Cursor key is expired", async () => {
    const cfg = config();
    writeCursorCredential(cfg.dataDir, { version: 1, apiKey: "expired-cursor-key", createdAtMs: 1, apiKeyExpiresAtMs: 1_000 });
    const fake = fakeCursor();
    const runtime = new CursorSdkRuntime(cfg, logger, { api: fake.api, env: {}, now: () => 2_000 });
    await expect(runtime.handle(input(session(), userTurn("hi")))).rejects.toThrow(/npm run desktop -- cursor login/);
    expect(fake.api.create).not.toHaveBeenCalled();
  });

  it("tells Droid to log in again when Cursor rejects the key", async () => {
    const rejected = new Error("invalid api key");
    rejected.name = "AuthenticationError";
    const fake = fakeCursor({ onSend: () => { throw rejected; } });
    const runtime = new CursorSdkRuntime(config(), logger, { api: fake.api, env: { CURSOR_API_KEY: "live-key" } });
    await expect(runtime.handle(input(session(), userTurn("hi")))).rejects.toThrow(/npm run desktop -- cursor login/);
    const failed = fakeCursor({ wait: async () => ({ status: "error", error: { message: "unauthorized: the api key is revoked" } }) });
    const again = new CursorSdkRuntime(config(), logger, { api: failed.api, env: { CURSOR_API_KEY: "live-key" } });
    await expect(again.handle(input(session(), userTurn("hi")))).rejects.toMatchObject({ code: "cursor_auth", message: expect.stringMatching(/npm run desktop -- cursor login/) });
    const other = fakeCursor({ wait: async () => ({ status: "error", error: { message: "model overloaded" } }) });
    const runtimeOther = new CursorSdkRuntime(config(), logger, { api: other.api, env: { CURSOR_API_KEY: "live-key" } });
    await expect(runtimeOther.handle(input(session(), userTurn("hi")))).rejects.toMatchObject({ code: "cursor_run_failed", message: "model overloaded" });
  });

  it("creates an agent with pinned parameters and no system prompt", async () => {
    const fake = fakeCursor({
      onSend: async (options) => {
        await options?.onDelta?.({ update: { type: "thinking-delta", text: "hmm" } });
        await options?.onDelta?.({ update: { type: "text-delta", text: "Hello" } });
      },
    });
    const runtime = new CursorSdkRuntime(config(), logger, { api: fake.api, env: {} });
    const turn = await runtime.handle(input(session(), userTurn("Say hello")), { textDelta() {}, toolTrace() {} });
    const options = fake.created[0] as { tools: string[]; systemPrompt?: string; model: { id: string; params: unknown }; local: { settingSources?: unknown; customTools: Record<string, unknown> } };
    expect(fake.resumed).toEqual([]);
    expect(options.tools).toEqual(["read", "grep", "glob", "ls", "mcp"]);
    expect(options.systemPrompt).toBeUndefined();
    expect(options.local.settingSources).toBeUndefined();
    expect(options.model).toEqual({ id: "composer-2.5", params: [{ id: "fast", value: "false" }] });
    expect(options.local.customTools.Execute).toBeTypeOf("object");
    expect(fake.sends[0]).toContain("Say hello");
    expect(turn.response.content).toEqual([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Hello" }]);
    expect(turn.response.usage).toMatchObject({ input_tokens: 2, output_tokens: 3, estimated: false });
    expect(turn.sdkSessionId).toBe("agent-1");
    expect(JSON.stringify(runtime.describe())).not.toMatch(/sk-|apiKey/);
  });

  it("traces native reads by their cursor names and keeps them off the desktop custom-tool list", async () => {
    const traces: string[] = [];
    const fake = fakeCursor({
      onSend: async (options) => {
        await options?.onDelta?.({ update: { type: "tool-call-started", callId: "call-r", toolCall: { type: "read", args: { path: "sum.js" } } } });
        await options?.onDelta?.({ update: { type: "text-delta", text: "a - b" } });
      },
    });
    const cfg = config();
    const desktop = loadConfig({
      dataDir: cfg.dataDir, mode: "sdk", authMode: "subscription", host: "127.0.0.1", permissionMode: "ask", desktopProfile: true,
      models: cfg.models,
    });
    const runtime = new CursorSdkRuntime(desktop, logger, { api: fake.api, env: {} });
    const project = mkdtempSync(join(tmpdir(), "cursor-desktop-project-"));
    dirs.push(project);
    const request = userTurn("Read sum.js");
    request.tools = [
      { name: "Read", input_schema: { type: "object" } },
      { name: "Execute", input_schema: { type: "object" } },
    ];
    const previousCwd = process.env.BRIDGE_SDK_CWD;
    process.env.BRIDGE_SDK_CWD = project;
    let turn: Awaited<ReturnType<CursorSdkRuntime["handle"]>>;
    try {
      turn = await runtime.handle(input(session(), request), { textDelta() {}, toolTrace(name) { traces.push(name); } });
    } finally {
      if (previousCwd === undefined) delete process.env.BRIDGE_SDK_CWD;
      else process.env.BRIDGE_SDK_CWD = previousCwd;
    }
    const options = fake.created[0] as { local: { customTools: Record<string, unknown> } };
    expect(traces).toEqual(["read"]);
    expect(options.local.customTools.Read).toBeUndefined();
    expect(options.local.customTools.Execute).toBeTypeOf("object");
    expect(turn.response.content.some((block) => block.type === "tool_use")).toBe(false);
  });

  it("rejects creation when mcp is missing from the native allowlist", async () => {
    const fake = fakeCursor();
    const runtime = new CursorSdkRuntime(config(), logger, { api: fake.api, nativeTools: ["read", "grep", "glob", "ls"], env: {} });
    await expect(runtime.handle(input(session(), userTurn("hi")))).rejects.toThrow(/mcp/);
    expect(fake.created).toEqual([]);
  });

  it("parks custom tool execute until deliverResults and uses mcp__droid__ names", async () => {
    let parked: Promise<unknown> | undefined;
    const fake = fakeCursor({
      onSend: async (options) => {
        await options?.onDelta?.({ update: { type: "tool-call-started", callId: "call-9", toolCall: { type: "mcp", args: { toolName: "Execute", providerIdentifier: "custom-user-tools", args: { cmd: "pwd" } } } } });
        parked = options?.local?.customTools?.Execute?.execute({ cmd: "pwd" }, { toolCallId: "call-9" });
      },
      wait: () => new Promise(() => undefined),
    });
    const runtime = new CursorSdkRuntime(config(), logger, { api: fake.api, env: {} });
    const turn = await runtime.handle(input(session(), userTurn("run pwd")));
    expect(turn.pendingToolIds).toEqual(["call-9"]);
    expect(turn.response.content).toContainEqual({ type: "tool_use", id: "call-9", name: "Execute", input: { cmd: "pwd" } });
    expect(runtime.pendingHostCalls("bridge-cursor")).toEqual([{ toolUseId: "call-9", toolName: "Execute", input: { cmd: "pwd" } }]);
    let delivered: unknown;
    const finished = parked!.then((result) => { delivered = result; });
    expect(await runtime.deliverResults("bridge-cursor", [{ tool_use_id: "call-9", content: "ok" }])).toEqual(["accepted"]);
    expect(await runtime.completeHostTool("bridge-cursor", { toolUseId: "call-9", toolName: "Execute", input: { cmd: "pwd" }, content: "again" })).toBe("duplicate");
    await finished;
    expect(delivered).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("returns the next tool call that starts while a delivered result is still in the same run", async () => {
    let tools: CursorSendOptions["local"] | undefined;
    const fake = fakeCursor({
      onSend: (options) => {
        tools = options?.local;
        const first = options?.local?.customTools?.Execute?.execute({ cmd: "echo hello" }, { toolCallId: "call-1" });
        void first?.then(() => {
          void tools?.customTools?.Execute?.execute({ cmd: "echo again" }, { toolCallId: "call-2" });
        });
      },
      wait: () => new Promise(() => undefined),
    });
    const runtime = new CursorSdkRuntime(config(), logger, { api: fake.api, env: {} });
    const first = await runtime.handle(input(session(), userTurn("run echo")));
    expect(first.pendingToolIds).toEqual(["call-1"]);
    const follow: MessagesRequest = {
      model: "cursor:composer-2.5", max_tokens: 32,
      tools: [{ name: "Execute", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "run echo" },
        { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "mcp__droid__Execute", input: { cmd: "echo hello" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "hello\n" }] },
      ],
    };
    const second = await Promise.race([
      runtime.handle(input(session(), follow)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("continuation hung")), 500)),
    ]);
    expect(second.pendingToolIds).toEqual(["call-2"]);
    expect(second.response.content).toContainEqual({ type: "tool_use", id: "call-2", name: "Execute", input: { cmd: "echo again" } });
  });

  it("sends reference history for a new session and resumes only an existing Cursor agent", async () => {
    const cold = fakeCursor();
    const runtime = new CursorSdkRuntime(config(), logger, { api: cold.api, env: {} });
    const history: MessagesRequest = {
      model: "cursor:composer-2.5", max_tokens: 32,
      messages: [
        { role: "user", content: "Remember the release codename: Pine." },
        { role: "assistant", content: "I will remember Pine." },
        { role: "user", content: "What was the codename?" },
      ],
    };
    await runtime.handle(input(session(), history));
    expect(cold.resumed).toEqual([]);
    expect(cold.created).toHaveLength(1);
    expect(cold.sends[0]).toContain("Imported conversation history");
    expect(cold.sends[0]).toContain("Pine");

    const resumed = fakeCursor();
    const again = new CursorSdkRuntime(config(), logger, { api: resumed.api, env: {} });
    await again.handle(input(session({ sdkSessionId: "agent-9" }), userTurn("next")));
    expect(resumed.created).toEqual([]);
    expect(resumed.resumed).toEqual(["agent-9"]);
    expect(resumed.sends[0]).not.toContain("Imported conversation history");
  });

  it("interrupts a checkpointed run and reports false when cancel does not stop", async () => {
    let turn = 0;
    let release: (result: CursorRunResult) => void = () => undefined;
    const fake = fakeCursor({
      wait: () => {
        turn += 1;
        if (turn === 1) return Promise.resolve({ status: "finished", result: "ok" });
        return new Promise((resolve) => { release = resolve; });
      },
      cancel: async (run) => { run.status = "cancelled"; release({ status: "cancelled" }); },
    });
    const runtime = new CursorSdkRuntime(config(), logger, { api: fake.api, env: {}, interruptGraceMs: 50 });
    await runtime.handle(input(session(), userTurn("warm")));
    const gate = fake.whenSent();
    const pending = runtime.handle(input(session(), userTurn("second")));
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(runtime.interrupt("bridge-cursor", "stop")).resolves.toBe(true);
    await expect(pending).rejects.toThrow(/cancelled/);

    const stuck = fakeCursor({ wait: () => new Promise(() => undefined), cancel: () => new Promise(() => undefined) });
    const fresh = new CursorSdkRuntime(config(), logger, { api: stuck.api, env: {}, interruptGraceMs: 20 });
    const hung = fresh.handle(input(session({ bridgeSessionId: "bridge-stuck" }), userTurn("stuck")));
    await stuck.whenSent();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(fresh.interrupt("bridge-stuck", "stop")).resolves.toBe(false);
    hung.catch(() => undefined);
  });
});
