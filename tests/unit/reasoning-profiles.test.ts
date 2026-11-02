import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  claudeReasoningKey, claudeReasoningOptions, droidReasoningEffort, droidReasoningLevel,
  requestAtReasoningLevel, requestWithoutReasoningLevel,
} from "../../src/runtime/reasoning.js";
import { historyMessageHashes, resolveSession, sessionContextHash } from "../../src/sessions/correlate.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { Message, MessagesRequest } from "../../src/types.js";

const headers = { "x-bridge-role": "chat" };
const cwd = "/tmp/reasoning-project";
const gpt = "cursor:gpt-test";
const sonnet = "sonnet-test";
const adaptive = { type: "adaptive", display: "summarized" };

function base(model = sonnet): MessagesRequest {
  return {
    model, max_tokens: 100, system: "stable",
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "Remember Pine." }],
  } as MessagesRequest;
}

function named(effort: string, model = sonnet, root = false): MessagesRequest {
  const request = { ...base(model), thinking: adaptive } as MessagesRequest;
  return root ? { ...request, reasoning_effort: effort } as MessagesRequest
    : { ...request, output_config: { effort } } as MessagesRequest;
}

function budget(tokens: unknown, model = sonnet, extra: Record<string, unknown> = {}): MessagesRequest {
  return { ...base(model), thinking: { type: "enabled", budget_tokens: tokens }, ...extra } as MessagesRequest;
}

function raw(fields: Record<string, unknown>): MessagesRequest {
  return { ...base(), ...fields } as MessagesRequest;
}

function codeOf(run: () => unknown): { status?: number; code?: string } {
  try { run(); } catch (error) { return error as { status?: number; code?: string }; }
  throw new Error("expected throw");
}

