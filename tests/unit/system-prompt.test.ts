import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDynamicUserPrompt, buildDynamicUserContent, buildHostContext, buildInitialUserContent, buildPresetSystemPrompt, STABLE_DROID_APPEND } from "../../src/runtime/system-prompt.js";
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
    expect(prompt).not.toHaveProperty("snapshot");
    expect(prompt).not.toHaveProperty("excludeDynamicSections");
    expect(prompt.append).not.toContain("orchestrator");
    expect(prompt.append).not.toContain("fix the filter");
    expect(prompt.append).toContain("StartMissionRun");
  });

  it("preserves Droid host instructions without adding a role inferred from the model tag", () => {
    const dynamic = buildDynamicUserPrompt(request());
    expect(dynamic.startsWith("fix the filter now")).toBe(true);
    expect(dynamic).toContain("Droid host system that must stay dynamic");
    expect(dynamic).not.toContain("Droid role:");
    expect(dynamic).not.toContain("You are the Droid Mission orchestrator");
    expect(dynamic.indexOf("Host context (dynamic)")).toBeGreaterThan(dynamic.indexOf("fix the filter now"));
    expect(buildPresetSystemPrompt().append.includes(dynamic)).toBe(false);
  });

  it.each(["orchestrator", "worker", "validator", "chat", "unknown"] as const)("uses host context without injecting the inherited %s model role or workflow", (role) => {
    const input = request({ role });
    const host = "You are a general-purpose worker.\nSubagent contract: Complete only the assigned readiness check, then return findings to the parent.";
    input.request.system = host;
    expect(buildHostContext(input)).toBe(`Host context (dynamic):\n${host}`);
    expect(input.role).toBe(role);
  });

  it("preserves Factory Task instructions under an inherited orchestrator model", () => {
    const input = request();
    const host = "You are a general-purpose worker. Complete only the assigned task, then stop.";
    input.request.system = host;
    input.request.tools = ["Read", "LS", "Execute", "Edit", "Grep", "Glob", "Create", "ToolSearch", "Skill"]
      .map((name) => ({ name, input_schema: { type: "object", properties: {} } }));
    input.request.messages = [{ role: "user", content: "# Task Tool Invocation\nSubagent type: worker\nVerify Mission dependencies. Do not modify files." }];
    const dynamic = buildDynamicUserPrompt(input, "/work");
    expect(dynamic).toContain(host);
    expect(dynamic).toContain("Verify Mission dependencies. Do not modify files.");
    expect(dynamic).not.toContain("Droid role:");
    expect(dynamic).not.toContain("Mission orchestrator");
    expect(dynamic).not.toContain("EndFeatureRun");
  });

  it.each(["worker", "validator", "orchestrator"] as const)("does not turn a title helper with the inherited %s model tag into a Mission agent", (role) => {
    const input = request({ role, headers: { "x-bridge-role": role } });
    const host = "Return a concise title for this coding session. Return only the title, without quotes or additional text.";
    const subject = "Fix the completed filter and task counts.";
    input.request.model = `relay-${role}`;
    input.request.system = host;
    input.request.tools = [];
    input.request.messages = [{ role: "user", content: subject }];
    input.session.role = role;
    input.session.model = input.request.model;
    input.session.toolNames = [];

    expect(buildHostContext(input)).toBe(`Host context (dynamic):\n${host}`);
    expect(buildDynamicUserContent(input, "/work")).toEqual([
      { type: "text", text: subject },
      { type: "text", text: `Host context (dynamic):\n${host}\n\nWorking directory (Claude Code cwd): /work` },
    ]);
    expect(input.request.tools).toEqual([]);
  });

  it.each([undefined, "", " \n "])("keeps a role fallback when host instructions are absent: %j", (system) => {
    const input = request({ role: "worker" });
    input.request.system = system;
    const context = buildHostContext(input);
    expect(context).toContain("Droid role: worker.");
    expect(context).toContain("You are the Droid Mission worker.");
    expect(context).not.toContain("Host context (dynamic)");
    expect(context).not.toContain("Mission orchestrator");
  });

  it("requires real Mission controls before appending an orchestrator fallback", () => {
    const input = request();
    input.request.system = undefined;
    input.request.tools = [{ name: "Task", input_schema: { type: "object", properties: {} } }];
    expect(buildHostContext(input)).toBe("Droid role: orchestrator.");
    input.request.tools.push({ name: "ProposeMission", input_schema: { type: "object", properties: {} } });
    expect(buildHostContext(input)).toContain("You are the Droid Mission orchestrator");
    expect(buildHostContext(input)).not.toContain("StartMissionRun");
  });

  it("uses only the explicitly bound Mission directory, never another directory in HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "relay-home-"));
    const mission = join(home, ".factory/missions/m1");
    mkdirSync(mission, { recursive: true });
    for (const name of ["features.json", "validation-contract.md", "validation-state.json", "AGENTS.md", "services.yaml"]) {
      writeFileSync(join(mission, name), "{}");
    }
    const previous = process.env.BRIDGE_DROID_HOME;
    process.env.BRIDGE_DROID_HOME = home;
    const otherMission = join(home, ".factory/missions/current-not-created-yet");
    const dynamic = buildDynamicUserPrompt(request({ headers: { "x-bridge-mission-dir": otherMission } }), "/tmp/current-tiny-tasks");
    const unbound = buildDynamicUserPrompt(request(), "/tmp/current-tiny-tasks");
    if (previous === undefined) delete process.env.BRIDGE_DROID_HOME;
    else process.env.BRIDGE_DROID_HOME = previous;
    expect(dynamic).toContain("Working directory (Claude Code cwd): /tmp/current-tiny-tasks");
    expect(dynamic).toContain(otherMission);
    expect(dynamic).not.toContain(mission);
    expect(unbound).not.toContain(mission);
    expect(dynamic.indexOf(otherMission)).toBeGreaterThan(dynamic.indexOf("fix the filter now"));
    expect(STABLE_DROID_APPEND).not.toContain(mission);
  });

  it("keeps image content and sends neither old user turns nor duplicate MCP results on a continuation", () => {
    const input = request();
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "image-data" } };
    input.request.messages = [
      { role: "user", content: "an earlier task" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: [image, { type: "text", text: "inspect this" }, { type: "tool_result", tool_use_id: "already-delivered", content: "old-result" }] },
    ];
    const content = buildDynamicUserContent(input, "/work", { includeContext: false });
    expect(content).toEqual([image, { type: "text", text: "inspect this" }]);
    expect(JSON.stringify(content)).not.toMatch(/earlier|old-result|Host context/);
  });

  it("retains cold imported history as reference with images, without replaying tool calls", () => {
    const input = request();
    input.request.messages = [
      { role: "user", content: "Remember the project uses PORT 8123" },
      { role: "assistant", content: [{ type: "tool_use", id: "old-call", name: "Read", input: { file_path: "/work/file" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "old-call", content: [{ type: "image", source: { type: "url", url: "https://example.test/image.png" } }] }] },
      { role: "assistant", content: "The file was read." },
      { role: "user", content: "What port are we using?" },
    ];
    const content = buildInitialUserContent(input, "/work");
    expect(JSON.stringify(content)).toContain("PORT 8123");
    expect(content.some((block) => block.type === "image")).toBe(true);
    expect(content.some((block) => block.type === "tool_use" || block.type === "tool_result")).toBe(false);
    expect(JSON.stringify(content)).toContain("What port are we using?");
  });

  it("keeps a native slash command in the last text block when adding host context", () => {
    const input = request();
    input.request.messages = [{ role: "user", content: "/compact Preserve the current task" }];
    const content = buildDynamicUserContent(input, "/work");
    expect(content.at(-1)).toEqual({ type: "text", text: "/compact Preserve the current task" });
    expect(content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Host context") });
  });

  it("distinguishes Factory skill/task registries from Claude Code's native registries", () => {
    expect(STABLE_DROID_APPEND).toContain("mcp__droid__Skill");
    expect(STABLE_DROID_APPEND).toContain("mcp__droid__Task");
    expect(STABLE_DROID_APPEND).toContain("mcp__droid__ToolSearch");
    expect(STABLE_DROID_APPEND).toContain("Native Claude Code skills and subagents remain separate");
  });
});
