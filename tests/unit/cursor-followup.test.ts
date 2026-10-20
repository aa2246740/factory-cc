import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { createLogger } from "../../src/logging.js";
import type { CursorAgentApi, CursorRunLike, CursorRunResult, CursorSendOptions } from "../../src/runtime/cursor/agent-api.js";
import { cursorMenuFromCatalog } from "../../src/runtime/cursor/catalog.js";
import { cursorCatalogFixture } from "../../src/runtime/cursor/fixture.js";
import { CursorSdkRuntime } from "../../src/runtime/cursor/sdk-runtime.js";
import { FakeRuntime } from "../../src/runtime/fake-runtime.js";
import { RouterRuntime } from "../../src/runtime/router-runtime.js";
import { historyMessageHashes, resolveSession, sessionContextHash } from "../../src/sessions/correlate.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { ContentBlock, Message, MessagesRequest } from "../../src/types.js";

/**
 * Shapes from the probe G transcript be468e52 (sanitized).
 * The successful Execute result was stored without is_error, then replayed with is_error:false.
 */
const MARKER = "The marker is LIVE_MARKER_G1. Reply ACK_G and nothing else. Do not use tools.";
const EXECUTE_ASK = "Use the Execute tool exactly once to run this command and nothing else: echo hello. Then reply with the command output only.";
const RECALL = "What marker did I give you in the first message? Reply with the marker only. Do not use tools.";
const TRACE = "\n[mcp__droid__Execute] Execute\n";
const MISSING_RISK = 'Error: Execute call rejected: missing required parameter "riskLevel". Re-send the same command and include riskLevel (one of "low", "medium", "high").';
const RAN = "hello\n\n\n[Process exited with code 0]";
const FIRST_TOOL = "tool_4b24ea05-4696-4a78-b1e5-617c2dff999";
const SECOND_TOOL = "tool_38b9262f-fb73-427c-8e39-12d9e219e3e";
const SCHEMA = { type: "object" };
const WIDE_TOOLS = ["Read", "LS", "Execute", "Edit", "Grep", "Glob", "Create", "TaskOutput", "TaskStop", "ToolSearch", "Skill", "Task"]
  .map((name) => ({ name, input_schema: SCHEMA }));
const EXECUTE_TOOL = [{ name: "Execute", input_schema: SCHEMA }];

const context: Message = {
  role: "user",
  content: [
    { type: "text", text: "<system-reminder>\nTools available: Execute.\n</system-reminder>" },
    { type: "text", text: "<system-reminder>\nModel: Cursor · Composer 2.5\n</system-reminder>" },
  ],
};