describe("reasoning level canonicalization", () => {
  it.each(["low", "medium", "high", "xhigh", "max"])("reads %s from output_config and root alike", (effort) => {
    expect(droidReasoningLevel(named(effort))).toBe(effort);
    expect(droidReasoningLevel(named(effort, sonnet, true))).toBe(effort);
    expect(droidReasoningEffort(named(effort))).toBe(effort);
  });

  it("returns undefined without any reasoning field", () => {
    expect(droidReasoningLevel(base())).toBeUndefined();
    expect(droidReasoningEffort(base())).toBeUndefined();
  });

  it("accepts the same effort in both named fields", () => {
    expect(droidReasoningLevel(raw({ output_config: { effort: "xhigh" }, reasoning_effort: "xhigh" }))).toBe("xhigh");
  });

  it.each([1024, 1025, 8192, 12345, 31999])("keeps exact budget %i without inferring an effort", (tokens) => {
    expect(droidReasoningLevel(budget(tokens))).toBe(`budget:${tokens}`);
    expect(claudeReasoningOptions(`budget:${tokens}`)).toEqual({ thinking: { type: "enabled", budgetTokens: tokens } });
    expect(claudeReasoningOptions(`budget:${tokens}`)).not.toHaveProperty("effort");
  });

  it("keys distinct budgets distinctly and equal budgets equally", () => {
    expect(claudeReasoningKey(budget(8192))).toBe(claudeReasoningKey(budget(8192)));
    expect(claudeReasoningKey(budget(8192))).not.toBe(claudeReasoningKey(budget(8193)));
    expect(claudeReasoningKey(budget(8192))).not.toBe(claudeReasoningKey(named("high")));
  });

  it("lets a named effort override a fallback budget", () => {
    expect(droidReasoningLevel(budget(2048, sonnet, { output_config: { effort: "xhigh" } }))).toBe("xhigh");
    expect(droidReasoningLevel(budget(2048, sonnet, { reasoning_effort: "low" }))).toBe("low");
    expect(droidReasoningEffort(budget(2048, sonnet, { reasoning_effort: "low" }))).toBe("low");
  });

  it.each([
    [{ type: "disabled" }], [{ type: "between_tools" }],
  ])("treats %j as off even with a leftover effort", (thinking) => {
    expect(droidReasoningLevel(raw({ thinking }))).toBe("off");
    expect(droidReasoningLevel(raw({ thinking, output_config: { effort: "high" } }))).toBe("off");
    expect(claudeReasoningOptions("off")).toEqual({ thinking: { type: "disabled" } });
  });

  it.each([
    [1024, "low"], [4096, "low"], [7000, "low"], [7200, "medium"], [12288, "medium"],
    [17000, "medium"], [17500, "high"], [24576, "high"], [64000, "high"],
  ])("maps budget %i to the nearest Droid default level %s for effort-only providers", (tokens, effort) => {
    expect(droidReasoningEffort(budget(tokens))).toBe(effort);
    expect(droidReasoningLevel(budget(tokens))).toBe(`budget:${tokens}`);
  });

  it("keeps a named effort over a fallback budget for effort-only providers", () => {
    expect(droidReasoningEffort(budget(24576, sonnet, { output_config: { effort: "xhigh" } }))).toBe("xhigh");
  });

  it.each(["disabled", "between_tools"])("validates residual effort fields when thinking is %s", (type) => {
    expect(codeOf(() => droidReasoningLevel(raw({ thinking: { type }, reasoning_effort: 3 }))))
      .toMatchObject({ status: 400, code: "invalid_reasoning" });
    expect(codeOf(() => droidReasoningLevel(raw({ thinking: { type }, output_config: { effort: "high" }, reasoning_effort: "low" }))))
      .toMatchObject({ status: 400, code: "conflicting_reasoning" });
  });

  it("rejects conflicting named fields", () => {
    const error = codeOf(() => droidReasoningLevel(raw({ output_config: { effort: "high" }, reasoning_effort: "xhigh" })));
    expect(error).toMatchObject({ status: 400, code: "conflicting_reasoning" });
    expect(codeOf(() => droidReasoningEffort(raw({ output_config: { effort: "low" }, reasoning_effort: "max" }))))
      .toMatchObject({ status: 400, code: "conflicting_reasoning" });
  });

  it.each([
    ["fractional budget", budget(2048.5)],
    ["budget below 1024", budget(1023)],
    ["zero budget", budget(0)],
    ["negative budget", budget(-4096)],
    ["string budget", budget("8192")],
    ["missing budget", raw({ thinking: { type: "enabled" } })],
    ["unsafe integer budget", budget(Number.MAX_SAFE_INTEGER + 1)],
    ["NaN budget", budget(Number.NaN)],
    ["unknown effort", raw({ output_config: { effort: "turbo" } })],
    ["numeric effort", raw({ reasoning_effort: 5 })],
    ["empty effort", raw({ reasoning_effort: "" })],
  ])("rejects %s", (_name, request) => {
    expect(codeOf(() => droidReasoningLevel(request))).toMatchObject({ status: 400, code: "invalid_reasoning" });
  });

  it("round-trips canonical fields through the hash helpers", () => {
    for (const level of ["low", "high", "xhigh", "max"]) {
      const request = requestAtReasoningLevel(base(), level);
      expect(droidReasoningLevel(request)).toBe(level);
      expect(droidReasoningLevel(requestAtReasoningLevel(named("low", sonnet, true), level))).toBe(level);
    }
    expect(droidReasoningLevel(requestAtReasoningLevel(base(), "off"))).toBe("off");
    const stripped = requestWithoutReasoningLevel(named("xhigh"));
    expect(droidReasoningLevel(stripped)).toBeUndefined();
    expect(stripped.reasoning_effort).toBeUndefined();
  });

  it("round-trips an exact budget level", () => {
    const request = requestAtReasoningLevel(base(), "budget:12288");
    expect(droidReasoningLevel(request)).toBe("budget:12288");
    expect(droidReasoningLevel(requestAtReasoningLevel(named("high"), "budget:2048"))).toBe("budget:2048");
  });
});

