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
 * Production shape from Droid session 9c5fc3a5 (2026-10-20 07:35Z), sanitized.
 * The Cursor SDK tool id contains a newline. Droid's tool_result echoes `_`.
 * The assistant text keeps the same tool trace the Claude path streams.
 */
const RAW_ID = "call-daa25ded-7183-4534-bfc4-ce65222a9911-1\nfc_6a1fcb40-5682-9f8f-88bb-102a0246cb13_0";
const ECHO_ID = "call-daa25ded-7183-4534-bfc4-ce65222a9911-1_fc_6a1fcb40-5682-9f8f-88bb-102a0246cb13_0";
const WEB_ID = "tool_websearch_loaded";
const CATALOG = "<system-reminder>\nDeferred tools:\nWebSearch\nFetchUrl\n</system-reminder>";
const ASK = "Search the web for Cursor Composer 2.5 reasoning effort and fetch the top result.";
const LOADED = "Available 2 tool(s): WebSearch, FetchUrl. Call them directly.";
const TRACE = "\n[mcp__droid__ToolSearch] ToolSearch\n";
const SCHEMA = { type: "object" as const };
const BASE_TOOLS = ["Read", "Execute", "ToolSearch", "Task"].map((name) => ({ name, input_schema: SCHEMA }));
const LOADED_TOOLS = [
  ...BASE_TOOLS,
  { name: "WebSearch", description: "Search the web", input_schema: SCHEMA },
  { name: "FetchUrl", description: "Fetch a URL", input_schema: SCHEMA },
];