function recorded(successIsError: boolean | undefined, followup = false): Message[] {
  const success: ContentBlock = {
    type: "tool_result",
    tool_use_id: SECOND_TOOL,
    content: RAN,
    ...(successIsError === undefined ? {} : { is_error: successIsError }),
  };
  const messages: Message[] = [
    context,
    { role: "user", content: [{ type: "text", text: MARKER }] },
    { role: "assistant", content: [{ type: "text", text: "ACK_G" }] },
    { role: "user", content: [{ type: "text", text: EXECUTE_ASK }] },
    { role: "assistant", content: [{ type: "text", text: TRACE }, { type: "tool_use", id: FIRST_TOOL, name: "Execute", input: { command: "echo hello" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: FIRST_TOOL, is_error: true, content: MISSING_RISK }] },
    { role: "assistant", content: [{ type: "text", text: TRACE }, { type: "tool_use", id: SECOND_TOOL, name: "Execute", input: { command: "echo hello", riskLevel: "low" } }] },
    { role: "user", content: [success] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ];
  if (followup) messages.push({ role: "user", content: [{ type: "text", text: RECALL }] });
  return messages;
}

const headers = {};
const cwd = "/tmp/cursor-followup";

function idleSession(requestMessages: Message[], completed: Message[]): SessionRecord {
  const request: MessagesRequest = { model: "cursor:composer-2.5", max_tokens: 64, messages: requestMessages, tools: EXECUTE_TOOL };
  return {
    bridgeSessionId: "sess-recorded", sdkSessionId: "agent-recorded", role: "unknown", state: "IDLE",
    model: "cursor:composer-2.5", provider: "cursor", toolNames: ["Execute"],
    contextHash: sessionContextHash(headers, request, cwd, "cursor"),
    requestMessageHashes: historyMessageHashes(requestMessages),
    historyMessageHashes: historyMessageHashes(completed),
    createdAt: "2026-10-20T01:36:10.909Z", updatedAt: "2026-10-20T01:36:30.692Z",
    pendingToolIds: [], cancelRequested: false, notes: [],
    usage: { input_tokens: 0, output_tokens: 0, estimated: true },
  };
}

describe("recorded Cursor follow-up fingerprints", () => {
  it("treats a replayed successful tool result as the one Droid submitted", () => {
    const stored = recorded(undefined);
    const replayed = recorded(false, true);
    expect(historyMessageHashes(stored)).toEqual(historyMessageHashes(replayed.slice(0, -1)));
    expect(historyMessageHashes(recorded(true))).not.toEqual(historyMessageHashes(stored));

    const session = idleSession(stored.slice(0, -1), stored);
    const followup: MessagesRequest = { model: "cursor:composer-2.5", max_tokens: 64, messages: replayed, tools: WIDE_TOOLS };
    const options = { cwd, allowModelSwitch: true, provider: "cursor" as const };
    expect(resolveSession([session], headers, followup, options)).toMatchObject({ match: session, reason: "history-prefix" });
    expect(resolveSession([{ ...session, state: "CANCELLED" }], headers, followup, options)).toEqual({ reason: "new-session" });
    expect(resolveSession([{ ...session, state: "FAILED" }], headers, followup, options)).toEqual({ reason: "new-session" });
    const active: SessionRecord = { ...session, state: "GENERATING", historyMessageHashes: undefined, requestMessageHashes: historyMessageHashes(replayed) };
    expect(() => resolveSession([active], headers, followup, options)).toThrowError(expect.objectContaining({ code: "ambiguous_session" }));
  });

  it("continues a plain turn that never called a tool", () => {
    const opening: Message[] = [context, { role: "user", content: [{ type: "text", text: MARKER }] }];
    const completed: Message[] = [...opening, { role: "assistant", content: [{ type: "text", text: "ACK_G" }] }];
    const followup: MessagesRequest = {
      model: "cursor:composer-2.5", max_tokens: 64, tools: WIDE_TOOLS,
      messages: [...completed, { role: "user", content: [{ type: "text", text: RECALL }] }],
    };
    const session = idleSession(opening, completed);
    expect(resolveSession([session], headers, followup, { cwd, allowModelSwitch: true, provider: "cursor" }))
      .toMatchObject({ match: session, reason: "history-prefix" });
  });
});

const dirs: string[] = [];
const apps: BridgeApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function scriptedCursor(agentId: string, onSend: (index: number, options: CursorSendOptions | undefined, finish: (result: CursorRunResult) => void) => void): {
  api: CursorAgentApi;
  created: unknown[];
  resumed: string[];
  sends: string[];
} {
  const created: unknown[] = [];
  const resumed: string[] = [];
  const sends: string[] = [];
  let index = 0;
  const agent = {
    agentId,
    close: vi.fn(),
    send: vi.fn(async (message: string | { text: string }, options?: CursorSendOptions) => {
      const current = index;
      index += 1;
      sends.push(typeof message === "string" ? message : message.text);
      let resolve!: (result: CursorRunResult) => void;
      const done = new Promise<CursorRunResult>((res) => { resolve = res; });
      const run: CursorRunLike = {
        id: `run-${current}`,
        status: "running",
        cancel: async () => { run.status = "cancelled"; },
        wait: async () => {
          const result = await done;
          run.status = result.status;
          return result;
        },
      };
      onSend(current, options, (result) => resolve(result));
      return run;
    }),
  };
  const api: CursorAgentApi = {
    create: vi.fn(async (options) => { created.push(options); return agent; }),
    resume: vi.fn(async (id: string) => { resumed.push(id); return agent; }),
  };
  return { api, created, resumed, sends };
}

async function startCursor(fake: ReturnType<typeof scriptedCursor>): Promise<{ app: BridgeApp; token: string; model: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cursor-followup-"));
  dirs.push(dir);
  const config: BridgeConfig = loadConfig({
    dataDir: dir, mode: "sdk", host: "127.0.0.1", port: 0, authMode: "subscription", permissionMode: "bypass",
    persistSessions: false, clientToken: "test-token-not-anthropic", adminToken: "admin-token", hookToken: "hook-token",
    models: [{ id: "sonnet", model: "sonnet", displayName: "Claude Sonnet" }, ...cursorMenuFromCatalog(cursorCatalogFixture, "default")],
    requestTimeoutMs: 10_000,
  });
  const cursor = new CursorSdkRuntime(config, createLogger(config.logDir), { api: fake.api, env: {} });
  const app = createBridgeApp(config, createLogger(config.logDir), join(config.sandboxDir, "CANARY.txt"), new RouterRuntime(new FakeRuntime(), cursor));
  apps.push(app);
  await listen(app, config);
  const model = config.models?.find((item) => item.provider === "cursor" && item.model === "composer-2.5")?.id;
  if (!model) throw new Error("composer menu entry missing");
  return { app, token: config.clientToken, model };
}

async function post(app: BridgeApp, token: string, model: string, messages: Message[], tools: typeof WIDE_TOOLS): Promise<{ session: string; content: ContentBlock[]; stop: unknown }> {
  const response = await fetch(`${app.url}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 64, messages, tools }),
  });
  const json = await response.json() as { content?: ContentBlock[]; stop_reason?: unknown; error?: unknown };
  if (response.status !== 200 || !Array.isArray(json.content)) {
    throw new Error(`messages ${response.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  const session = response.headers.get("x-bridge-session");
  if (!session) throw new Error("missing session");
  return { session, content: json.content, stop: json.stop_reason };
}

describe("Cursor follow-up keeps one agent", () => {
  it("reuses the bridge session and agent across a Droid tool round trip and the next user message", async () => {
    const fake = scriptedCursor("agent-followup", (index, options, finish) => {
      if (index === 0) {
        finish({ status: "finished", result: "ACK_G", usage: { inputTokens: 2, outputTokens: 1 } });
        return;
      }
      if (index === 1) {
        const execute = options?.local?.customTools?.Execute?.execute;
        if (!execute) throw new Error("Execute was not offered");
        void execute({ command: "echo hello" }, { toolCallId: FIRST_TOOL }).then(async () => {
          await execute({ command: "echo hello", riskLevel: "low" }, { toolCallId: SECOND_TOOL });
          await options?.onDelta?.({ update: { type: "text-delta", text: "hello" } });
          finish({ status: "finished", result: "hello", usage: { inputTokens: 8, outputTokens: 2 } });
        });
        return;
      }
      finish({ status: "finished", result: "LIVE_MARKER_G1", usage: { inputTokens: 9, outputTokens: 2 } });
    });
    const { app, token, model } = await startCursor(fake);
    let messages: Message[] = [context, { role: "user", content: [{ type: "text", text: MARKER }] }];
    const first = await post(app, token, model, messages, WIDE_TOOLS);
    expect(first.content).toContainEqual({ type: "text", text: "ACK_G" });
    messages = [...messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "text", text: EXECUTE_ASK }] }];
    const proposed = await post(app, token, model, messages, EXECUTE_TOOL);
    expect(proposed.stop).toBe("tool_use");
    expect(proposed.content).toContainEqual({ type: "tool_use", id: FIRST_TOOL, name: "Execute", input: { command: "echo hello" } });
    messages = [...messages, { role: "assistant", content: proposed.content }, {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: FIRST_TOOL, is_error: true, content: MISSING_RISK }],
    }];
    const retried = await post(app, token, model, messages, EXECUTE_TOOL);
    expect(retried.content).toContainEqual({ type: "tool_use", id: SECOND_TOOL, name: "Execute", input: { command: "echo hello", riskLevel: "low" } });
    messages = [...messages, { role: "assistant", content: retried.content }, {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: SECOND_TOOL, content: RAN }],
    }];
    const echoed = await post(app, token, model, messages, EXECUTE_TOOL);
    expect(echoed.content).toContainEqual({ type: "text", text: "hello" });
    const replay = messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.map((block) => block.type === "tool_result" && block.tool_use_id === SECOND_TOOL ? { ...block, is_error: false as const } : block),
      };
    });
    const third = await post(app, token, model, [
      ...replay,
      { role: "assistant", content: echoed.content },
      { role: "user", content: [{ type: "text", text: RECALL }] },
    ], WIDE_TOOLS);
    expect(third.content).toContainEqual({ type: "text", text: "LIVE_MARKER_G1" });
    const sessions = [first.session, proposed.session, retried.session, echoed.session, third.session];
    expect(new Set(sessions).size).toBe(1);
    expect(app.store.list().map((session) => session.sdkSessionId)).toEqual(["agent-followup"]);
    expect(app.records.map((record) => record.notes?.[0])).toEqual(["new-session", "history-prefix", "tool-use-id", "tool-use-id", "history-prefix"]);
    expect(fake.created).toHaveLength(1);
    expect(fake.resumed).toEqual([]);
    expect(fake.sends).toHaveLength(3);
  });

  it("reuses the bridge session and agent for a plain follow-up", async () => {
    const fake = scriptedCursor("agent-plain", (index, _options, finish) => {
      finish({ status: "finished", result: index === 0 ? "ACK_G" : "LIVE_MARKER_G1", usage: { inputTokens: 2, outputTokens: 1 } });
    });
    const { app, token, model } = await startCursor(fake);
    let messages: Message[] = [context, { role: "user", content: [{ type: "text", text: MARKER }] }];
    const first = await post(app, token, model, messages, WIDE_TOOLS);
    messages = [...messages, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "text", text: RECALL }] }];
    const second = await post(app, token, model, messages, WIDE_TOOLS);
    expect(second.session).toBe(first.session);
    expect(second.content).toContainEqual({ type: "text", text: "LIVE_MARKER_G1" });
    expect(app.store.list().map((session) => session.sdkSessionId)).toEqual(["agent-plain"]);
    expect(app.records.map((record) => record.notes?.[0])).toEqual(["new-session", "history-prefix"]);
    expect(fake.created).toHaveLength(1);
    expect(fake.resumed).toEqual([]);
    expect(fake.sends).toHaveLength(2);
  });
});
