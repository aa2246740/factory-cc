import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import { SdkRuntime, type SdkHandle, type SdkUserInput } from "../../src/runtime/sdk-runtime.js";
import type { Continuity, RuntimeRequest, StreamSink } from "../../src/runtime/types.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { Message } from "../../src/types.js";
import { forbiddenNamesIn } from "../../src/upstream/auth-env.js";
import { COMPACTION_SUMMARY } from "../../src/workspace.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const runtimes: SdkRuntime[] = [];
const restores: Array<() => void> = [];

type Script = (input: SdkUserInput, turn: number) => Array<Record<string, unknown>>;

/** A Claude Code stand-in that answers each user input with scripted SDK messages. */
class ScriptedSdk implements SdkHandle {
  readonly calls: Array<{ prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }> = [];
  readonly inputs: SdkUserInput[] = [];
  readonly contextUsage = vi.fn(async (_options?: { detail?: "summary" | "full" }): Promise<Record<string, unknown>> =>
    ({ isAutoCompactEnabled: false, rawMaxTokens: 1_000_000, maxTokens: 1_000_000, totalTokens: 1_000 }));
  constructor(private readonly script: Script) {}
  tool(): unknown { return {}; }
  createSdkMcpServer(options: Record<string, unknown>): unknown {
    return { ...options, instance: {
      isConnected: () => false,
      sendToolListChanged: async () => undefined,
      server: { sendToolListChanged: async () => undefined, setRequestHandler: () => undefined },
      registerTool: () => ({ update() {}, remove() {} }),
    } };
  }
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }) {
    this.calls.push(args);
    const self = this;
    const query: ReturnType<SdkHandle["query"]> = {
      accountInfo: async () => ({ subscriptionType: "max" }),
      getContextUsage: (options) => self.contextUsage(options),
      close() {},
      async *[Symbol.asyncIterator]() {
        for await (const input of args.prompt) {
          self.inputs.push(input);
          for (const message of self.script(input, self.inputs.length)) yield message;
        }
      },
    };
    return query;
  }
}

function usage(input: number, output: number, cacheRead = 0, cacheCreation = 0) {
  return { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation };
}
function assistant(id: string, text: string, tokens: ReturnType<typeof usage>, parent: string | null = null) {
  return { type: "assistant", session_id: "native-1", parent_tool_use_id: parent, message: { id, model: "claude-test", role: "assistant", content: [{ type: "text", text }], usage: tokens } };
}
const success = { type: "result", subtype: "success", is_error: false, result: "", session_id: "native-1" };

function create(sdk: ScriptedSdk, extra: Partial<BridgeConfig> = {}) {
  const saved = new Map<string, string | undefined>();
  for (const name of forbiddenNamesIn("subscription", process.env)) { saved.set(name, process.env[name]); delete process.env[name]; }
  restores.push(() => { for (const [name, value] of saved) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  const config = loadConfig({
    mode: "sdk", dataDir: mkdtempSync(join(tmpdir(), "relay-context-")), authMode: "subscription", permissionMode: "bypass",
    upstreamBaseUrl: "https://offline.invalid/anthropic", upstreamModel: "offline-test-model", upstreamTokenEnv: "BRIDGE_TEST_FAKE_KEY",
    requestTimeoutMs: 1_000, toolWaitMs: 1_000, ...extra,
  });
  const runtime = new SdkRuntime(config, logger, sdk);
  runtimes.push(runtime);
  return runtime;
}
function session(patch: Partial<SessionRecord> = {}): SessionRecord {
  return { bridgeSessionId: "session-a", role: "chat", state: "NEW", model: "relay", toolNames: [], createdAt: "", updatedAt: "",
    pendingToolIds: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true }, ...patch };
}
function request(messages: Message[], patch: Partial<SessionRecord> = {}): RuntimeRequest {
  return { request: { model: "relay", max_tokens: 16, messages }, session: session(patch), role: "chat", headers: {} };
}
const user = (text: string): Message => ({ role: "user", content: text });
const reply = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });
function recordingSink(): StreamSink & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    textDelta: () => { seen.push("text"); },
    toolTrace: () => undefined,
    continuity: (value: Continuity) => { seen.push(`continuity:${value.kind}`); },
  };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const restore of restores.splice(0)) restore();
  vi.clearAllMocks();
});

