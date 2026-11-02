import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postMessages, startTestBridge } from "../helpers/server.js";
import type { BridgeApp } from "../../src/http/app.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import { modelsFromIds } from "../../src/models.js";
import { droidReasoningEffort, droidReasoningLevel } from "../../src/runtime/reasoning.js";

const runtime = vi.hoisted(() => ({ kind: "sdk", handle: vi.fn(), cancel: vi.fn(async () => undefined), deliverResults: vi.fn() }));
vi.mock("../../src/runtime/factory.js", () => ({ createRuntime: () => runtime }));

const apps: BridgeApp[] = [];
const cursor = "cursor:gpt-test";
const tools = [{ name: "Read", input_schema: { type: "object" } }];
const adaptive = { type: "adaptive", display: "summarized" };
function runtimeLevel(call: number): unknown[] {
  const input = runtime.handle.mock.calls[call]![0] as RuntimeRequest;
  return [input.session.reasoning, droidReasoningLevel(input.request)];
}
const opening = (model: string, extra: Record<string, unknown> = {}) => ({
  model, max_tokens: 32, tools, messages: [{ role: "user", content: "remember Pine" }], ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  runtime.handle.mockImplementation(async ({ request }: RuntimeRequest) => ({
    response: assistantMessage(request.model, [{ type: "text", text: "noted" }], "end_turn"),
    pendingToolIds: [], sdkSessionId: "native",
  }));
});
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

async function start() {
  const result = await startTestBridge({
    mode: "sdk", authMode: "subscription",
    models: [...modelsFromIds(["sonnet", "haiku"], "subscription"), { id: cursor, model: "gpt-test", provider: "cursor" as const, displayName: "Cursor · test", cursor: { id: "gpt-test", params: [] } }],
  });
  apps.push(result.app);
  return result;
}

describe("reasoning at HTTP ingress", () => {
  it("persists a root effort on the session and passes it to the runtime", async () => {
    const { app, token } = await start();
    const first = await postMessages(app.url, token, opening("sonnet", { thinking: adaptive, reasoning_effort: "xhigh" }));
    expect(first.status).toBe(200);
    expect(app.store.get(first.session!)).toMatchObject({ reasoning: "xhigh" });
    expect(runtimeLevel(0)).toEqual(["xhigh", "xhigh"]);
  });

  it("persists the same canonical effort for output_config and root aliases", async () => {
    const { app, token } = await start();
    const root = await postMessages(app.url, token, opening("sonnet", { thinking: adaptive, reasoning_effort: "high" }));
    const output = await postMessages(app.url, token, opening("sonnet", { thinking: adaptive, output_config: { effort: "high" } }));
    const a = app.store.get(root.session!)!, b = app.store.get(output.session!)!;
    expect([a.reasoning, b.reasoning]).toEqual(["high", "high"]);
    expect(a.contextHash).toBe(b.contextHash);
  });

  it.each([1024, 8192, 12345])("persists exact budget %i on a Claude route without inferring an effort", async (tokens) => {
    const { app, token } = await start();
    const response = await postMessages(app.url, token, opening("sonnet", { thinking: { type: "enabled", budget_tokens: tokens } }));
    expect(response.status).toBe(200);
    expect(app.store.get(response.session!)).toMatchObject({ reasoning: `budget:${tokens}` });
    expect(runtimeLevel(0)).toEqual([`budget:${tokens}`, `budget:${tokens}`]);
  });

  it("leaves reasoning unset when the request carries none", async () => {
    const { app, token } = await start();
    const response = await postMessages(app.url, token, opening("sonnet"));
    expect(app.store.get(response.session!)?.reasoning).toBeUndefined();
  });

});

