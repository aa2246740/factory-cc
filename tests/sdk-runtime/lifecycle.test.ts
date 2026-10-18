import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { SdkRuntime, type SdkHandle, type SdkUserInput } from "../../src/runtime/sdk-runtime.js";
import { forbiddenNamesIn } from "../../src/upstream/auth-env.js";
import type { RuntimeApprovalRequest, RuntimePermissionDecision, RuntimeRequest } from "../../src/runtime/types.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { ContentBlock, Message } from "../../src/types.js";
import { historyMessageHashes } from "../../src/sessions/correlate.js";

const runtimes: SdkRuntime[] = [];
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const tool = { name: "TaskOutput", input_schema: { type: "object" as const, properties: {} } };
const user = (content: string | ContentBlock[]) => ({ role: "user" as const, content });
const success = (result: string, extra = {}) => ({ type: "result", subtype: "success", is_error: false, result, session_id: "native-sdk-session", ...extra });
const modelCatalog = [
  { id: "first-model", model: "native-model-a", displayName: "Model A" },
  { id: "second-model", model: "native-model-b", displayName: "Model B" },
];

class FakeSdk implements SdkHandle {
  readonly calls: Array<{ prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }> = [];
  readonly inputs: SdkUserInput[] = [];
  readonly handlers = new Map<string, (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>>();
  readonly schemas = new Map<string, unknown>();
  readonly catalogNotifications: string[][] = [];
  readonly mcpStatus = vi.fn(async () => [{ name: "droid", status: "connected", tools: [...this.handlers.keys()].map((name) => ({ name })) }]);
  readonly interrupt = vi.fn(async () => undefined);
  readonly close = vi.fn(() => this.release());
  private release = () => {};
  readonly untilClosed = new Promise<void>((resolve) => { this.release = resolve; });
  constructor(readonly respond: (input: SdkUserInput, index: number, sdk: FakeSdk) => AsyncGenerator<Record<string, unknown>>) {}
  tool(name: string, _description: string, _schema: unknown, handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>): unknown {
    this.handlers.set(name, handler);
    return { name, handler };
  }
  createSdkMcpServer(options: Record<string, unknown>): unknown {
    const changed = () => { this.catalogNotifications.push([...this.handlers.keys()]); };
    return { ...options, instance: {
      isConnected: () => this.calls.length > 0,
      sendToolListChanged: changed,
      server: { sendToolListChanged: async () => changed(), setRequestHandler: () => undefined },
      registerTool: (name: string, config: { inputSchema: unknown; description: string }, handler: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>) => {
        const wrapped = (args: Record<string, unknown>, extra?: unknown) => handler((config.inputSchema as { parse(input: unknown): Record<string, unknown> }).parse(args), extra);
        this.handlers.set(name, wrapped);
        this.schemas.set(name, config.inputSchema);
        return {
          update: (updates: { description?: string }) => { if (updates.description) config.description = updates.description; },
          remove: () => { if (this.handlers.get(name) === wrapped) { this.handlers.delete(name); this.schemas.delete(name); } },
        };
      },
    } };
  }
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }) {
    this.calls.push(args);
    const self = this;
    return {
      interrupt: this.interrupt,
      close: this.close,
      mcpServerStatus: this.mcpStatus,
      accountInfo: async () => ({ subscriptionType: "max", apiKeySource: "none", email: "a@example.com" }),
      async *[Symbol.asyncIterator]() {
        for await (const input of args.prompt) {
          self.inputs.push(input);
          yield { type: "system", subtype: "init", session_id: "native-sdk-session" };
          yield* self.respond(input, self.inputs.length - 1, self);
        }
      },
    };
  }
}

function create(sdk: FakeSdk, overrides = {}) {
  const config = loadConfig({
    mode: "sdk", dataDir: mkdtempSync(join(tmpdir(), "relay-sdk-lifecycle-")), authMode: "byok", permissionMode: "bypass",
    upstreamBaseUrl: "https://offline.invalid/anthropic", upstreamModel: "offline-test-model", upstreamTokenEnv: "BRIDGE_TEST_FAKE_KEY",
    requestTimeoutMs: 300, toolWaitMs: 300, persistSessions: true, ...overrides,
  });
  const runtime = new SdkRuntime(config, logger, sdk);
  runtimes.push(runtime);
  return { runtime, config };
}
function session(extra: Partial<SessionRecord> = {}): SessionRecord {
  return { bridgeSessionId: "session-a", role: "chat", state: "NEW", model: "relay", toolNames: [], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true }, ...extra };
}
function request(s: SessionRecord, content: string | ContentBlock[], extra: Partial<RuntimeRequest["request"]> = {}): RuntimeRequest {
  return { request: { model: "relay", max_tokens: 100, messages: [user(content)], ...extra }, session: s, role: "chat", headers: {} };
}
beforeEach(() => { vi.stubEnv("BRIDGE_TEST_FAKE_KEY", "offline-placeholder-never-sent"); });
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.close())); vi.unstubAllEnvs(); });