describe("Droid is the only compaction owner", () => {
  it("switches Claude Code auto-compaction off and checks the reported policy once per model", async () => {
    const sdk = new ScriptedSdk(() => [assistant("m1", "ok", usage(10, 2)), success]);
    const runtime = create(sdk);
    await runtime.handle(request([user("hello")]));
    expect(sdk.calls[0]!.options.settings).toEqual({ autoCompactEnabled: false });
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith("sdk_context_policy", expect.objectContaining({ autoCompactEnabled: false, rawMaxTokens: 1_000_000 })));
    expect(sdk.contextUsage).toHaveBeenCalledTimes(1);
    expect(sdk.contextUsage).toHaveBeenCalledWith({ detail: "summary" });
    expect(Object.values(runtime.describe().contextPolicy as Record<string, unknown>)).toEqual([expect.objectContaining({ autoCompactEnabled: false })]);

    const second = create(sdk, { upstreamCompaction: "upstream" });
    await second.handle(request([user("hello")], { bridgeSessionId: "session-b" }));
    expect(sdk.calls[1]!.options.settings).toBeUndefined();
  });

  it("warns when Claude Code still reports auto-compaction on", async () => {
    const sdk = new ScriptedSdk(() => [assistant("m1", "ok", usage(10, 2)), success]);
    sdk.contextUsage.mockResolvedValue({ isAutoCompactEnabled: true, autoCompactThreshold: 187_000, rawMaxTokens: 200_000 });
    await create(sdk).handle(request([user("hello")]));
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith("sdk_auto_compact_still_on", expect.objectContaining({ autoCompactEnabled: true, autoCompactThreshold: 187_000 })));
  });

  it("rebuilds the conversation from Droid's history after Claude Code compacted on its own", async () => {
    const sdk = new ScriptedSdk((_input, turn) => turn === 1
      ? [{ type: "system", subtype: "compact_boundary", session_id: "native-1", compact_metadata: { trigger: "auto", pre_tokens: 190_000 } }, assistant("m1", "first", usage(10, 2)), success]
      : [assistant(`m${turn}`, "second", usage(20, 3)), success]);
    const runtime = create(sdk);
    await runtime.handle(request([user("remember Pine")]));
    expect(logger.warn).toHaveBeenCalledWith("sdk_upstream_compacted", expect.objectContaining({ trigger: "auto" }));
    const sink = recordingSink();
    const turn = await runtime.handle(request([user("remember Pine"), reply("first"), user("what was it?")], { sdkSessionId: "native-1" }), sink);
    // A second query, not a resume of the compacted one, seeded with Droid's own history.
    expect(sdk.calls).toHaveLength(2);
    expect(sdk.calls[1]!.options.resume).toBeUndefined();
    expect(JSON.stringify(sdk.inputs[1]!.message.content)).toContain("Imported conversation history");
    expect(JSON.stringify(sdk.inputs[1]!.message.content)).toContain("remember Pine");
    expect(turn.continuity).toEqual({ kind: "reseeded", reason: "claude-code-compaction:auto", importedMessages: 2 });
    expect(sink.seen[0]).toBe("continuity:reseeded");
  });

  it("only logs Claude Code's compaction when the upstream owns compaction", async () => {
    const sdk = new ScriptedSdk((_input, turn) => turn === 1
      ? [{ type: "system", subtype: "compact_boundary", session_id: "native-1", compact_metadata: { trigger: "auto", pre_tokens: 190_000 } }, assistant("m1", "first", usage(10, 2)), success]
      : [assistant(`m${turn}`, "second", usage(20, 3)), success]);
    const runtime = create(sdk, { upstreamCompaction: "upstream" });
    await runtime.handle(request([user("remember Pine")]));
    const turn = await runtime.handle(request([user("remember Pine"), reply("first"), user("what was it?")], { sdkSessionId: "native-1" }));
    expect(sdk.calls).toHaveLength(1);
    expect(turn.continuity).toMatchObject({ kind: "reused" });
  });
});