describe("reasoning changes on continued history", () => {
  const changes: Array<[string, Record<string, unknown>, Record<string, unknown>, string, string]> = [
    ["high to xhigh", { thinking: adaptive, reasoning_effort: "high" }, { thinking: adaptive, output_config: { effort: "xhigh" } }, "high", "xhigh"],
    ["named to budget", { thinking: adaptive, reasoning_effort: "high" }, { thinking: { type: "enabled", budget_tokens: 8192 } }, "high", "budget:8192"],
    ["budget low to high", { thinking: { type: "enabled", budget_tokens: 2048 } }, { thinking: { type: "enabled", budget_tokens: 31999 } }, "budget:2048", "budget:31999"],
    ["budget to named", { thinking: { type: "enabled", budget_tokens: 8192 } }, { thinking: adaptive, reasoning_effort: "low" }, "budget:8192", "low"],
  ];

  it.each(changes)("keeps one session across an idle %s change", async (_name, before, after, from, to) => {
    const { app, token } = await start();
    const first = await postMessages(app.url, token, opening("sonnet", before));
    expect(app.store.get(first.session!)?.reasoning).toBe(from);
    const second = await postMessages(app.url, token, opening("sonnet", {
      ...after,
      messages: [{ role: "user", content: "remember Pine" }, { role: "assistant", content: first.json.content }, { role: "user", content: "codename?" }],
    }));
    expect(second.status).toBe(200);
    expect(second.session).toBe(first.session);
    expect(app.store.list()).toHaveLength(1);
    expect(app.store.get(first.session!)).toMatchObject({ reasoning: to, state: "IDLE" });
    expect(runtimeLevel(1)).toEqual([to, to]);
  });

  it("does not adopt another conversation's session when the level changes", async () => {
    const { app, token } = await start();
    const first = await postMessages(app.url, token, opening("sonnet", { thinking: adaptive, reasoning_effort: "high" }));
    const unrelated = await postMessages(app.url, token, opening("sonnet", {
      thinking: adaptive, reasoning_effort: "xhigh",
      messages: [{ role: "user", content: "other topic" }, { role: "assistant", content: first.json.content }, { role: "user", content: "go on" }],
    }));
    expect(unrelated.status).toBe(200);
    expect(unrelated.session).not.toBe(first.session);
    expect(app.store.get(first.session!)?.reasoning).toBe("high");
  });
});

describe("rejection before any state is allocated", () => {
  const bad: Array<[string, Record<string, unknown>, number, string]> = [
    ["conflicting efforts", { output_config: { effort: "high" }, reasoning_effort: "xhigh" }, 400, "conflicting_reasoning"],
    ["unknown effort", { reasoning_effort: "turbo" }, 400, "invalid_reasoning"],
    ["fractional budget", { thinking: { type: "enabled", budget_tokens: 2048.5 } }, 400, "invalid_reasoning"],
    ["small budget", { thinking: { type: "enabled", budget_tokens: 512 } }, 400, "invalid_reasoning"],
    ["string budget", { thinking: { type: "enabled", budget_tokens: "8192" } }, 400, "invalid_reasoning"],
    ["missing budget", { thinking: { type: "enabled" } }, 400, "invalid_reasoning"],
  ];

  it.each(bad)("rejects %s without creating a session or touching the runtime", async (_name, extra, status, code) => {
    const { app, token } = await start();
    for (const model of ["sonnet", cursor]) {
      const response = await postMessages(app.url, token, opening(model, extra));
      expect(response.status).toBe(status);
      expect(JSON.stringify(response.json)).toContain(code);
    }
    expect(app.store.list()).toHaveLength(0);
    expect(runtime.handle).not.toHaveBeenCalled();
    expect(runtime.cancel).not.toHaveBeenCalled();
  });

  it("rejects a conflict against an existing explicit session without mutating it", async () => {
    const { app, token } = await start();
    const headers = { "x-bridge-session": "conversation" };
    const first = await postMessages(app.url, token, opening("sonnet", { thinking: adaptive, reasoning_effort: "high" }), headers);
    const before = structuredClone(app.store.get(first.session!)!);
    const response = await postMessages(app.url, token, opening("sonnet", { output_config: { effort: "low" }, reasoning_effort: "max" }), headers);
    expect(response.status).toBe(400);
    expect(app.store.get(first.session!)).toEqual(before);
    expect(app.store.list()).toHaveLength(1);
    expect(runtime.handle).toHaveBeenCalledTimes(1);
  });

  it("runs an exact budget on a non-Claude route at the nearest named effort", async () => {
    const { app, token } = await start();
    const response = await postMessages(app.url, token, opening(cursor, { thinking: { type: "enabled", budget_tokens: 12288 } }));
    expect(response.status).toBe(200);
    expect(app.store.get(response.session!)).toMatchObject({ reasoning: "budget:12288" });
    const input = runtime.handle.mock.calls[0]![0] as RuntimeRequest;
    expect(droidReasoningEffort(input.request)).toBe("medium");
  });

  it("accepts the same exact budget on a Claude route", async () => {
    const { app, token } = await start();
    const response = await postMessages(app.url, token, opening("sonnet", { thinking: { type: "enabled", budget_tokens: 8192 } }));
    expect(response.status).toBe(200);
  });
});
