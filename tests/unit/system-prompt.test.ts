import { describe, expect, it } from "vitest";
import { buildDynamicUserPrompt, buildPresetSystemPrompt, STABLE_DROID_APPEND } from "../../src/runtime/system-prompt.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";

function request(overrides: Partial<RuntimeRequest> = {}): RuntimeRequest {
  return {
    role: "orchestrator",
    session: {
      bridgeSessionId: "sess",
      state: "GENERATING",
      role: "orchestrator",
      model: "relay-orchestrator",
      toolNames: ["StartMissionRun"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pendingToolIds: [],
      cancelRequested: false,
      notes: [],
      usage: { input_tokens: 0, output_tokens: 0, estimated: true },
    },
    headers: {},
    request: {
      model: "relay-orchestrator",
      max_tokens: 32,
      system: "Droid host system that must stay dynamic",
      messages: [{ role: "user", content: "fix the filter now" }],
      tools: [{ name: "StartMissionRun", input_schema: { type: "object", properties: {} } }],
    },
    ...overrides,
  };
}

describe("T3-style system prompt", () => {
  it("uses claude_code preset plus a stable append, not a full replace", () => {
    const prompt = buildPresetSystemPrompt();
    expect(prompt.type).toBe("preset");
    expect(prompt.preset).toBe("claude_code");
    expect(prompt.append).toBe(STABLE_DROID_APPEND);
    expect(prompt.snapshot).toBe(true);
    expect(prompt.excludeDynamicSections).toBe(true);
    expect(prompt.append).not.toContain("orchestrator");
    expect(prompt.append).not.toContain("fix the filter");
    expect(prompt.append).toContain("StartMissionRun");
  });

  it("puts role, user text, and Droid system at the end of the user prompt", () => {
    const dynamic = buildDynamicUserPrompt(request());
    expect(dynamic.startsWith("fix the filter now")).toBe(true);
    expect(dynamic).toContain("Droid role: orchestrator");
    expect(dynamic.indexOf("Host context (dynamic)")).toBeGreaterThan(dynamic.indexOf("fix the filter now"));
    expect(buildPresetSystemPrompt().append.includes(dynamic)).toBe(false);
  });
});