describe("official SDK streaming-input lifecycle (injected offline SDK)", () => {
  it("keeps one query for successive turns and does not repeat stable host context", async () => {
    const sdk = new FakeSdk(async function* (_input, index) { yield success(`reply-${index}`); });
    const { runtime } = create(sdk);
    const s = session();
    const first = await runtime.handle(request(s, "first"));
    const second = await runtime.handle(request(s, "second"));
    expect(first.sdkSessionId).toBe("native-sdk-session");
    expect(second.response.content).toEqual([{ type: "text", text: "reply-1" }]);
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.inputs).toHaveLength(2);
    expect(JSON.stringify(sdk.inputs[0])).toContain("Droid role");
    expect(JSON.stringify(sdk.inputs[1])).not.toContain("Droid role");
    expect(sdk.calls[0]!.options.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(sdk.calls[0]!.options.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect(sdk.close).not.toHaveBeenCalled();
  });

  it("routes concurrent catalog selections to their actual models with independent BYOK environments", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ok"); });
    const { runtime } = create(sdk, { models: modelCatalog });
    await Promise.all([
      runtime.handle(request(session({ bridgeSessionId: "model-a-session" }), "first task", { model: "first-model" })),
      runtime.handle(request(session({ bridgeSessionId: "model-b-session" }), "other task", { model: "second-model" })),
    ]);
    expect(sdk.calls).toHaveLength(2);
    for (const [index, profile] of modelCatalog.entries()) {
      const options = sdk.calls[index]!.options;
      expect(options.model).toBe(profile.model);
      expect(options.env).toMatchObject({ ANTHROPIC_MODEL: profile.model, ANTHROPIC_DEFAULT_OPUS_MODEL: profile.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: profile.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.model,
        CLAUDE_CODE_SUBAGENT_MODEL: profile.model, BRIDGE_MODEL_ID: profile.id,
        ANTHROPIC_BASE_URL: "https://offline.invalid/anthropic", ANTHROPIC_AUTH_TOKEN: "offline-placeholder-never-sent" });
    }
    expect(runtime.describe().sessions).toEqual(expect.arrayContaining(modelCatalog.map((profile) => expect.objectContaining({ modelId: profile.id, nativeModel: profile.model }))));
    await expect(runtime.handle(request(session({ bridgeSessionId: "unknown" }), "task", { model: "not-configured" }))).rejects.toMatchObject({ code: "unknown_model" });
    expect(sdk.calls).toHaveLength(2);
  });

  it("changes the actual BYOK model by resuming the same native history and retires old query callbacks", async () => {
    const sdk = new FakeSdk(async function* (_input, index) { yield success(`reply-${index}`); });
    const { runtime } = create(sdk, { models: modelCatalog });
    const s = session();
    await runtime.handle(request(s, "Remember original context", { model: "first-model", tools: [tool] }));
    const oldHandler = sdk.handlers.get("TaskOutput")!;
    const oldPermission = sdk.calls[0]!.options.canUseTool as (name: string, input: object) => Promise<{ behavior: string }>;
    const oldGuard = (sdk.calls[0]!.options.hooks as { PreToolUse: Array<{ hooks: Array<(hook: object) => Promise<unknown>> }> }).PreToolUse[0]!.hooks[0]!;
    const reply = await runtime.handle(request(s, "ignored", { model: "second-model", tools: [tool], messages: [
      user("Remember original context"), { role: "assistant", content: "reply-0" }, user("Use that remembered context"),
    ] }));
    expect(sdk.close).toHaveBeenCalledTimes(1);
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]!.options).toMatchObject({ model: "native-model-b", resume: "native-sdk-session" });
    expect(sdk.calls[1]!.options.env).toMatchObject({ ANTHROPIC_MODEL: "native-model-b", ANTHROPIC_SMALL_FAST_MODEL: "native-model-b", BRIDGE_MODEL_ID: "second-model" });
    expect(reply.sdkSessionId).toBe("native-sdk-session");
    expect(JSON.stringify(sdk.inputs[1])).toContain("Use that remembered context");
    expect(JSON.stringify(sdk.inputs[1])).not.toContain("Remember original context");
    expect(reply.events).toContainEqual(expect.objectContaining({ type: "sdk_model_changed", data: expect.objectContaining({ fromModel: "native-model-a", toModel: "native-model-b", strategy: "resume" }) }));
    await expect(oldHandler({}, { toolUseID: "late-old-call" })).rejects.toMatchObject({ code: "stale_native_query" });
    expect(await oldPermission("Read", {})).toMatchObject({ behavior: "deny" });
    expect(await oldGuard({ tool_name: "Read" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(runtime.describe().fatalErrors).toEqual([]);
    await runtime.handle(request(s, "continue after rejected stale callbacks", { model: "second-model", tools: [tool] }));
    expect(sdk.calls).toHaveLength(2);
  });

  it("switches subscription models through resume on an allowlisted environment", async () => {
    const saved: Array<[string, string | undefined]> = [];
    for (const name of forbiddenNamesIn("subscription", process.env)) {
      saved.push([name, process.env[name]]);
      delete process.env[name];
    }
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "synthetic-existing-oauth-token");
    try {
      const sdk = new FakeSdk(async function* () { yield success("ok"); });
      const { runtime } = create(sdk, { authMode: "subscription", models: modelCatalog });
      const s = session();
      await runtime.handle(request(s, "first turn", { model: "first-model" }));
      await runtime.handle(request(s, "second turn", { model: "second-model" }));
      expect(sdk.calls[1]!.options).toMatchObject({ model: "native-model-b", resume: "native-sdk-session", settingSources: [], strictMcpConfig: true });
      for (const call of sdk.calls) {
        const env = call.options.env as Record<string, string>;
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("synthetic-existing-oauth-token");
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      }
      expect((sdk.calls[1]!.options.env as Record<string, string>).BRIDGE_MODEL_ID).toBe("second-model");
      expect(JSON.stringify(runtime.describe().authVerification)).not.toContain("a@example.com");
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("refuses to switch while a host tool is pending without breaking its original callback", async () => {
    let result: unknown;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "pending-model-tool", name: "mcp__droid__TaskOutput", input: {} }] } };
      result = await fake.handlers.get("TaskOutput")!({}, { toolUseID: "pending-model-tool" });
      yield success("original model completed");
    });
    const { runtime } = create(sdk, { models: modelCatalog });
    const s = session();
    await runtime.handle(request(s, "run tool", { model: "first-model", tools: [tool] }));
    const content: ContentBlock[] = [{ type: "tool_result", tool_use_id: "pending-model-tool", content: "real result" }];
    await expect(runtime.handle(request(s, content, { model: "second-model", tools: [tool] }))).rejects.toMatchObject({ code: "model_switch_busy" });
    expect(sdk.close).not.toHaveBeenCalled();
    expect(sdk.calls).toHaveLength(1);
    const completed = await runtime.handle(request(s, content, { model: "first-model", tools: [tool] }));
    expect(completed.response.stop_reason).toBe("end_turn");
    expect(result).toEqual({ content: [{ type: "text", text: "real result" }], isError: false });
  });

  it("rejects switching a nonpersistent native session while leaving its original model usable", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ok"); });
    const { runtime } = create(sdk, { models: modelCatalog, persistSessions: false });
    const s = session();
    await runtime.handle(request(s, "first", { model: "first-model" }));
    await expect(runtime.handle(request(s, "switch", { model: "second-model" }))).rejects.toMatchObject({ code: "model_switch_requires_persistence" });
    expect(sdk.close).not.toHaveBeenCalled();
    await runtime.handle(request(s, "still first", { model: "first-model" }));
    expect(sdk.calls).toHaveLength(1);
    expect(runtime.describe().fatalErrors).toEqual([]);
  });

  it("keeps background work on its original model until the native task finishes", async () => {
    const sdk = new FakeSdk(async function* (_input, index) {
      if (index === 0) yield { type: "system", subtype: "task_started", task_id: "background-a" };
      else yield { type: "system", subtype: "task_notification", task_id: "background-a" };
      yield success("ok");
    });
    const { runtime } = create(sdk, { models: modelCatalog });
    const s = session();
    await runtime.handle(request(s, "start background work", { model: "first-model" }));
    await expect(runtime.handle(request(s, "switch while work continues", { model: "second-model" }))).rejects.toMatchObject({ code: "model_switch_busy" });
    expect(sdk.close).not.toHaveBeenCalled();
    await runtime.handle(request(s, "finish background work", { model: "first-model" }));
    await runtime.handle(request(s, "switch after completion", { model: "second-model" }));
    expect(sdk.calls[1]!.options).toMatchObject({ model: "native-model-b", resume: "native-sdk-session" });
  });

  it("does not start a replacement model when the previous native query cannot close safely", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ok"); });
    const { runtime } = create(sdk, { models: modelCatalog });
    const s = session();
    await runtime.handle(request(s, "first", { model: "first-model" }));
    sdk.close.mockImplementationOnce(() => { throw new Error("synthetic close failure"); });
    await expect(runtime.handle(request(s, "switch", { model: "second-model" }))).rejects.toMatchObject({ code: "model_switch_failed" });
    expect(sdk.calls).toHaveLength(1);
    expect(runtime.describe().fatalErrors).toContainEqual(expect.objectContaining({ code: "model_switch_failed" }));
  });

  it("rejects a catalog switch if the SDK silently starts a different native conversation", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ok"); });
    const { runtime } = create(sdk, { models: modelCatalog });
    const s = session();
    await runtime.handle(request(s, "remember existing context", { model: "first-model" }));
    const original = sdk.query.bind(sdk);
    sdk.query = (args) => {
      const query = original(args);
      return { ...query, async *[Symbol.asyncIterator]() {
        for await (const message of query) yield { ...message, session_id: "unexpected-fresh-session" };
      } };
    };
    await expect(runtime.handle(request(s, "switch and recall", { model: "second-model" }))).rejects.toMatchObject({ code: "sdk_resume_identity_changed" });
    expect(sdk.calls[1]!.options.resume).toBe("native-sdk-session");
    expect(runtime.describe().fatalErrors).toContainEqual(expect.objectContaining({ code: "sdk_resume_identity_changed" }));
  });

  it("rejects concurrent first requests before starting a second query", async () => {
    const sdk = new FakeSdk(async function* (_input, _index, fake) { await fake.untilClosed; yield success("late"); });
    const { runtime } = create(sdk);
    const s = session();
    const first = runtime.handle(request(s, "one"));
    const rejected = expect(first).rejects.toMatchObject({ code: "cancelled" });
    await expect(runtime.handle(request(s, "two"))).rejects.toMatchObject({ status: 409, code: "session_busy" });
    await vi.waitFor(() => expect(sdk.calls).toHaveLength(1));
    await runtime.cancel(s.bridgeSessionId, "test cleanup");
    await rejected;
  });

  it("relays MCP results into the original handler once, retaining image data", async () => {
    let handlerResult: unknown;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "native-tool", name: "mcp__droid__TaskOutput", input: {} }] } };
      handlerResult = await fake.handlers.get("TaskOutput")!({}, { toolUseID: "native-tool" });
      yield success("tool completed");
    });
    const { runtime } = create(sdk);
    const s = session();
    const first = await runtime.handle(request(s, "get output", { tools: [tool] }));
    expect(first.pendingToolIds).toEqual(["native-tool"]);
    const followup = request(s, [{ type: "tool_result", tool_use_id: "native-tool", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "image-payload" } }] }]);
    const second = await runtime.handle(followup);
    const replay = await runtime.handle(followup);
    expect(second.response.stop_reason).toBe("end_turn");
    expect(replay.response.id).toBe(second.response.id);
    expect(handlerResult).toEqual({ content: [{ type: "image", data: "image-payload", mimeType: "image/png" }], isError: false });
    expect(sdk.inputs).toHaveLength(1);
    expect(sdk.calls).toHaveLength(1);
  });

  it("buffers separately streamed parallel tool blocks until the next HTTP reply", async () => {
    const received: unknown[] = [];
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      for (const id of ["first-tool", "second-tool"]) {
        yield { type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__droid__TaskOutput", input: { id } }] } };
      }
      received.push(...await Promise.all(["first-tool", "second-tool"].map((id) => fake.handlers.get("TaskOutput")!({ id }, { toolUseID: id }))));
      yield success("both tools completed");
    });
    const { runtime } = create(sdk);
    const s = session();
    const first = await runtime.handle(request(s, "parallel", { tools: [tool] }));
    expect(first.response.content).toContainEqual(expect.objectContaining({ id: "first-tool" }));
    const second = await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "first-tool", content: "first result" }]));
    expect(second.pendingToolIds).toEqual(["second-tool"]);
    expect(second.response.content).toContainEqual(expect.objectContaining({ id: "second-tool" }));
    const final = await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "second-tool", content: "second result" }]));
    expect(final.response.stop_reason).toBe("end_turn");
    expect(received).toHaveLength(2);
    expect(sdk.inputs).toHaveLength(1);
  });

  it("never gives up on a parked Droid tool by itself, however long Droid takes, short of the absolute wait", async () => {
    vi.useFakeTimers();
    try {
      let handlerResult: unknown;
      const sdk = new FakeSdk(async function* (_input, _index, fake) {
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: "long-tool", name: "mcp__droid__TaskOutput", input: {} }] } };
        handlerResult = await fake.handlers.get("TaskOutput")!({}, { toolUseID: "long-tool" });
        yield success("long tool finished");
      });
      const { runtime } = create(sdk, { toolWaitMs: 8 * 60 * 60 * 1000, requestTimeoutMs: 10 * 60 * 1000 });
      const s = session();
      const first = await runtime.handle(request(s, "run a long tool", { tools: [tool] }));
      expect(first.pendingToolIds).toEqual(["long-tool"]);
      // Far past any idle threshold: nothing stops the native session on its own.
      await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
      expect(sdk.close).not.toHaveBeenCalled();
      expect(runtime.pendingHostCalls("session-a")).toHaveLength(1);
      expect(runtime.describe()).toMatchObject({ activeNativeSessions: 1, pendingHostCalls: 1, fatalErrors: [] });
      const done = await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "long-tool", content: "finally done" }]));
      expect(done.response.stop_reason).toBe("end_turn");
      expect(handlerResult).toEqual({ content: [{ type: "text", text: "finally done" }], isError: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows sequential native handlers from one assistant batch without waiting for later handlers", async () => {
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: ["a", "b"].map((id) => ({ type: "tool_use", id, name: "mcp__droid__TaskOutput", input: { id } })) } };
      await fake.handlers.get("TaskOutput")!({ id: "a" });
      await fake.handlers.get("TaskOutput")!({ id: "b" });
      yield success("complete");
    });
    const { runtime } = create(sdk);
    const s = session();
    const first = await runtime.handle(request(s, "two tools", { tools: [tool] }));
    expect(first.pendingToolIds).toEqual(["a"]);
    await expect(runtime.deliverResults(s.bridgeSessionId, [{ tool_use_id: "b", content: "not executed" }])).rejects.toMatchObject({ code: "unknown_tool_use_id" });
    const second = await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "a", content: "A" }]));
    expect(second.response.content).toEqual([{ type: "tool_use", id: "b", name: "TaskOutput", input: { id: "b" } }]);
    const final = await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "b", content: "B" }]));
    expect(final.response.content).toEqual([{ type: "text", text: "complete" }]);
  });

  it.each([false, true])("matches validated handlers in either arrival order using canonical nested arguments (handler first=%s)", async (handlerFirst) => {
    let result: unknown;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      const run = () => fake.handlers.get("TaskOutput")!({ nested: { a: 1, b: 2 }, value: "same" });
      let pending = handlerFirst ? run() : undefined;
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "ordered", name: "mcp__droid__TaskOutput", input: { value: "same", nested: { b: 2, a: 1 } } }] } };
      pending ??= run();
      result = await pending;
      yield success("matched");
    });
    const { runtime } = create(sdk);
    const s = session();
    const first = await runtime.handle(request(s, "run", { tools: [tool] }));
    expect(first.response.content).toEqual([{ type: "tool_use", id: "ordered", name: "TaskOutput", input: { value: "same", nested: { b: 2, a: 1 } } }]);
    await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "ordered", content: "once" }]));
    expect(result).toEqual({ content: [{ type: "text", text: "once" }], isError: false });
  });

  it("never publishes a schema-rejected EndFeatureRun, then relays its corrected retry exactly once", async () => {
    const end = { name: "EndFeatureRun", input_schema: {
      type: "object" as const, properties: {
        commitId: { type: "string" as const },
        handoff: { type: "object" as const, properties: {
          whatWasImplemented: { type: "string" as const }, whatWasLeftUndone: { type: "string" as const },
          tests: { type: "object" as const, properties: { added: { type: "array" as const, items: { type: "string" as const } } }, required: ["added"] },
          discoveredIssues: { type: "array" as const, items: { type: "string" as const } },
        }, required: ["whatWasImplemented", "whatWasLeftUndone", "tests", "discoveredIssues"] },
      }, required: ["commitId", "handoff"],
    } };
    const invalid = { commitId: "real-commit", handoff: { whatWasImplemented: "fixed sum" } };
    const valid = { handoff: { tests: { added: [] }, discoveredIssues: [], whatWasLeftUndone: "", whatWasImplemented: "fixed sum" }, commitId: "real-commit" };
    let completed = 0;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      const rejected = { type: "assistant", message: { content: [{ type: "tool_use", id: "invalid", name: "mcp__droid__EndFeatureRun", input: invalid }] } };
      yield rejected;
      expect(() => fake.handlers.get("EndFeatureRun")!(invalid)).toThrow();
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "invalid", is_error: true, content: "MCP schema requires nested handoff fields" }] } };
      yield rejected; // A duplicate assistant event must not resurrect rejected work.
      const pending = fake.handlers.get("EndFeatureRun")!(valid); // Native control callback wins the output race.
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "corrected", name: "mcp__droid__EndFeatureRun", input: valid }] } };
      await pending;
      completed++;
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "corrected", content: "handoff accepted" }] } };
      yield success("complete");
    });
    const { runtime } = create(sdk);
    const s = session();
    const first = await runtime.handle(request(s, "end feature", { tools: [end] }));
    expect(first.pendingToolIds).toEqual(["corrected"]);
    expect(first.response.content).toEqual([{ type: "tool_use", id: "corrected", name: "EndFeatureRun", input: valid }]);
    await expect(runtime.deliverResults(s.bridgeSessionId, [{ tool_use_id: "invalid", content: "must never run" }])).rejects.toMatchObject({ code: "unknown_tool_use_id" });
    const followup = request(s, [{ type: "tool_result", tool_use_id: "corrected", content: "handoff accepted" }]);
    expect((await runtime.handle(followup)).response.stop_reason).toBe("end_turn");
    await runtime.handle(followup);
    expect(completed).toBe(1);
    expect(sdk.calls).toHaveLength(1);
  });

  it("rejects a root prototype argument before a native parser can strip it and strand the handler", async () => {
    const original = JSON.parse('{"__proto__":{"mustNotDisappear":true},"value":1}');
    const sdk = new FakeSdk(async function* (_input, _index, self) {
      // Real MCP transport strips this root key before dispatching the handler.
      const callback = self.handlers.get("TaskOutput")!({ value: 1 }, { toolUseID: "reserved-key-call" });
      void callback.catch(() => undefined);
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "reserved-key-call", name: "mcp__droid__TaskOutput", input: original }] } };
      await callback;
    });
    const { runtime } = create(sdk);
    await expect(runtime.handle(request(session(), "test unsupported root JSON key", { tools: [tool] }))).rejects.toMatchObject({ status: 422, code: "unsupported_tool_argument" });
    expect(runtime.describe().pendingHostCalls).toBe(0);
    expect(sdk.interrupt).toHaveBeenCalled();
  });

  it("does not forward native permission refusals or duplicate assistant proposals", async () => {
    const sdk = new FakeSdk(async function* () {
      const proposal = { type: "assistant", message: { content: [{ type: "tool_use", id: "denied", name: "mcp__droid__TaskOutput", input: {} }] } };
      yield proposal;
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "denied", is_error: true, content: "native permission denied" }] } };
      yield proposal;
      yield success("permission denied");
    });
    const { runtime } = create(sdk);
    const turn = await runtime.handle(request(session(), "run", { tools: [tool] }));
    expect(turn.response.stop_reason).toBe("end_turn");
    expect(turn.pendingToolIds).toEqual([]);
    expect(turn.response.content.some((block) => block.type === "tool_use")).toBe(false);
  });

  it("does not publish a duplicate assistant event for an already active handler", async () => {
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      const proposal = { type: "assistant", message: { content: [{ type: "tool_use", id: "unique", name: "mcp__droid__TaskOutput", input: {} }] } };
      yield proposal;
      const pending = fake.handlers.get("TaskOutput")!({});
      yield proposal;
      await pending;
      yield success("once");
    });
    const { runtime } = create(sdk);
    const s = session();
    await runtime.handle(request(s, "run", { tools: [tool] }));
    const final = await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "unique", content: "once" }]));
    expect(final.response.stop_reason).toBe("end_turn");
  });

  it("fails closed when identical parallel calls have no authoritative callback id", async () => {
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: ["a", "b"].map((id) => ({ type: "tool_use", id, name: "mcp__droid__TaskOutput", input: {} })) } };
      await fake.handlers.get("TaskOutput")!({});
      yield success("must not complete");
    });
    const { runtime } = create(sdk);
    await expect(runtime.handle(request(session(), "run", { tools: [tool] }))).rejects.toMatchObject({ code: "ambiguous_tool_call" });
  });

  it("cancels a handler waiting for assistant output without publishing or reviving it", async () => {
    let handlerOutcome: Promise<unknown> | undefined;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      handlerOutcome = fake.handlers.get("TaskOutput")!({}, { toolUseID: "late" }).catch((error) => error);
      await fake.untilClosed;
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "late", name: "mcp__droid__TaskOutput", input: {} }] } };
      yield success("must not revive");
    });
    const { runtime } = create(sdk);
    const s = session();
    const running = runtime.handle(request(s, "run", { tools: [tool] }));
    const rejected = expect(running).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(handlerOutcome).toBeDefined());
    await runtime.cancel(s.bridgeSessionId, "cancel pending rendezvous");
    await rejected;
    expect(await handlerOutcome).toMatchObject({ code: "cancelled" });
  });

  it("never revives a native-rejected id when its handler arrives late", async () => {
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "rejected", name: "mcp__droid__TaskOutput", input: {} }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "rejected", is_error: true, content: "native refused" }] } };
      await fake.handlers.get("TaskOutput")!({}, { toolUseID: "rejected" });
      yield success("must not complete");
    });
    const { runtime } = create(sdk);
    await expect(runtime.handle(request(session(), "run", { tools: [tool] }))).rejects.toMatchObject({ code: "duplicate_tool_handler" });
  });

  it("lets the native runner reject a removed tool proposal and recover to an available tool", async () => {
    const old = { name: "RemovedTool", input_schema: { type: "object" as const, properties: {} } };
    const sdk = new FakeSdk(async function* (_input, index, fake) {
      if (!index) { yield success("initial"); return; }
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "removed", name: "mcp__droid__RemovedTool", input: {} }] } };
      yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "removed", is_error: true, content: "unknown tool" }] } };
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "available", name: "mcp__droid__TaskOutput", input: {} }] } };
      await fake.handlers.get("TaskOutput")!({});
      yield success("recovered");
    });
    const { runtime } = create(sdk);
    const s = session();
    await runtime.handle(request(s, "initial", { tools: [old, tool] }));
    const turn = await runtime.handle(request(s, "run", { tools: [tool] }));
    expect(turn.pendingToolIds).toEqual(["available"]);
    expect(turn.response.content.some((block) => block.type === "tool_use" && block.id === "removed")).toBe(false);
    await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "available", content: "ok" }]));
  });

  it("rejects conflicting duplicate IDs in a batch before committing any result", async () => {
    let delivered: unknown;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "one-id", name: "mcp__droid__TaskOutput", input: {} }] } };
      delivered = await fake.handlers.get("TaskOutput")!({}, { toolUseID: "one-id" });
      yield success("done");
    });
    const { runtime } = create(sdk);
    const s = session();
    await runtime.handle(request(s, "get output", { tools: [tool] }));
    await expect(runtime.handle(request(s, [
      { type: "tool_result", tool_use_id: "one-id", content: "first" },
      { type: "tool_result", tool_use_id: "one-id", content: "conflicting" },
    ]))).rejects.toMatchObject({ code: "conflicting_tool_result" });
    expect(delivered).toBeUndefined();
    await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "one-id", content: "accepted" }]));
    expect(delivered).toEqual({ content: [{ type: "text", text: "accepted" }], isError: false });
  });

  it("adds ToolSearch discoveries before releasing its handler in the same SDK turn", async () => {
    const search = { name: "ToolSearch", input_schema: { type: "object" as const, properties: {} } };
    const fresh = { name: "FactoryFreshTool", input_schema: { type: "object" as const, properties: { value: { type: "string" as const } }, required: ["value"], additionalProperties: false } };
    let newHandlerCalled = false;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "search", name: "mcp__droid__ToolSearch", input: {} }] } };
      await fake.handlers.get("ToolSearch")!({}, { toolUseID: "search" });
      expect(fake.handlers.has("FactoryFreshTool")).toBe(true);
      expect(fake.catalogNotifications.at(-1)).toContain("FactoryFreshTool");
      expect(fake.mcpStatus.mock.calls.length).toBeGreaterThanOrEqual(3);
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "fresh", name: "mcp__droid__FactoryFreshTool", input: { value: "original argument" } }] } };
      await fake.handlers.get("FactoryFreshTool")!({ value: "original argument" }, { toolUseID: "fresh" });
      newHandlerCalled = true;
      yield success("discovered and executed");
    });
    sdk.mcpStatus.mockResolvedValueOnce([{ name: "droid", status: "connected", tools: [{ name: "ToolSearch" }] }]);
    sdk.mcpStatus.mockResolvedValueOnce([{ name: "droid", status: "connected", tools: [{ name: "ToolSearch" }] }]);
    const { runtime } = create(sdk);
    const s = session();
    await runtime.handle(request(s, "find a tool", { tools: [search] }));
    const discovered = await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "search", content: "FactoryFreshTool is available" }], { tools: [search, fresh] }));
    expect(discovered.response.content).toContainEqual({ type: "tool_use", id: "fresh", name: "FactoryFreshTool", input: { value: "original argument" } });
    const finished = await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "fresh", content: "executed" }]));
    expect(finished.response.stop_reason).toBe("end_turn");
    expect(newHandlerCalled).toBe(true);
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.inputs).toHaveLength(1);
  });

  it("rejects unsupported continuation content before waking its pending MCP handler", async () => {
    let delivered: unknown;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "content-check", name: "mcp__droid__TaskOutput", input: {} }] } };
      delivered = await fake.handlers.get("TaskOutput")!({}, { toolUseID: "content-check" });
      yield success("done");
    });
    const { runtime } = create(sdk);
    const s = session();
    await runtime.handle(request(s, "output", { tools: [tool] }));
    await expect(runtime.handle(request(s, [
      { type: "tool_result", tool_use_id: "content-check", content: "result" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "unrepresentable-pdf" } },
    ]))).rejects.toMatchObject({ status: 422, code: "unsupported_tool_result_content" });
    expect(delivered).toBeUndefined();
    expect(sdk.close).not.toHaveBeenCalled();
    await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "content-check", content: "valid result" }]));
    expect(delivered).toEqual({ content: [{ type: "text", text: "valid result" }], isError: false });
  });

  it.each([false, true])("preserves Skill body, images and changed host context (appended user=%s)", async (appendUser) => {
    const skill = { name: "Skill", input_schema: { type: "object" as const, properties: {} } };
    let result: { content: Array<Record<string, unknown>> } | undefined;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "skill", name: "mcp__droid__Skill", input: {} }] } };
      result = await fake.handlers.get("Skill")!({}, { toolUseID: "skill" }) as typeof result;
      yield success("skill loaded");
    });
    const { runtime } = create(sdk);
    const s = session();
    await runtime.handle(request(s, "activate", { tools: [skill], system: "OLD_HOST_CONTEXT" }));
    const body: ContentBlock[] = [{ type: "text", text: "FACTORY_SKILL_BODY" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "skill-image" } }];
    const resultBlock: ContentBlock = { type: "tool_result", tool_use_id: "skill", content: "Skill activated" };
    const followup = request(s, "unused", { system: "NEW_HOST_CONTEXT", tools: [skill], messages: appendUser ? [user([resultBlock]), user(body)] : [user([resultBlock, ...body])] });
    const response = await runtime.handle(followup);
    const replay = await runtime.handle(followup);
    expect(replay.response.id).toBe(response.response.id);
    expect(result!.content[0]).toEqual({ type: "text", text: "Skill activated" });
    expect(result!.content).toContainEqual({ type: "image", data: "skill-image", mimeType: "image/png" });
    const text = JSON.stringify(result!.content);
    expect(text.match(/FACTORY_SKILL_BODY/g)).toHaveLength(1);
    expect(text.match(/NEW_HOST_CONTEXT/g)).toHaveLength(1);
    expect(text.match(/Host continuation context/g)).toHaveLength(1);
    expect(sdk.inputs).toHaveLength(1);
    expect(sdk.calls).toHaveLength(1);
  });

  it("removes a tool without losing its pending parallel callback or permitting new calls", async () => {
    const removed = { name: "OldFactoryTool", input_schema: { type: "object" as const, properties: {} } };
    let stale: ((args: Record<string, unknown>, extra?: unknown) => Promise<unknown>) | undefined;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [
        { type: "tool_use", id: "old", name: "mcp__droid__OldFactoryTool", input: {} },
        { type: "tool_use", id: "keep", name: "mcp__droid__TaskOutput", input: {} },
      ] } };
      stale = fake.handlers.get("OldFactoryTool")!;
      await Promise.all([stale({}, { toolUseID: "old" }), fake.handlers.get("TaskOutput")!({}, { toolUseID: "keep" })]);
      yield success("old pending callbacks completed");
    });
    const { runtime } = create(sdk);
    const s = session();
    await runtime.handle(request(s, "parallel", { tools: [removed, tool] }));
    const final = await runtime.handle(request(s, [
      { type: "tool_result", tool_use_id: "old", content: "old result" },
      { type: "tool_result", tool_use_id: "keep", content: "keep result" },
    ], { tools: [tool] }));
    expect(final.response.stop_reason).toBe("end_turn");
    expect(sdk.handlers.has("OldFactoryTool")).toBe(false);
    await expect(stale!({}, { toolUseID: "new-unauthorized-call" })).rejects.toMatchObject({ code: "tool_not_advertised" });
    expect(sdk.calls).toHaveLength(1);
  });

  it("replaces an advertised schema without replacing the query", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ready"); });
    const { runtime } = create(sdk);
    const s = session();
    const schema = (type: "string" | "integer") => ({ type: "object" as const, properties: { value: { type } }, required: ["value"], additionalProperties: false });
    await runtime.handle(request(s, "first", { tools: [{ name: "FactoryArgs", input_schema: schema("string") }] }));
    const first = sdk.schemas.get("FactoryArgs") as { safeParse(args: unknown): { success: boolean } };
    expect(first.safeParse({ value: "before" }).success).toBe(true);
    await runtime.handle(request(s, "second", { tools: [{ name: "FactoryArgs", input_schema: schema("integer") }] }));
    expect(sdk.schemas.has("FactoryArgs")).toBe(false);
    const revision = [...sdk.schemas.keys()].find((name) => name.startsWith("droid_revision_"))!;
    const second = sdk.schemas.get(revision) as typeof first;
    expect(second.safeParse({ value: 7 }).success).toBe(true);
    expect(second.safeParse({ value: "before" }).success).toBe(false);
    expect(second.safeParse({ value: 7, extra: true }).success).toBe(false);
    expect(sdk.calls).toHaveLength(1);
  });

  it("retains user image blocks and imports cold history as reference only", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ok"); });
    const { runtime } = create(sdk);
    const image: ContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "user-image" } };
    await runtime.handle(request(session(), "unused", { messages: [user("remember ALPHA"), { role: "assistant", content: "remembered" }, user([{ type: "text", text: "what was it" }, image])] }));
    const content = sdk.inputs[0]!.message.content;
    expect(content).toContainEqual(image);
    expect(JSON.stringify(content)).toContain("ALPHA");
    expect(JSON.stringify(content)).toContain("reference");
    expect(sdk.calls[0]!.options.resume).toBeUndefined();
  });

  it("still imports cold history when SDK init arrives before the first input", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ok"); });
    const originalQuery = sdk.query.bind(sdk);
    sdk.query = (args) => {
      const query = originalQuery(args);
      return {
        ...query,
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "early-init-id" };
          yield* query;
        },
      };
    };
    const { runtime } = create(sdk);
    await runtime.handle(request(session(), "unused", { messages: [user("EARLY_INIT_HISTORY"), { role: "assistant", content: "old answer" }, user("new question")] }));
    expect(JSON.stringify(sdk.inputs[0]!.message.content)).toContain("EARLY_INIT_HISTORY");
    expect(sdk.calls[0]!.options.resume).toBeUndefined();
  });

  it("resumes a persisted official session and sends only the new user message", async () => {
    const sdk = new FakeSdk(async function* () { yield success("resumed"); });
    const { runtime } = create(sdk);
    await runtime.handle(request(session({ sdkSessionId: "persisted-sdk-id" }), "unused", { messages: [user("old unique history"), { role: "assistant", content: "old answer" }, user("new question")] }));
    expect(sdk.calls[0]!.options.resume).toBe("persisted-sdk-id");
    expect(sdk.calls[0]!.options.continue).toBeUndefined();
    expect(JSON.stringify(sdk.inputs[0])).not.toContain("old unique history");
    expect(JSON.stringify(sdk.inputs[0])).toContain("new question");
  });

  it("fails closed for a pending MCP round trip after process restart", async () => {
    const sdk = new FakeSdk(async function* () { yield success("must not run"); });
    const { runtime } = create(sdk);
    await expect(runtime.handle(request(session({ sdkSessionId: "old-sdk", pendingToolIds: ["lost-tool"] }), [{ type: "tool_result", tool_use_id: "lost-tool", content: "done" }]))).rejects.toMatchObject({ status: 409, code: "interrupted_tool_roundtrip" });
    expect(sdk.calls).toHaveLength(0);
  });

  it("imports an undelivered tool result as history when it arrives with a new user message", async () => {
    const sdk = new FakeSdk(async function* () { yield success("fresh start"); });
    const { runtime } = create(sdk);
    const stale: ContentBlock = { type: "tool_result", tool_use_id: "abandoned-tool", content: "interrupted by the user" };
    const messages = (last: ContentBlock[]) => [
      user("old task"),
      { role: "assistant" as const, content: [{ type: "tool_use", id: "abandoned-tool", name: "mcp__droid__TaskOutput", input: {} } as ContentBlock] },
      user(last),
    ];
    const turn = await runtime.handle(request(session(), "unused", { messages: messages([stale, { type: "text", text: "new question" }]) }));
    expect(turn.response.content).toEqual([{ type: "text", text: "fresh start" }]);
    const imported = JSON.stringify(sdk.inputs[0]);
    expect(imported).toContain("Historical tool result abandoned-tool:");
    expect(imported).toContain("interrupted by the user");
    expect(imported).toContain("new question");
    // Nothing but a bare tool result has no new turn to run and no callback to answer.
    const bare = create(new FakeSdk(async function* () { yield success("must not run"); })).runtime;
    await expect(bare.handle(request(session(), "unused", { messages: messages([stale]) }))).rejects.toMatchObject({ status: 409, code: "unknown_tool_use_id" });
  });

  it("backstops callers without the HTTP layer: an idle turn is aborted, interrupted and closed", async () => {
    vi.useFakeTimers();
    try {
      const sdk = new FakeSdk(async function* (_input, _index, fake) { await fake.untilClosed; yield success("late"); });
      const { runtime } = create(sdk, { requestTimeoutMs: 20 });
      const turn = runtime.handle(request(session(), "wait forever"));
      const rejected = expect(turn).rejects.toMatchObject({ status: 504, code: "sdk_turn_timeout", message: expect.stringContaining("no progress") });
      // The backstop waits out the HTTP layer's own limit and interrupt grace first.
      await vi.advanceTimersByTimeAsync(20);
      expect(sdk.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(6_000);
      await rejected;
      expect((sdk.calls[0]!.options.abortController as AbortController).signal.aborted).toBe(true);
      expect(sdk.interrupt).toHaveBeenCalledTimes(1);
      expect(sdk.close).toHaveBeenCalledTimes(1);
      await expect(runtime.handle(request(session(), "retry"))).rejects.toMatchObject({ code: "sdk_turn_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  describe("text blocks within one turn", () => {
    const start = (index: number, block: Record<string, unknown>) => ({ type: "stream_event", event: { type: "content_block_start", index, content_block: block } });
    const delta = (index: number, text: string) => ({ type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } });

    it("are separated by a blank line, while the deltas of one block stay joined", async () => {
      const sdk = new FakeSdk(async function* () {
        yield start(0, { type: "text", text: "" });
        yield delta(0, "Let me ");
        yield delta(0, "check.");
        yield start(1, { type: "tool_use", id: "native-read", name: "Read", input: {} });
        yield start(2, { type: "text", text: "" });
        yield delta(2, "Found it.");
        // A block that never carries text must not leave a stray separator.
        yield start(3, { type: "text", text: "" });
        yield start(4, { type: "text", text: "" });
        yield delta(4, "All done.");
        yield success("Let me check.\n\nFound it.\n\nAll done.");
      });
      const { runtime } = create(sdk);
      const textDelta = vi.fn();
      const turn = await runtime.handle(request(session(), "go"), { textDelta, toolTrace: vi.fn() });
      expect(textDelta.mock.calls.map(([text]) => text)).toEqual(["Let me ", "check.", "\n\nFound it.", "\n\nAll done."]);
      expect(turn.response.content).toEqual([{ type: "text", text: "Let me check.\n\nFound it.\n\nAll done." }]);
    });

    it("start the next turn clean, without a leading separator", async () => {
      const sdk = new FakeSdk(async function* (_input, index) {
        yield start(0, { type: "text", text: "" });
        yield delta(0, `turn ${index}`);
        yield success(`turn ${index}`);
      });
      const { runtime } = create(sdk);
      const s = session();
      await runtime.handle(request(s, "first"));
      const second = await runtime.handle(request(s, "second"));
      expect(second.response.content).toEqual([{ type: "text", text: "turn 1" }]);
    });

    it("are separated when the SDK reports a finished message without partial events", async () => {
      const sdk = new FakeSdk(async function* () {
        yield { type: "assistant", message: { content: [{ type: "text", text: "Before." }, { type: "tool_use", id: "native-read", name: "Read", input: {} }, { type: "text", text: "After." }] } };
        yield success("");
      });
      const { runtime } = create(sdk);
      const turn = await runtime.handle(request(session(), "go"));
      expect(turn.response.content).toEqual([{ type: "text", text: "Before.\n\nAfter." }]);
    });
  });

  it("treats a retried tool result as a duplicate even though host continuation text rode along the first time", async () => {
    let handlerResult: unknown;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "continued-tool", name: "mcp__droid__TaskOutput", input: {} }] } };
      handlerResult = await fake.handlers.get("TaskOutput")!({}, { toolUseID: "continued-tool" });
      yield success("done");
    });
    const { runtime } = create(sdk);
    const s = session();
    await runtime.handle(request(s, "go", { tools: [tool] }));
    await runtime.handle(request(s, [{ type: "tool_result", tool_use_id: "continued-tool", content: "result" }, { type: "text", text: "Extra context from Droid" }]));
    expect(JSON.stringify(handlerResult)).toContain("Extra context from Droid");
    expect(await runtime.deliverResults("session-a", [{ tool_use_id: "continued-tool", content: "result" }])).toEqual(["duplicate"]);
    await expect(runtime.deliverResults("session-a", [{ tool_use_id: "continued-tool", content: "different" }])).rejects.toMatchObject({ code: "conflicting_tool_result" });
  });

  it("reports every SDK message to the HTTP layer as progress", async () => {
    const sdk = new FakeSdk(async function* () {
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } };
      yield { type: "system", subtype: "task_started", task_id: "background-a" };
      yield { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } };
      yield success("Hello");
    });
    const { runtime } = create(sdk);
    const activity = vi.fn();
    await runtime.handle(request(session(), "go"), { textDelta: vi.fn(), toolTrace: vi.fn(), activity });
    // The CLI's init message plus the four above.
    expect(activity).toHaveBeenCalledTimes(5);
  });

  it("tells the HTTP layer how many approvals are pending, including ones left by an earlier request", async () => {
    const sdk = new FakeSdk(async function* (_input, index) { yield success(`reply-${index}`); });
    const { runtime } = create(sdk);
    const decisions: Array<(decision: RuntimePermissionDecision) => void> = [];
    runtime.setControl({ requestApproval: () => new Promise((resolve) => { decisions.push(resolve); }) });
    const s = session();
    const advertised = { tools: [{ name: "Execute", input_schema: { type: "object" as const } }] };
    const first = { textDelta: vi.fn(), toolTrace: vi.fn(), approvalsPending: vi.fn() };
    await runtime.handle(request(s, "start", advertised), first);
    const check = sdk.calls[0]!.options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    const pending = check("Bash", { command: "ls" });
    await vi.waitFor(() => expect(decisions).toHaveLength(1));
    // No request is attached now, so the first request's sink is not told.
    expect(first.approvalsPending).not.toHaveBeenCalledWith(1);
    const second = { textDelta: vi.fn(), toolTrace: vi.fn(), approvalsPending: vi.fn() };
    await runtime.handle(request(s, "next", advertised), second);
    expect(second.approvalsPending).toHaveBeenCalledWith(1);
    decisions[0]!({ behavior: "allow" });
    expect(await pending).toMatchObject({ behavior: "allow" });

    const third = { textDelta: vi.fn(), toolTrace: vi.fn(), approvalsPending: vi.fn() };
    const slow = new FakeSdk(async function* (_input, _index, fake) { await fake.untilClosed; yield success("late"); });
    const live = create(slow);
    live.runtime.setControl({ requestApproval: () => new Promise((resolve) => { decisions.push(resolve); }) });
    const turn = live.runtime.handle(request(session(), "needs approval", advertised), third);
    const ended = expect(turn).rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    const decided = (slow.calls[0]!.options.canUseTool as (name: string, input: unknown) => Promise<unknown>)("Bash", {});
    await vi.waitFor(() => expect(third.approvalsPending).toHaveBeenLastCalledWith(1));
    decisions.at(-1)!({ behavior: "deny", message: "no" });
    await decided;
    expect(third.approvalsPending.mock.calls.map(([count]) => count)).toEqual([0, 1, 0]);
    await live.runtime.cancel("session-a", "cleanup");
    await ended;
  });

  describe("interrupting a turn", () => {
    /** A CLI that ends the aborted turn with an error result once its interrupt arrives. */
    function interruptible(options: { resumed?: boolean } = {}) {
      let abort!: () => void;
      const aborted = new Promise<void>((resolve) => { abort = resolve; });
      const sdk = new FakeSdk(async function* (_input, index) {
        if (index === 0) {
          await aborted;
          yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted by the user"], session_id: "native-sdk-session" };
        } else if (options.resumed !== false) yield success("resumed");
      });
      sdk.interrupt.mockImplementation(async () => { abort(); });
      return sdk;
    }

    it("waits for the turn to wind down, then retires the process and keeps a resumable checkpoint", async () => {
      const sdk = interruptible();
      const { runtime } = create(sdk);
      const s = session();
      const turn = runtime.handle(request(s, "long task"));
      const ended = expect(turn).rejects.toMatchObject({ code: "host_session_ended" });
      await vi.waitFor(() => expect(sdk.inputs).toHaveLength(1));
      expect(await runtime.interrupt("session-a", "request-timeout")).toBe(true);
      await ended;
      expect(sdk.interrupt).toHaveBeenCalled();
      expect(sdk.close).toHaveBeenCalledTimes(1);
      expect(runtime.describe()).toMatchObject({ activeNativeSessions: 0, fatalErrors: [] });
      const resumed = await runtime.handle(request(s, "continue after the interrupted turn"));
      expect(resumed.response.content).toEqual([{ type: "text", text: "resumed" }]);
      expect(sdk.calls).toHaveLength(2);
      expect(sdk.calls[1]!.options.resume).toBe("native-sdk-session");
    });

    it("does not call a turn wound down when it ignores the interrupt for the whole grace period", async () => {
      vi.useFakeTimers();
      try {
        const sdk = new FakeSdk(async function* (_input, _index, fake) { await fake.untilClosed; yield success("late"); });
        const { runtime } = create(sdk);
        const turn = runtime.handle(request(session(), "stuck"));
        const ended = expect(turn).rejects.toMatchObject({ code: "cancelled" });
        await vi.waitFor(() => expect(sdk.inputs).toHaveLength(1));
        let settled: boolean | undefined;
        void runtime.interrupt("session-a", "request-timeout").then((value) => { settled = value; });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(sdk.interrupt).toHaveBeenCalledTimes(1);
        expect(settled).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(false);
        // The caller kills it; interrupt() itself never pretends the checkpoint is safe.
        expect(sdk.close).not.toHaveBeenCalled();
        await runtime.cancel("session-a", "request-timeout");
        expect(sdk.close).toHaveBeenCalledTimes(1);
        await ended;
      } finally {
        vi.useRealTimers();
      }
    });

    it("is not resumable without a persisted native session, and is a no-op for unknown or non-interruptible queries", async () => {
      const volatile = interruptible();
      const { runtime } = create(volatile, { persistSessions: false });
      const turn = runtime.handle(request(session(), "long task"));
      const ended = expect(turn).rejects.toMatchObject({ code: "host_session_ended" });
      await vi.waitFor(() => expect(volatile.inputs).toHaveLength(1));
      expect(await runtime.interrupt("session-a", "request-timeout")).toBe(false);
      await ended;
      expect(volatile.close).toHaveBeenCalledTimes(1);
      expect(await runtime.interrupt("never-seen", "request-timeout")).toBe(false);

      const plain = new FakeSdk(async function* (_input, _index, fake) { await fake.untilClosed; yield success("late"); });
      const original = plain.query.bind(plain);
      plain.query = (args) => ({ ...original(args), interrupt: undefined }) as unknown as ReturnType<FakeSdk["query"]>;
      const other = create(plain).runtime;
      const parked = other.handle(request(session(), "stuck"));
      const parkedEnded = expect(parked).rejects.toMatchObject({ code: "cancelled" });
      await vi.waitFor(() => expect(plain.inputs).toHaveLength(1));
      expect(await other.interrupt("session-a", "request-timeout")).toBe(false);
      expect(plain.close).not.toHaveBeenCalled();
      await other.cancel("session-a", "cleanup");
      await parkedEnded;
    });
  });

  it("does not turn SDK execution errors or max-turn errors into successful text", async () => {
    for (const result of [
      { type: "result", subtype: "error_max_turns", errors: ["maximum turns exceeded"] },
      { type: "result", subtype: "success", is_error: true, result: "provider rejected request" },
    ]) {
      const sdk = new FakeSdk(async function* () { yield result; });
      const { runtime } = create(sdk);
      await expect(runtime.handle(request(session(), "do work"))).rejects.toMatchObject({ status: 502, code: "sdk_execution_error" });
      expect(sdk.close).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves compaction metadata and does not finish on child-agent results", async () => {
    const metadata = { trigger: "auto", pre_tokens: 180000, post_tokens: 18000, duration_ms: 1200, preserved_messages: { anchor_uuid: "a", uuids: ["b", "c"] } };
    const sdk = new FakeSdk(async function* () {
      yield { type: "system", subtype: "compact_boundary", compact_metadata: metadata };
      yield success("child answer", { parent_tool_use_id: "parent-task" });
      yield success("parent answer");
    });
    const { runtime } = create(sdk);
    const turn = await runtime.handle(request(session(), "summarize"));
    expect(turn.response.content).toEqual([{ type: "text", text: "parent answer" }]);
    expect(turn.compactMetadata).toEqual(metadata);
    expect(turn.events).toContainEqual(expect.objectContaining({ type: "compact_boundary", data: expect.objectContaining({ compact_metadata: metadata }) }));
  });

  it("ask mode neither preapproves builtins nor executes a Droid command as approval", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ready"); });
    const { runtime } = create(sdk, { permissionMode: "ask" });
    await runtime.handle(request(session(), "start", { tools: [tool, { name: "Execute", input_schema: { type: "object" } }] }));
    const options = sdk.calls[0]!.options;
    expect(options.allowedTools).toEqual(["mcp__droid__*"]);
    const check = options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    expect(await check("Bash", { command: "perform-side-effect" })).toMatchObject({ behavior: "deny" });
    expect(await check("Read", { file_path: "/outside-project/private-file" })).toMatchObject({ behavior: "deny" });
    expect(sdk.handlers.has("Execute")).toBe(false);
    expect(sdk.inputs).toHaveLength(1);
  });

  it("also denies native permission exceptions that reach the callback in bypass mode", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ready"); });
    const { runtime } = create(sdk, { permissionMode: "bypass" });
    await runtime.handle(request(session(), "start", { tools: [tool] }));
    const check = sdk.calls[0]!.options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    expect(await check("Bash", { command: "explicit ask rule" })).toMatchObject({ behavior: "deny" });
    expect(await check("mcp__droid__TaskOutput", {})).toMatchObject({ behavior: "deny" });
  });

  it("routes native approval to a live controller without executing a host command", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ready"); });
    const { runtime } = create(sdk, { permissionMode: "ask" });
    let offered!: RuntimeApprovalRequest;
    let decide!: (decision: RuntimePermissionDecision) => void;
    runtime.setControl({ requestApproval: (approval) => { offered = approval; return new Promise((resolve) => { decide = resolve; }); } });
    await runtime.handle(request(session(), "start", { tools: [tool, { name: "Execute", input_schema: { type: "object" } }] }));
    const check = sdk.calls[0]!.options.canUseTool as (name: string, input: unknown, context: unknown) => Promise<unknown>;
    const pending = check("Bash", { command: "original" }, { toolUseID: "native-op", requestId: "native-request", defaultToNo: true });
    expect(offered).toMatchObject({ bridgeSessionId: "session-a", sdkSessionId: "native-sdk-session", toolName: "Bash", toolUseId: "native-op", requestId: "native-request", defaultToNo: true });
    expect(runtime.describe()).toMatchObject({ pendingApprovals: 1 });
    expect(runtime.pendingHostCalls("session-a")).toEqual([]);
    decide({ behavior: "allow", updatedInput: { command: "approved edit" } });
    expect(await pending).toEqual({ behavior: "allow", updatedInput: { command: "approved edit" } });
    expect(runtime.describe()).toMatchObject({ pendingApprovals: 0 });
    expect(offered.signal.aborted).toBe(true);
    expect(sdk.inputs).toHaveLength(1);
  });

  it.each(["native", "session", "controller"])("denies late approvals after %s cancellation even if a controller ignores its signal", async (cause) => {
    const sdk = new FakeSdk(async function* () { yield success("ready"); });
    const { runtime } = create(sdk);
    let offered!: RuntimeApprovalRequest;
    let decide!: (decision: RuntimePermissionDecision) => void;
    runtime.setControl({ requestApproval: (approval) => { offered = approval; return new Promise((resolve) => { decide = resolve; }); } });
    await runtime.handle(request(session(), "start", { tools: [{ name: "Execute", input_schema: { type: "object" } }] }));
    const check = sdk.calls[0]!.options.canUseTool as (name: string, input: unknown, context: unknown) => Promise<unknown>;
    const nativeAbort = new AbortController();
    const pending = check("Bash", { command: "side effect" }, { signal: nativeAbort.signal });
    if (cause === "native") nativeAbort.abort();
    if (cause === "session") await runtime.cancel("session-a", "user cancelled");
    if (cause === "controller") runtime.setControl(undefined);
    expect(await pending).toMatchObject({ behavior: "deny" });
    expect(offered.signal.aborted).toBe(true);
    decide({ behavior: "allow" });
    expect(runtime.describe()).toMatchObject({ pendingApprovals: 0 });
  });

  it("bounds disconnected approval waits and fails closed on controller errors", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ready"); });
    const { runtime } = create(sdk, { approvalTimeoutMs: 30 });
    runtime.setControl({ requestApproval: () => new Promise(() => {}) });
    await runtime.handle(request(session(), "start", { tools: [{ name: "Execute", input_schema: { type: "object" } }] }));
    const check = sdk.calls[0]!.options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    expect(await check("Bash", {})).toMatchObject({ behavior: "deny" });
    runtime.setControl({ requestApproval: async () => { throw new Error("transport closed"); } });
    expect(await check("Bash", {})).toMatchObject({ behavior: "deny" });
    expect(runtime.describe()).toMatchObject({ pendingApprovals: 0, fatalErrors: [] });
  });

  it("authentically completes a terminal host tool and releases its native process without another HTTP turn", async () => {
    let received: unknown;
    const end = { name: "EndFeatureRun", input_schema: { type: "object" as const, properties: {} } };
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "terminal-call", name: "mcp__droid__EndFeatureRun", input: { report: "done" } }] } };
      received = await fake.handlers.get("EndFeatureRun")!({ report: "done" });
      await fake.untilClosed;
    });
    const { runtime } = create(sdk);
    await runtime.handle(request(session(), "finish worker", { tools: [end] }));
    expect(runtime.pendingHostCalls("session-a")).toEqual([{ toolUseId: "terminal-call", toolName: "EndFeatureRun", input: { report: "done" } }]);
    const completion = { toolUseId: "terminal-call", toolName: "EndFeatureRun", input: { report: "done" }, content: "Host validated and stored the handoff", terminal: true };
    expect(await runtime.completeHostTool("session-a", completion)).toBe("accepted");
    expect(received).toEqual({ content: [{ type: "text", text: completion.content }], isError: false });
    expect(sdk.close).toHaveBeenCalledTimes(1);
    expect(sdk.inputs).toHaveLength(1);
    expect(runtime.describe()).toMatchObject({ activeNativeSessions: 0, pendingHostCalls: 0, fatalErrors: [] });
    expect(await runtime.completeHostTool("session-a", completion)).toBe("duplicate");
    await expect(runtime.completeHostTool("session-a", { ...completion, content: "different outcome" })).rejects.toMatchObject({ code: "conflicting_host_completion" });
    await expect(runtime.handle(request(session(), "resurrect worker"))).rejects.toMatchObject({ code: "host_session_ended" });
  });

  it("rejects mismatched or failed terminal host receipts before unblocking the real MCP handler", async () => {
    const end = { name: "EndFeatureRun", input_schema: { type: "object" as const, properties: {} } };
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "terminal-call", name: "mcp__droid__EndFeatureRun", input: { report: "done" } }] } };
      await fake.handlers.get("EndFeatureRun")!({ report: "done" });
      yield success("host rejection received");
    });
    const { runtime } = create(sdk);
    await runtime.handle(request(session(), "finish worker", { tools: [end] }));
    const completion = { toolUseId: "terminal-call", toolName: "EndFeatureRun", input: { report: "done" }, content: "handoff rejected" };
    await expect(runtime.completeHostTool("session-b", completion)).rejects.toMatchObject({ code: "interrupted_tool_roundtrip" });
    await expect(runtime.completeHostTool("session-a", { ...completion, input: {} })).rejects.toMatchObject({ code: "conflicting_host_completion" });
    await expect(runtime.completeHostTool("session-a", { ...completion, toolName: "TaskOutput" })).rejects.toMatchObject({ code: "conflicting_host_completion" });
    await expect(runtime.completeHostTool("session-a", { ...completion, isError: true, terminal: true })).rejects.toMatchObject({ code: "failed_terminal_tool" });
    expect(runtime.pendingHostCalls("session-a")).toHaveLength(1);
    expect(sdk.close).not.toHaveBeenCalled();
    expect(await runtime.completeHostTool("session-a", { ...completion, isError: true })).toBe("accepted");
    expect(sdk.close).not.toHaveBeenCalled();
  });

  it("host session end cancels native approvals and pending work without inventing a response", async () => {
    let offered!: RuntimeApprovalRequest;
    let decision: unknown;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      const check = fake.calls[0]!.options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
      decision = await check("Bash", { command: "work" });
      await fake.untilClosed;
    });
    const { runtime } = create(sdk);
    runtime.setControl({ requestApproval: (approval) => { offered = approval; return new Promise(() => {}); } });
    const running = runtime.handle(request(session(), "work", { tools: [{ name: "Execute", input_schema: { type: "object" } }] }));
    const rejected = expect(running).rejects.toMatchObject({ code: "host_session_ended" });
    await vi.waitFor(() => expect(offered).toBeDefined());
    await runtime.endHostSession("session-a", "Factory session closed");
    await rejected;
    await vi.waitFor(() => expect(decision).toMatchObject({ behavior: "deny" }));
    expect(offered.signal.aborted).toBe(true);
    expect(runtime.describe()).toMatchObject({ activeNativeSessions: 0, pendingApprovals: 0, fatalErrors: [] });
  });

  it("resumes an ordinary ended Factory session in a fresh native generation", async () => {
    const sdk = new FakeSdk(async function* (_input, index) { yield success(`answer-${index}`); });
    const { runtime } = create(sdk);
    const s = session();
    await runtime.handle(request(s, "first", { tools: [tool] }));
    const firstOptions = sdk.calls[0]!.options;
    expect(await runtime.endHostSession(s.bridgeSessionId, "Droid exec exited")).toEqual({ resumable: true, sdkSessionId: "native-sdk-session" });
    expect(await runtime.endHostSession(s.bridgeSessionId, "duplicate SessionEnd")).toEqual({ resumable: true, sdkSessionId: "native-sdk-session" });
    expect(runtime.describe()).toMatchObject({ activeNativeSessions: 0, activeNativeTurns: 0, fatalErrors: [] });
    expect((await runtime.handle(request(s, "next user message"))).response.content).toEqual([{ type: "text", text: "answer-1" }]);
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]!.options.resume).toBe("native-sdk-session");
    expect(sdk.inputs).toHaveLength(2);
    expect(JSON.stringify(sdk.inputs[1])).toContain("next user message");
    expect(JSON.stringify(sdk.inputs[1])).not.toContain("first");
    expect(sdk.handlers.has("TaskOutput")).toBe(true);
    const staleCheck = firstOptions.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    expect(await staleCheck("Bash", {})).toMatchObject({ behavior: "deny" });
  });

  it("does not resume sessions ended with unresolved host tools or without persisted native checkpoints", async () => {
    for (const hasPendingTool of [false, true]) {
      const sdk = new FakeSdk(async function* (_input, _index, fake) {
        if (hasPendingTool) {
          yield { type: "assistant", message: { content: [{ type: "tool_use", id: "unfinished", name: "mcp__droid__TaskOutput", input: {} }] } };
          await fake.handlers.get("TaskOutput")!({});
        }
        yield success("done");
      });
      const { runtime } = create(sdk, { persistSessions: hasPendingTool });
      await runtime.handle(request(session(), "start", { tools: [tool] }));
      expect(await runtime.endHostSession("session-a", "Droid closed")).toMatchObject({ resumable: false });
      await expect(runtime.handle(request(session(), "continue"))).rejects.toMatchObject({ code: "host_session_ended" });
      expect(sdk.calls).toHaveLength(1);
    }
  });

  it("updates the tool catalog in place but rejects model changes", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ok"); });
    const { runtime } = create(sdk);
    const s = session();
    await runtime.handle(request(s, "first", { tools: [tool] }));
    await runtime.handle(request(s, "second", { tools: [] }));
    expect(sdk.handlers.has("TaskOutput")).toBe(false);
    expect(sdk.catalogNotifications).toContainEqual([]);
    await expect(runtime.handle(request(s, "third", { model: "different" }))).rejects.toMatchObject({ status: 409, code: "session_configuration_changed" });
    expect(sdk.inputs).toHaveLength(2);
    expect(sdk.calls).toHaveLength(1);
  });

  it("enforces explicit tools:[] through public PreToolUse even in bypass mode and strips controller authority", async () => {
    vi.stubEnv("BRIDGE_ADMIN_TOKEN", "must-not-reach-worker");
    vi.stubEnv("BRIDGE_CLIENT_TOKEN", "stale-client-token");
    vi.stubEnv("BRIDGE_CONTROL_URL", "http://unrelated.invalid:1234");
    vi.stubEnv("BRIDGE_FACTORY_BINDING", "parent-hook-generation");
    vi.stubEnv("BRIDGE_FACTORY_LAUNCH_ID", "parent-launch");
    const sdk = new FakeSdk(async function* () { yield success("title"); });
    const { runtime } = create(sdk, { permissionMode: "bypass", clientToken: "actual-local-client", host: "127.0.0.1", port: 23456 });
    const controller = vi.fn(async () => ({ behavior: "allow" as const }));
    runtime.setControl({ requestApproval: controller });
    await runtime.handle(request(session(), "generate title", { tools: [] }));
    const options = sdk.calls[0]!.options;
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
    const hooks = options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> };
    for (const name of ["Bash", "Write", "Skill", "Agent", "mcp__droid__TaskOutput"]) {
      expect(await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: name })).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    }
    const check = options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    expect(await check("Bash", { command: "modify project" })).toMatchObject({ behavior: "deny" });
    expect(controller).not.toHaveBeenCalled();
    for (const key of ["BRIDGE_ADMIN_TOKEN", "BRIDGE_FACTORY_BINDING", "BRIDGE_FACTORY_LAUNCH_ID"]) expect(options.env).not.toHaveProperty(key);
    expect(options.env).toMatchObject({ BRIDGE_CLIENT_TOKEN: "actual-local-client", BRIDGE_CONTROL_URL: "http://127.0.0.1:23456" });
    await runtime.handle(request(session(), "enable tools", { tools: [tool, { name: "Create", input_schema: { type: "object" } }, { name: "Execute", input_schema: { type: "object" } }] }));
    expect(await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: "Write" })).toEqual({});
    expect(await check("Bash", { command: "explicitly allowed by controller" })).toMatchObject({ behavior: "allow" });
    expect(controller).toHaveBeenCalledOnce();
    await runtime.handle(request(session(), "text only again", { tools: [] }));
    expect(await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: "Write" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await check("Bash", {})).toMatchObject({ behavior: "deny" });
    expect(controller).toHaveBeenCalledOnce();
    expect(sdk.calls).toHaveLength(1);
  });

  it("honors explicit tool_choice:none for native tools without changing the official preset", async () => {
    const sdk = new FakeSdk(async function* () { yield success("text only"); });
    const { runtime } = create(sdk, { permissionMode: "bypass" });
    const controller = vi.fn(async () => ({ behavior: "allow" as const }));
    runtime.setControl({ requestApproval: controller });
    await runtime.handle(request(session(), "answer without invoking tools", { tools: [tool], tool_choice: { type: "none" } }));
    const options = sdk.calls[0]!.options;
    const hooks = options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> };
    const check = options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    for (const name of ["Write", "Bash", "mcp__droid__TaskOutput"]) {
      expect(await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: name })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      expect(await check(name, {})).toMatchObject({ behavior: "deny" });
    }
    expect(controller).not.toHaveBeenCalled();
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("enforces a changing native tool subset without rebuilding the cached query", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ready"); });
    const { runtime } = create(sdk, { permissionMode: "bypass" });
    const controller = vi.fn(async () => ({ behavior: "allow" as const }));
    runtime.setControl({ requestApproval: controller });
    const read = { name: "Read", input_schema: { type: "object" as const } };
    const execute = { name: "Execute", input_schema: { type: "object" as const } };
    await runtime.handle(request(session(), "read only", { tools: [read, tool] }));
    const options = sdk.calls[0]!.options;
    const hook = (options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> }).PreToolUse[0]!.hooks[0]!;
    const check = options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    expect(await hook({ tool_name: "Read" })).toEqual({});
    expect(await hook({ tool_name: "mcp__droid__TaskOutput" })).toEqual({});
    for (const name of ["Bash", "Write", "Agent", "Task", "Skill", "TaskOutput", "mcp__other__run", "mcp__droid__removed"]) {
      expect(await hook({ tool_name: name })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      expect(await check(name, {})).toMatchObject({ behavior: "deny" });
    }
    expect(controller).not.toHaveBeenCalled();
    await runtime.handle(request(session(), "enable execute", { tools: [read, execute] }));
    expect(await hook({ tool_name: "Bash" })).toEqual({});
    expect(await check("Bash", {})).toMatchObject({ behavior: "allow" });
    expect(await hook({ tool_name: "mcp__droid__TaskOutput" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await runtime.handle(request(session(), "revoke execute", { tools: [read] }));
    expect(await hook({ tool_name: "Bash" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await check("Bash", {})).toMatchObject({ behavior: "deny" });
    await runtime.handle(request(session(), "no inherited tools"));
    expect(await hook({ tool_name: "Read" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(controller).toHaveBeenCalledOnce();
    expect(sdk.calls).toHaveLength(1);
  });

  it("applies authenticated Factory spec permission before native bypass or external approval", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ready"); });
    const { runtime } = create(sdk, { permissionMode: "bypass" });
    const controller = vi.fn(async () => ({ behavior: "allow" as const }));
    runtime.setControl({ requestApproval: controller });
    const tools = ["Read", "Glob", "Grep", "Execute", "Create", "Edit", "TaskOutput"].map((name) => ({ name, input_schema: { type: "object" as const } }));
    await runtime.handle({ ...request(session(), "spec", { tools }), factoryPermissionMode: "spec" });
    const options = sdk.calls[0]!.options;
    const hook = (options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> }).PreToolUse[0]!.hooks[0]!;
    const check = options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    for (const name of ["Read", "Glob", "Grep", "mcp__droid__TaskOutput"]) expect(await hook({ tool_name: name })).toEqual({});
    for (const name of ["Bash", "Write", "Edit", "TaskOutput", "TaskStop"]) {
      expect(await hook({ tool_name: name })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("SPEC_READ_ONLY") } });
      expect(await check(name, {})).toMatchObject({ behavior: "deny" });
    }
    await runtime.handle({ ...request(session(), "approved", { tools }), factoryPermissionMode: "auto-high" });
    expect(await hook({ tool_name: "Bash" })).toEqual({});
    expect(controller).not.toHaveBeenCalled();
    expect(sdk.calls).toHaveLength(1);
  });

  it("rechecks the live authenticated spec lock before accepting a delayed native approval", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ready"); });
    const { runtime } = create(sdk);
    let mode = "spec";
    let decide!: (decision: RuntimePermissionDecision) => void;
    runtime.setControl({ factoryPermissionMode: () => mode, requestApproval: () => new Promise((resolve) => { decide = resolve; }) });
    await runtime.handle({ ...request(session(), "start", { tools: [{ name: "Execute", input_schema: { type: "object" } }] }), factoryPermissionMode: "auto-high" });
    const options = sdk.calls[0]!.options;
    const hook = (options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> }).PreToolUse[0]!.hooks[0]!;
    const check = options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
    expect(await hook({ tool_name: "Bash" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    mode = "auto-high";
    expect(await hook({ tool_name: "Bash" })).toEqual({});
    const pending = check("Bash", { command: "delayed side effect" });
    mode = "spec";
    decide({ behavior: "allow" });
    expect(await pending).toMatchObject({ behavior: "deny", message: expect.stringContaining("SPEC_READ_ONLY") });
  });

  it("bounds idle CLI processes and resumes an evicted official session", async () => {
    const sdk = new FakeSdk(async function* () { yield success("ok"); });
    const { runtime } = create(sdk, { maxSessions: 1 });
    const a = session({ bridgeSessionId: "a" });
    const b = session({ bridgeSessionId: "b" });
    await runtime.handle(request(a, "first a"));
    await runtime.handle(request(b, "first b"));
    expect(sdk.close).toHaveBeenCalledTimes(1);
    await runtime.handle(request(a, "second a"));
    expect(sdk.calls).toHaveLength(3);
    expect(sdk.calls[2]!.options.resume).toBe("native-sdk-session");
    expect(sdk.close).toHaveBeenCalledTimes(2);
  });

  it("does not replay old tool results from full conversation history", async () => {
    const sdk = new FakeSdk(async function* () { yield success("new answer"); });
    const { runtime } = create(sdk);
    await runtime.handle(request(session(), "unused", { messages: [user("old"), { role: "assistant", content: [{ type: "tool_use", id: "historical", name: "TaskOutput", input: {} }] }, user([{ type: "tool_result", tool_use_id: "historical", content: "old result" }]), user("new turn")] }));
    expect(sdk.inputs).toHaveLength(1);
    expect(sdk.inputs[0]!.message.content.some((block) => block.type === "tool_result")).toBe(false);
  });

  it("keeps provider usage distinct from session cumulative SDK accounting", async () => {
    const sdk = new FakeSdk(async function* (_input, index) {
      yield { type: "assistant", message: { id: `message-${index}`, usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 90 }, content: [{ type: "text", text: "answer" }] } };
      yield success("answer", { modelUsage: { fake: { inputTokens: (index + 1) * 1000, outputTokens: (index + 1) * 20 } } });
    });
    const { runtime, config } = create(sdk);
    const s = session();
    const first = await runtime.handle(request(s, "one"));
    const second = await runtime.handle(request(s, "two"));
    expect(first.response.usage.input_tokens).toBe(10);
    expect(second.response.usage.input_tokens).toBe(10);
    expect(second.response.usage.cache_read_input_tokens).toBe(90);
    expect(second.sdkBillingUsage?.input_tokens).toBe(2000);
    const log = readFileSync(join(config.logDir, "usage.jsonl"), "utf8");
    expect(log).toContain('"source":"provider_message"');
    expect(log).toContain('"source":"sdk_result"');
  });
});


it("desktop profile blocks native side effects and denies approval immediately while retaining Droid MCP", async () => {
  const sdk = new FakeSdk(async function* () { yield success("ok"); });
  const dataDir = mkdtempSync(join(tmpdir(), "relay-desktop-sdk-"));
  const project = realpathSync(mkdtempSync(join(tmpdir(), "relay-desktop-project-")));
  const { runtime } = create(sdk, { desktopProfile: true, permissionMode: "ask", dataDir: join(dataDir, "bridge-data") });
  const approval = vi.fn();
  runtime.setControl({ requestApproval: approval });
  const input = request(session(), [
    { type: "text", text: `<system-reminder>\n\nUser system info (fixture)\n\n% pwd\n${project}\n</system-reminder>` },
    { type: "text", text: "inspect" },
  ], { tools: [{ name: "Execute", input_schema: { type: "object", properties: {} } }, { name: "Read", input_schema: { type: "object", properties: {} } }] });
  await runtime.handle(input);
  const options = sdk.calls[0]!.options;
  expect(options).toMatchObject({ cwd: project, permissionMode: "default", allowDangerouslySkipPermissions: false,
    settingSources: [], strictMcpConfig: true, allowedTools: ["mcp__droid__*"], tools: { type: "preset", preset: "claude_code" } });
  expect(options.disallowedTools).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "TaskStop", "TaskOutput", "KillShell", "Agent", "EnterWorktree", "ScheduleWakeup"]));
  expect(options.disallowedTools).not.toEqual(expect.arrayContaining(["Read"]));
  expect(options.systemPrompt).toMatchObject({ preset: "claude_code", append: expect.stringContaining("Droid owns approvals") });
  const check = options.canUseTool as (name: string, input: object) => Promise<unknown>;
  expect(await check("Read", {})).toEqual({ behavior: "deny", message: expect.stringContaining("Droid applies its current mode") });
  expect(approval).not.toHaveBeenCalled();
  const guard = (options.hooks as { PreToolUse: Array<{ hooks: Array<(hook: { tool_name: string }) => Promise<unknown>> }> }).PreToolUse[0]!.hooks[0]!;
  expect(await guard({ tool_name: "Bash" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(await guard({ tool_name: "Read" })).toEqual({});
});

describe("Droid tool cancellation (desktop profile)", () => {
  const createTool = { name: "Create", input_schema: { type: "object" as const, properties: {} } };
  const execute = { name: "Execute", input_schema: { type: "object" as const, properties: {} } };
  // Droid's session file stores the bare text; its API request adds "Error: ".
  const cancellation = (id: string, text = "Tool execution cancelled by user"): ContentBlock =>
    ({ type: "tool_result", tool_use_id: id, content: `Error: ${text}`, is_error: true });
  type Guard = (hook: { tool_name: string; tool_use_id?: string }) => Promise<unknown>;

  function setup(proposal: { id: string; input: Record<string, string> }, followupCommand: string) {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "relay-cancel-project-")));
    const reminder: ContentBlock = { type: "text", text: `<system-reminder>\n\nUser system info (fixture)\n\n% pwd\n${project}\n</system-reminder>` };
    const seen: { createResult?: unknown; windDownGuard?: unknown; followupGuard?: unknown; executeResult?: unknown } = {};
    const sdk = new FakeSdk(async function* (_input, index, fake) {
      const guard = (fake.calls[0]!.options.hooks as { PreToolUse: Array<{ hooks: Guard[] }> }).PreToolUse[0]!.hooks[0]!;
      if (index === 0) {
        yield { type: "assistant", message: { content: [{ type: "tool_use", id: proposal.id, name: "mcp__droid__Create", input: proposal.input }] } };
        seen.createResult = await fake.handlers.get("Create")!(proposal.input, { toolUseID: proposal.id });
        // A model that tries another way after the cancellation is stopped by the bridge.
        seen.windDownGuard = await guard({ tool_name: "mcp__droid__Execute", tool_use_id: "retry" });
        yield { type: "assistant", message: { content: [{ type: "text", text: "Cancelled; the file was not created." }] } };
        yield success("Cancelled; the file was not created.");
        return;
      }
      seen.followupGuard = await guard({ tool_name: "mcp__droid__Execute", tool_use_id: "execute-1" });
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "execute-1", name: "mcp__droid__Execute", input: { command: followupCommand } }] } };
      seen.executeResult = await fake.handlers.get("Execute")!({ command: followupCommand }, { toolUseID: "execute-1" });
      yield success("done");
    });
    const dataDir = join(mkdtempSync(join(tmpdir(), "relay-cancel-sdk-")), "bridge-data");
    const { runtime } = create(sdk, { desktopProfile: true, permissionMode: "ask", dataDir, toolWaitMs: 5_000, requestTimeoutMs: 5_000 });
    const s = session();
    const tools = [createTool, execute];
    const opening = user([reminder, { type: "text", text: "Create the file" }]);
    return { sdk, runtime, s, tools, opening, seen };
  }

  /** Drive one cancellation round trip and check every boundary of the follow-up turn. */
  async function expectFollowupTurn(tail: (proposal: Message) => Message[], proposal: { id: string; input: Record<string, string> }, followupText: string, followupCommand: string) {
    const { sdk, runtime, s, tools, opening, seen } = setup(proposal, followupCommand);
    const first = await runtime.handle(request(s, "unused", { tools, messages: [opening] }));
    expect(first.response.content).toContainEqual(expect.objectContaining({ type: "tool_use", id: proposal.id, name: "Create" }));
    const assistant: Message = { role: "assistant", content: [{ type: "tool_use", id: proposal.id, name: "Create", input: proposal.input }] };
    const history = [opening, ...tail(assistant)];

    const second = await runtime.handle(request(s, "unused", { tools, messages: history }));
    // The cancellation reaches Claude Code as Droid's own error result, with no user text inside it.
    const createResult = JSON.stringify(seen.createResult);
    expect(seen.createResult).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^Error: /) }, { type: "text", text: expect.stringContaining("did not run") }] });
    expect(createResult).not.toContain(followupCommand);
    expect(createResult).not.toContain("Host continuation context");
    expect(seen.windDownGuard).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringContaining("BRIDGE_USER_CANCELLED") } });
    // The follow-up is a genuine user turn, and the same HTTP reply carries Droid's next approval.
    expect(sdk.inputs).toHaveLength(2);
    expect(sdk.inputs[1]!.message.role).toBe("user");
    expect(sdk.inputs[1]!.message.content).toContainEqual({ type: "text", text: followupText });
    expect(sdk.inputs[1]!.message.content.some((block) => block.type === "tool_result")).toBe(false);
    expect(seen.followupGuard).toEqual({});
    expect(second.response.stop_reason).toBe("tool_use");
    expect(second.response.content).toEqual([
      { type: "text", text: "Cancelled; the file was not created." },
      expect.objectContaining({ type: "tool_use", id: "execute-1", name: "Execute", input: { command: followupCommand } }),
    ]);

    const executed: Message = { role: "assistant", content: second.response.content };
    const done = await runtime.handle(request(s, "unused", { tools, messages: [...history, executed,
      user([{ type: "tool_result", tool_use_id: "execute-1", content: "Command completed successfully\n\n[Process exited with code 0]" }])] }));
    expect(done.response.stop_reason).toBe("end_turn");
    expect(seen.executeResult).toMatchObject({ isError: false, content: [{ type: "text", text: expect.stringContaining("Command completed successfully") }] });
    expect(sdk.calls).toHaveLength(1);
  }

  it("handles the exact messages Droid desktop sent after the GUI retest cancellation", async () => {
    // Session a82e99fa (2026-10-19 00:07:36 +08:00): messages 12-14 of that request.
    const proposal = { id: "toolu_01KsArp3sQXvV59NLsGFonHN", input: { file_path: "/Volumes/Workspace/Scratch/factory-cc-e2e-20261018/gui-a/reject-retest-20261019.txt", content: "no" } };
    const followupText = "Run the shell command: touch cmd-retest-20261019.txt";
    const tail = (assistant: Message): Message[] => [
      assistant,
      user([{ type: "tool_result", tool_use_id: proposal.id, content: "Error: Tool execution cancelled by user", is_error: true }]),
      user([{ type: "text", text: followupText }]),
    ];
    // The running bridge recorded these fingerprints for that request; equal hashes prove this is its real input.
    expect(historyMessageHashes(tail({ role: "assistant", content: [{ type: "tool_use", id: proposal.id, name: "Create", input: proposal.input }] }))).toEqual([
      "e87a2cd5e4a4a55114ffcd021dffb22282ad0cecb3963d9e0848cab08e279d3c",
      "9e4297bfd598d9c4c34f631ab2b2781c0fbdc6a81b341f9498967587f1227cc5",
      "f28ac29df5909726717ca00774c975b491ace6048e7d83b288c685ac37509813",
    ]);
    await expectFollowupTurn(tail, proposal, followupText, "touch cmd-retest-20261019.txt");
  });

  it.each([
    ["one user message", "Tool execution cancelled by user", true],
    ["separate user messages", "工具执行已被用户取消", false],
    ["separate user messages", "Tool execution was interrupted", false],
  ])("starts the user's next message as its own turn after a cancellation (%s, %s)", async (_layout, text, merged) => {
    const proposal = { id: "create-1", input: { file_path: "reject-me.txt" } };
    const followupText = "Run the shell command: touch cmd-test.txt";
    await expectFollowupTurn((assistant) => merged
      ? [assistant, user([cancellation(proposal.id, text), { type: "text", text: followupText }])]
      : [assistant, user([cancellation(proposal.id, text)]), user(followupText)], proposal, followupText, "touch cmd-test.txt");
  });

  it("keeps a failing tool's error and its host context as tool-result continuation", async () => {
    let delivered: unknown;
    const sdk = new FakeSdk(async function* (_input, _index, fake) {
      yield { type: "assistant", message: { content: [{ type: "tool_use", id: "run-1", name: "mcp__droid__TaskOutput", input: {} }] } };
      delivered = await fake.handlers.get("TaskOutput")!({}, { toolUseID: "run-1" });
      yield success("handled");
    });
    const { runtime } = create(sdk);
    const s = session();
    await runtime.handle(request(s, "run", { tools: [tool] }));
    await runtime.handle(request(s, [
      { type: "tool_result", tool_use_id: "run-1", content: "Error: exit 1: Tool execution cancelled by user", is_error: true },
      { type: "text", text: "<system-reminder>todo list unchanged</system-reminder>" },
    ], { tools: [tool] }));
    expect(JSON.stringify(delivered)).toContain("Host continuation context");
    expect(JSON.stringify(delivered)).not.toContain("did not run");
    expect(sdk.inputs).toHaveLength(1);
  });
});