const dirs: string[] = [];
const apps: BridgeApp[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function scripted(onSend: (index: number, options: CursorSendOptions | undefined, finish: (result: CursorRunResult) => void) => void): {
  api: CursorAgentApi;
  created: number;
  sends: number;
} {
  let created = 0;
  let sends = 0;
  const agent = {
    agentId: "agent-toolsearch",
    close: vi.fn(),
    send: vi.fn(async (_message: string | { text: string }, options?: CursorSendOptions) => {
      const current = sends;
      sends += 1;
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
    create: vi.fn(async () => { created += 1; return agent; }),
    resume: vi.fn(async () => { created += 1; return agent; }),
  };
  return { api, get created() { return created; }, get sends() { return sends; } };
}

async function start(fake: ReturnType<typeof scripted>): Promise<{ app: BridgeApp; token: string; model: string }> {
  const dir = mkdtempSync(join(tmpdir(), "cursor-toolsearch-"));
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
  const model = config.models?.find((item) => item.provider === "cursor" && item.model === "grok-4.7")?.id;
  if (!model) throw new Error("grok menu entry missing");
  return { app, token: config.clientToken, model };
}

async function post(app: BridgeApp, token: string, model: string, messages: Message[], tools: typeof BASE_TOOLS): Promise<{ session: string; content: ContentBlock[]; stop: unknown }> {
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

function waiting(rawId: string): SessionRecord {
  return {
    bridgeSessionId: "sess-parked", role: "unknown", state: "WAITING_DROID_TOOL", model: "cursor:grok-4.7", provider: "cursor",
    toolNames: BASE_TOOLS.map((tool) => tool.name), createdAt: "", updatedAt: "", pendingToolIds: [rawId], cancelRequested: false, notes: [],
    usage: { input_tokens: 0, output_tokens: 0, estimated: true },
  };
}

describe("ToolSearch continuation", () => {
  it("treats Droid's underscore echo as the parked Cursor call", () => {
    const request: MessagesRequest = {
      model: "cursor:grok-4.7", max_tokens: 32, tools: LOADED_TOOLS,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: ECHO_ID, content: LOADED }] }],
    };
    expect(resolveSession([waiting(RAW_ID)], {}, request, { provider: "cursor" })).toMatchObject({ reason: "tool-use-id" });
    expect(() => resolveSession([
      { ...waiting(RAW_ID), state: "CANCELLED", pendingToolIds: [], endedToolIds: [RAW_ID] },
    ], {}, request, { provider: "cursor" })).toThrowError(expect.objectContaining({ status: 409, code: "session_unavailable" }));
    expect(() => resolveSession([
      waiting(RAW_ID),
      { ...waiting(RAW_ID), bridgeSessionId: "sess-other" },
    ], {}, request, { provider: "cursor" })).toThrowError(expect.objectContaining({ code: "ambiguous_session" }));
    const claude: MessagesRequest = {
      model: "claude-sonnet", max_tokens: 32,
      tools: [...BASE_TOOLS, { name: "WebSearch", input_schema: SCHEMA }],
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_plain", content: "ok" }] }],
    };
    const claudeSession: SessionRecord = {
      ...waiting("toolu_plain"), bridgeSessionId: "sess-claude", model: "claude-sonnet", provider: undefined, toolNames: ["ToolSearch"],
    };
    expect(resolveSession([claudeSession], {}, claude)).toMatchObject({ match: claudeSession, reason: "tool-use-id" });
  });

  it("keeps an identical Cursor retry on the idle session and still forks that retry for Claude", () => {
    const messages: Message[] = [
      { role: "user", content: ASK },
      { role: "assistant", content: [{ type: "tool_use", id: ECHO_ID, name: "ToolSearch", input: { query: "select:WebSearch" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: ECHO_ID, content: LOADED }] },
    ];
    const request: MessagesRequest = { model: "cursor:grok-4.7", max_tokens: 32, tools: LOADED_TOOLS, messages };
    const hashes = historyMessageHashes(messages);
    const cursor = waiting(ECHO_ID);
    cursor.state = "IDLE";
    cursor.pendingToolIds = [];
    cursor.requestMessageHashes = hashes;
    cursor.contextHash = sessionContextHash({}, request, undefined, "cursor");
    expect(resolveSession([cursor], {}, request, { provider: "cursor" })).toMatchObject({ match: cursor, reason: "request-replay" });
    const parked = { ...cursor, state: "WAITING_DROID_TOOL" as const, pendingToolIds: ["tool_websearch_loaded"] };
    expect(resolveSession([parked], {}, request, { provider: "cursor" })).toMatchObject({ match: parked, reason: "request-replay" });
    const claudeRequest: MessagesRequest = { ...request, model: "claude-sonnet" };
    const claude = { ...cursor, model: "claude-sonnet", provider: undefined, contextHash: sessionContextHash({}, claudeRequest, undefined, "claude") };
    expect(resolveSession([claude], {}, claudeRequest)).toEqual({ reason: "new-session" });
  });

  it("resolves ToolSearch on the same agent and can call a tool the catalog only named", async () => {
    let offered: string[] = [];
    const fake = scripted((index, options, finish) => {
      if (index !== 0) {
        finish({ status: "finished", result: "forked" });
        return;
      }
      offered = Object.keys(options?.local?.customTools ?? {});
      const toolSearch = options?.local?.customTools?.ToolSearch?.execute;
      const webSearch = options?.local?.customTools?.WebSearch?.execute;
      if (!toolSearch || !webSearch) throw new Error(`missing deferred tools: ${offered.join(",")}`);
      void toolSearch({ query: "select:WebSearch,FetchUrl" }, { toolCallId: RAW_ID }).then(async () => {
        await webSearch({ query: "Cursor Composer 2.5 reasoning effort" }, { toolCallId: WEB_ID });
        await options?.onDelta?.({ update: { type: "text-delta", text: "Composer 2.5 publishes fast, not reasoning effort." } });
        finish({ status: "finished", result: "Composer 2.5 publishes fast, not reasoning effort.", usage: { inputTokens: 4, outputTokens: 8 } });
      });
    });
    const { app, token, model } = await start(fake);
    const opening: Message[] = [
      { role: "user", content: [{ type: "text", text: CATALOG }, { type: "text", text: ASK }] },
    ];
    const parked = await post(app, token, model, opening, BASE_TOOLS);
    expect(parked.stop).toBe("tool_use");
    expect(parked.content).toContainEqual({ type: "tool_use", id: ECHO_ID, name: "ToolSearch", input: { query: "select:WebSearch,FetchUrl" } });
    expect(parked.content.some((block) => block.type === "tool_use" && block.id === RAW_ID)).toBe(false);
    expect(offered).toEqual(expect.arrayContaining(["ToolSearch", "WebSearch", "FetchUrl", "Execute"]));
    const continued = await post(app, token, model, [
      ...opening,
      { role: "assistant", content: [{ type: "text", text: `我去核对文档。${TRACE}` }, ...parked.content.filter((block) => block.type === "tool_use")] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: ECHO_ID, content: LOADED }] },
    ], LOADED_TOOLS);
    expect(continued.session).toBe(parked.session);
    expect(continued.stop).toBe("tool_use");
    expect(continued.content).toContainEqual({ type: "tool_use", id: WEB_ID, name: "WebSearch", input: { query: "Cursor Composer 2.5 reasoning effort" } });
    expect(app.records.map((record) => record.notes?.[0])).toEqual(["new-session", "tool-use-id"]);
    expect(app.store.list().map((session) => session.sdkSessionId)).toEqual(["agent-toolsearch"]);
    expect(fake.created).toBe(1);
    expect(fake.sends).toBe(1);

    const done = await post(app, token, model, [
      ...opening,
      { role: "assistant", content: [{ type: "text", text: `我去核对文档。${TRACE}` }, ...parked.content.filter((block) => block.type === "tool_use")] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: ECHO_ID, content: LOADED }] },
      { role: "assistant", content: continued.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: WEB_ID, content: "Composer 2.5 docs" }] },
    ], LOADED_TOOLS);
    expect(done.session).toBe(parked.session);
    expect(done.content.map((block) => block.type === "text" ? block.text : "").join("")).toContain("reasoning effort");
    expect(fake.sends).toBe(1);
    expect(fake.created).toBe(1);
  });
});