describe("context overflow reaches Droid as prompt is too long", () => {
  it.each([
    ["a failed result", [{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request too large"], terminal_reason: "prompt_too_long", session_id: "native-1" }]],
    ["an assistant API error", [{ type: "assistant", error: "invalid_request", session_id: "native-1", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "text", text: "Prompt is too long: 1050000 tokens > 1000000 maximum" }] } }]],
  ])("maps %s to a 400 context_length_exceeded", async (_name, messages) => {
    const sdk = new ScriptedSdk(() => messages as Array<Record<string, unknown>>);
    const runtime = create(sdk);
    const failure = await runtime.handle(request([user("hello")])).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 400, code: "context_length_exceeded", extra: { type: "invalid_request_error" } });
    expect((failure as Error).message).toMatch(/^prompt is too long/);
    expect(runtime.isSessionUsable("session-a")).toBe(false);
  });
});

describe("reply usage is the context Droid measures", () => {
  it("reports the last main-agent call, not the sum over the reply", async () => {
    const sdk = new ScriptedSdk(() => [
      assistant("m1", "", usage(5, 40, 90_000, 1_000)),
      assistant("sub", "", usage(3, 900, 50_000), "toolu_task"),
      assistant("m2", "done", usage(7, 60, 91_000, 200)),
      success,
    ]);
    const turn = await create(sdk).handle(request([user("hello")]));
    expect(turn.response.usage).toMatchObject({ input_tokens: 7, output_tokens: 60, cache_read_input_tokens: 91_000, cache_creation_input_tokens: 200, estimated: false });
    expect(turn.turnUsage).toMatchObject({ input_tokens: 15, output_tokens: 1_000, cache_read_input_tokens: 231_000, modelRequests: 3 });
  });

  it("repeats the previous call rather than zero when a reply saw no new call", async () => {
    const sdk = new ScriptedSdk((_input, turn) => turn === 1 ? [assistant("m1", "hi", usage(10, 5, 80_000)), success] : [success]);
    const runtime = create(sdk);
    await runtime.handle(request([user("hello")]));
    const turn = await runtime.handle(request([user("hello"), reply("hi"), user("again")], { sdkSessionId: "native-1" }));
    expect(turn.response.usage).toMatchObject({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 80_000, estimated: true });
  });
});

describe("continuity is reported before any output", () => {
  it("names new, reused, cold-import and reseeded conversations", async () => {
    const sdk = new ScriptedSdk((_input, turn) => [assistant(`m${turn}`, "ok", usage(1, 1)), success]);
    const runtime = create(sdk);
    const first = recordingSink();
    expect((await runtime.handle(request([user("hello")]), first)).continuity).toEqual({ kind: "new" });
    expect(first.seen).toEqual(["continuity:new", "text"]);
    expect((await runtime.handle(request([user("hello"), reply("ok"), user("more")], { sdkSessionId: "native-1" }))).continuity).toMatchObject({ kind: "reused" });

    const imported = await runtime.handle({ ...request([user("old"), reply("old reply"), user("now")], { bridgeSessionId: "session-c" }), continuityReason: "new-session" });
    expect(imported.continuity).toEqual({ kind: "cold-import", reason: "new-session", importedMessages: 2 });

    const summary: Message = { role: "user", content: [{ type: "text", text: `${COMPACTION_SUMMARY}\n<summary>Pine.</summary>` }] };
    const seeded = await runtime.handle(request([summary, user("reminders"), reply("ok"), user("continue")], { bridgeSessionId: "session-d" }));
    expect(seeded.continuity).toEqual({ kind: "reseeded", reason: "droid-compaction", importedMessages: 3 });
  });

  it("names a resumed native session", async () => {
    const sdk = new ScriptedSdk(() => [assistant("m1", "ok", usage(1, 1)), success]);
    const turn = await create(sdk).handle(request([user("hello"), reply("ok"), user("more")], { sdkSessionId: "native-1" }));
    expect(sdk.calls[0]!.options.resume).toBe("native-1");
    expect(turn.continuity).toMatchObject({ kind: "resumed" });
  });
});