describe("session context hash for reasoning", () => {
  it("distinguishes a named high from xhigh", () => {
    expect(sessionContextHash(headers, named("high", gpt), cwd, "cursor"))
      .not.toBe(sessionContextHash(headers, named("xhigh", gpt), cwd, "cursor"));
  });

  it("hashes root and output_config effort aliases identically", () => {
    expect(sessionContextHash(headers, named("xhigh", gpt, true), cwd, "cursor"))
      .toBe(sessionContextHash(headers, named("xhigh", gpt, false), cwd, "cursor"));
    expect(sessionContextHash(headers, named("high", sonnet, true), cwd))
      .toBe(sessionContextHash(headers, named("high"), cwd));
  });

  it("preserves arbitrary budgets in the hash", () => {
    const hashes = [2048, 8192, 8193, 31999].map((tokens) => sessionContextHash(headers, budget(tokens), cwd));
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(sessionContextHash(headers, budget(8192), cwd)).toBe(sessionContextHash(headers, budget(8192), cwd));
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(sessionContextHash(headers, budget(8192), cwd)).not.toBe(sessionContextHash(headers, named(effort), cwd));
    }
  });

  it("keeps the historical Sonnet hash when no selector level is present", () => {
    const legacy = (thinking: unknown) => createHash("sha256")
      .update(JSON.stringify({ cwd, model: sonnet, role: "chat", thinking })).digest("hex");
    expect(sessionContextHash(headers, { ...base(), thinking: adaptive } as MessagesRequest, cwd)).toBe(legacy({ display: "summarized", type: "adaptive" }));
    expect(sessionContextHash(headers, base(), cwd)).toBe(createHash("sha256")
      .update(JSON.stringify({ cwd, model: sonnet, role: "chat" })).digest("hex"));
  });

  it("separates off from named efforts and ignores a leftover effort when off", () => {
    const off = sessionContextHash(headers, raw({ thinking: { type: "between_tools" }, output_config: { effort: "high" } }), cwd);
    expect(off).toBe(sessionContextHash(headers, raw({ thinking: { type: "disabled" } }), cwd));
    expect(off).not.toBe(sessionContextHash(headers, named("high"), cwd));
  });
});

const completed: Message[] = [
  { role: "user", content: "Remember Pine." },
  { role: "assistant", content: [{ type: "text", text: "Pine noted." }] },
];

function record(request: MessagesRequest, patch: Partial<SessionRecord> = {}): SessionRecord {
  const level = droidReasoningLevel(request);
  const provider = request.model.startsWith("cursor:") ? "cursor" : "claude";
  return {
    bridgeSessionId: "bridge-r", droidSessionId: "droid-r", sdkSessionId: "sdk-r", role: "chat", provider,
    state: "IDLE", model: request.model, toolNames: ["Read"],
    contextHash: sessionContextHash(headers, request, cwd, provider),
    ...(level ? { reasoning: level } : {}),
    requestMessageHashes: historyMessageHashes(request.messages),
    historyMessageHashes: historyMessageHashes(completed),
    createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [],
    usage: { input_tokens: 0, output_tokens: 0, estimated: true }, ...patch,
  };
}

function next(request: MessagesRequest, messages?: Message[]): MessagesRequest {
  return { ...request, messages: messages ?? [...completed, { role: "user", content: "Codename?" }] };
}

function pendingResult(request: MessagesRequest): MessagesRequest {
  return next(request, [{ role: "user", content: [{ type: "tool_result", tool_use_id: "pending-1", content: "ok" }] }]);
}

function resolve(sessions: SessionRecord[], request: MessagesRequest, extra: Record<string, string> = {}, options: Parameters<typeof resolveSession>[3] = {}) {
  return resolveSession(sessions, { ...headers, ...extra }, request, { cwd, ...options });
}

describe("session continuity across reasoning changes", () => {
  const transitions: Array<[string, MessagesRequest, MessagesRequest]> = [
    ["high to xhigh", named("high"), named("xhigh")],
    ["xhigh to high via root alias", named("xhigh"), named("high", sonnet, true)],
    ["named to budget", named("high"), budget(8192)],
    ["budget to named", budget(8192), named("low")],
    ["budget low to budget high", budget(2048), budget(31999)],
    ["budget high to budget low", budget(31999), budget(1024)],
    ["named to off", named("high"), raw({ thinking: { type: "between_tools" }, output_config: { effort: "high" } })],
    ["off to named", raw({ thinking: { type: "between_tools" }, output_config: { effort: "high" } }), named("max")],
  ];

  it.each(transitions)("continues an idle session over completed history: %s", (_name, before, after) => {
    const owner = record(before);
    expect(resolve([owner], next(after))).toMatchObject({ match: owner, reason: "history-prefix" });
    expect(resolve([owner], next(after), { "x-bridge-session": "droid-r" })).toMatchObject({ match: owner, reason: "explicit-id" });
  });

  it.each(transitions)("returns pending tool results to their owner: %s", (_name, before, after) => {
    const owner = record(before, { state: "WAITING_DROID_TOOL", pendingToolIds: ["pending-1"] });
    expect(resolve([owner], pendingResult(after))).toMatchObject({ match: owner, reason: "tool-use-id" });
    expect(resolve([owner], pendingResult(after), { "x-bridge-session": "droid-r" })).toMatchObject({ match: owner });
  });

  it("works for a named high to xhigh with a Factory host id", () => {
    const owner = record(named("high", gpt), { factorySessionId: "host-a", factoryCwd: cwd });
    const request = next(named("xhigh", gpt));
    expect(resolve([owner], request, {}, { hostSessionId: "host-a", provider: "cursor" })).toMatchObject({ match: owner });
  });

  it("does not match when the level is unchanged but history is unrelated", () => {
    const owner = record(named("high"));
    const unrelated = next(named("xhigh"), [
      { role: "user", content: "Something else." },
      { role: "assistant", content: [{ type: "text", text: "Sure." }] },
      { role: "user", content: "Continue" },
    ]);
    expect(resolve([owner], unrelated).match).toBeUndefined();
    expect(codeOf(() => resolve([owner], unrelated, { "x-bridge-session": "droid-r" }))).toMatchObject({ code: "session_context_changed" });
  });

  it("does not match a changed level over a bare first-turn history", () => {
    const owner = record(named("high"));
    expect(resolve([owner], named("xhigh")).match).toBeUndefined();
  });

  describe("unsafe identity changes stay rejected", () => {
    const before = named("high");
    const after = named("xhigh");

    it("rejects a different role", () => {
      const owner = record(before);
      expect(resolve([owner], next(after), { "x-bridge-role": "worker" }).match).toBeUndefined();
      expect(codeOf(() => resolve([owner], next(after), { "x-bridge-role": "worker", "x-bridge-session": "droid-r" })))
        .toMatchObject({ code: "session_context_changed" });
      const pending = record(before, { state: "WAITING_DROID_TOOL", pendingToolIds: ["pending-1"] });
      expect(codeOf(() => resolve([pending], pendingResult(after), { "x-bridge-role": "worker" })))
        .toMatchObject({ code: "session_context_changed" });
    });

    it("rejects a different cwd", () => {
      const owner = record(before);
      const other = { cwd: "/tmp/another-project" };
      expect(resolveSession([owner], headers, next(after), other).match).toBeUndefined();
      expect(codeOf(() => resolveSession([owner], { ...headers, "x-bridge-session": "droid-r" }, next(after), other)))
        .toMatchObject({ code: "session_context_changed" });
      const pending = record(before, { state: "WAITING_DROID_TOOL", pendingToolIds: ["pending-1"] });
      expect(codeOf(() => resolveSession([pending], headers, pendingResult(after), other)))
        .toMatchObject({ code: "session_context_changed" });
    });

    it("rejects a different model", () => {
      const owner = record(before);
      const other = { ...next(after), model: "haiku-test" };
      expect(resolve([owner], other).match).toBeUndefined();
      expect(codeOf(() => resolve([owner], other, { "x-bridge-session": "droid-r" }))).toMatchObject({ code: "session_context_changed" });
      const pending = record(before, { state: "WAITING_DROID_TOOL", pendingToolIds: ["pending-1"] });
      expect(codeOf(() => resolve([pending], { ...pendingResult(after), model: "haiku-test" })))
        .toMatchObject({ code: "session_context_changed" });
    });

    it("rejects a different provider", () => {
      const owner = record(named("high", gpt));
      const wrong = next(named("xhigh", gpt));
      expect(resolve([owner], wrong, {}, { provider: "claude" }).match).toBeUndefined();
      expect(codeOf(() => resolve([owner], wrong, { "x-bridge-session": "droid-r" }, { provider: "claude" })))
        .toMatchObject({ code: "session_context_changed" });
    });

    it("rejects a different Factory host", () => {
      const owner = record(before, { factorySessionId: "host-a", factoryCwd: cwd });
      const request = next(after);
      expect(resolve([owner], request, {}, { hostSessionId: "host-b" }).match).toBeUndefined();
      expect(codeOf(() => resolve([owner], request, { "x-bridge-session": "droid-r" }, { hostSessionId: "host-b" })))
        .toMatchObject({ code: "cross_host_session" });
      const pending = record(before, { state: "WAITING_DROID_TOOL", pendingToolIds: ["pending-1"], factorySessionId: "host-a", factoryCwd: cwd });
      expect(codeOf(() => resolve([pending], pendingResult(after), {}, { hostSessionId: "host-b" })))
        .toMatchObject({ code: "cross_host_session" });
    });

    it("rejects a host id when the record has none, and a missing host when the record has one", () => {
      const anonymous = record(before);
      expect(resolve([anonymous], next(after), {}, { hostSessionId: "host-a" }).match).toBeUndefined();
      const hosted = record(before, { factorySessionId: "host-a", factoryCwd: cwd });
      expect(resolve([hosted], next(after)).match).toBeUndefined();
    });

    it("rejects a changed host cwd", () => {
      const owner = record(before, { factorySessionId: "host-a", factoryCwd: "/tmp/elsewhere" });
      expect(resolve([owner], next(after), {}, { hostSessionId: "host-a" }).match).toBeUndefined();
    });

    it("rejects ended sessions", () => {
      for (const patch of [{ state: "CANCELLED" }, { state: "FAILED" }, { hostEnded: "terminal" }] as Array<Partial<SessionRecord>>) {
        expect(resolve([record(before, patch)], next(after)).match).toBeUndefined();
      }
    });

    it("rejects a changed level when the record has no tools or the request has none", () => {
      expect(resolve([record(before, { toolNames: [] })], next(after)).match).toBeUndefined();
      expect(resolve([record(before)], { ...next(after), tools: [] }).match).toBeUndefined();
    });
  });

  describe("busy sessions", () => {
    it("does not take a new turn while tools are pending", () => {
      const owner = record(named("high"), { state: "WAITING_DROID_TOOL", pendingToolIds: ["pending-1"] });
      const request = next(named("xhigh"));
      expect(codeOf(() => resolve([owner], request))).toMatchObject({ code: "reasoning_switch_busy" });
      expect(codeOf(() => resolve([owner], request, { "x-bridge-session": "droid-r" }))).toMatchObject({ code: "reasoning_switch_busy" });
    });

    it("does not take a new turn while generating or cancelling", () => {
      for (const patch of [{ state: "GENERATING" }, { cancelRequested: true }] as Array<Partial<SessionRecord>>) {
        const owner = record(named("high"), patch);
        expect(codeOf(() => resolve([owner], next(named("xhigh")), { "x-bridge-session": "droid-r" })))
          .toMatchObject({ code: patch.cancelRequested ? "session_context_changed" : "reasoning_switch_busy" });
      }
    });
  });

  it.each([false, true])("rejects changed reasoning on a cancelling callback owner (explicit=%s)", (explicit) => {
    const owner = record(named("high"), { state: "WAITING_DROID_TOOL", pendingToolIds: ["pending-1"], cancelRequested: true });
    expect(codeOf(() => resolve([owner], pendingResult(named("xhigh")), explicit ? { "x-bridge-session": "droid-r" } : {})))
      .toMatchObject({ code: "session_context_changed" });
  });

  describe("named changes do not widen execution ownership", () => {
    it("never lets a pending owner claim another session's results", () => {
      const owner = record(named("high"), { state: "WAITING_DROID_TOOL", pendingToolIds: ["pending-1"] });
      const other = record(named("high"), { bridgeSessionId: "bridge-o", droidSessionId: "droid-o", sdkSessionId: "sdk-o" });
      expect(resolve([owner, other], pendingResult(named("xhigh")))).toMatchObject({ match: owner });
      expect(codeOf(() => resolve([owner, other], pendingResult(named("xhigh")), { "x-bridge-session": "droid-o" })))
        .toMatchObject({ code: "cross_session_tool_result" });
    });

    it("does not guess between two idle transcripts that differ only in level", () => {
      const first = record(named("high"));
      const second = record(named("low"), { bridgeSessionId: "bridge-s", droidSessionId: "droid-s", sdkSessionId: "sdk-s" });
      expect(codeOf(() => resolve([first, second], next(named("max"))))).toMatchObject({ code: "ambiguous_session" });
    });

    it("keeps the unchanged level on the strict context path", () => {
      const owner = record(named("high"));
      expect(resolve([owner], next(named("high")))).toMatchObject({ match: owner });
      expect(resolve([owner], next(named("high", sonnet, true)))).toMatchObject({ match: owner });
    });

    it("does not let a level change replace an unrelated execution field", () => {
      const owner = record(named("high"));
      const request = { ...next(named("xhigh")), model: "other-sonnet" };
      expect(resolve([owner], request).match).toBeUndefined();
    });
  });
});
