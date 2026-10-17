import { describe, expect, it } from "vitest";
import { nativePromptHasFinalResponse, verifyGeneratedDroidDelegation, verifyNaturalDroidGeneration, verifyOrdinaryChatRouting, verifyTerminalLifecycleDelivery, type NativeProofRow } from "../../scripts/interactive-proof.js";

const expected = { sum: 56, nonce: "fixture-not-in-prompt" };
const prompt = "Read input.json and calculate its sum and nonce.";
describe("terminal lifecycle delivery proof", () => {
  it("detects the reserved delivery failure and other actual hook exit failures", () => {
    for (const reason of ["Exit code 1", "Factory lifecycle bridge unavailable; event delivery failed."]) {
      expect(verifyTerminalLifecycleDelivery(`   Hooks SessionEnd\n    └─ hook command\n      └─ ${reason}`).status).toBe("FAIL");
    }
  });
  it("does not confuse ordinary command exit text with a failed lifecycle hook", () => {
    expect(verifyTerminalLifecycleDelivery("An ordinary shell returned Exit code 1.\n   Hooks SessionEnd → 1 completed").status).toBe("PASS");
  });
});
const row = (sid: string, type: string, content: unknown[]): NativeProofRow => ({ sdkSessionId: sid, type, message: { content } });
function fixture(): NativeProofRow[] { return [
  row("parent", "user", [{ type: "text", text: "Use Factory Task to delegate to the project custom droid relay-json-auditor. Do not read it yourself." }]),
  row("parent", "assistant", [{ type: "tool_use", id: "task1", name: "mcp__droid__Task", input: { subagent_type: "relay-json-auditor", await: true, prompt } }]),
  row("parent", "user", [{ type: "tool_result", tool_use_id: "task1", content: `session_id: 00000000-1111-2222-3333-444444444444\n${JSON.stringify(expected)}` }]),
  row("parent", "assistant", [{ type: "text", text: JSON.stringify(expected) }]),
  row("child", "user", [{ type: "text", text: `Custom child instructions.\n${prompt}` }]),
  row("child", "assistant", [{ type: "tool_use", id: "read1", name: "Read", input: { file_path: "/owned/input.json" } }]),
  row("child", "user", [{ type: "tool_result", tool_use_id: "read1", content: JSON.stringify({ a: 19, b: 37, nonce: expected.nonce }) }]),
  row("child", "assistant", [{ type: "text", text: JSON.stringify(expected) }]),
]; }
describe("independent generated Droid delegation proof", () => {
  it("joins parent Task, its exact result, a distinct child prompt and Read result", () => {
    expect(verifyGeneratedDroidDelegation(fixture(), expected).status).toBe("PASS");
  });
  it("rejects final-string-only proof and an unrelated child's identical result", () => {
    expect(verifyGeneratedDroidDelegation([row("parent", "assistant", [{ type: "text", text: JSON.stringify(expected) }])], expected).status).toBe("FAIL");
    const unrelated = fixture(); unrelated[4] = row("child", "user", [{ type: "text", text: "Unrelated task" }]);
    expect(verifyGeneratedDroidDelegation(unrelated, expected).status).toBe("FAIL");
  });
  it("rejects failed or mismatched tool callbacks despite correct final text", () => {
    const failed = fixture(); (failed[2]!.message!.content as Array<Record<string, unknown>>)[0]!.is_error = true;
    expect(verifyGeneratedDroidDelegation(failed, expected).status).toBe("FAIL");
    const mismatch = fixture(); (mismatch[6]!.message!.content as Array<Record<string, unknown>>)[0]!.tool_use_id = "other-read";
    expect(verifyGeneratedDroidDelegation(mismatch, expected).status).toBe("FAIL");
  });
  it("rejects parent file reads during delegation, prompt-leaked nonce and wrong sums", () => {
    const parentRead = fixture(); parentRead.splice(1, 0, row("parent", "assistant", [{ type: "tool_use", id: "read-parent", name: "Read", input: { file_path: "/owned/input.json" } }]));
    expect(verifyGeneratedDroidDelegation(parentRead, expected).status).toBe("FAIL");
    const leaked = fixture(); leaked[4] = row("child", "user", [{ type: "text", text: `${prompt}\n${expected.nonce}` }]);
    expect(verifyGeneratedDroidDelegation(leaked, expected).status).toBe("FAIL");
    const wrong = fixture(); wrong[7] = row("child", "assistant", [{ type: "text", text: JSON.stringify({ ...expected, sum: 57 }) }]);
    expect(verifyGeneratedDroidDelegation(wrong, expected).status).toBe("FAIL");
  });
});

const natural = { prompt: "创建一个名为 json-auditor 的只读自定义助手。现在只创建，不要运行。", skillBody: "# Generate\nExecute the installed command safely and stop.",
  skillDescription: "Create a new reusable custom agent definition.", generatedPath: "/owned/.factory/droids/json-auditor.md" };
function naturalFixture(): NativeProofRow[] { return [
  row("parent", "user", [{ type: "text", text: natural.prompt }, { type: "text", text: `Available skills (name: when to use it):\nrelay-droid: ${natural.skillDescription}` }]),
  row("parent", "assistant", [{ type: "tool_use", id: "skill1", name: "mcp__droid__Skill", input: { skill: "relay-droid" } }]),
  row("parent", "user", [{ type: "tool_result", tool_use_id: "skill1", content: natural.skillBody }]),
  row("parent", "assistant", [{ type: "tool_use", id: "bash1", name: "Bash", input: { command: "'/owned/.factory/commands/relay-droid.sh' --name 'json-auditor' --description 'Read JSON'" } }]),
  row("parent", "user", [{ type: "tool_result", tool_use_id: "bash1", content: `Created Droid: ${natural.generatedPath}\nRELAY_DROID_GENERATION_COMPLETE` }]),
  row("parent", "assistant", [{ type: "text", text: "已创建配置，未运行助手。" }]),
]; }
describe("natural-language discovery proof", () => {
  it("joins advertised skill, its complete callback, and the subsequent successful generator", () => {
    expect(verifyNaturalDroidGeneration(naturalFixture(), natural).status).toBe("PASS");
    expect(nativePromptHasFinalResponse(naturalFixture(), natural.prompt)).toBe(true);
    expect(nativePromptHasFinalResponse(naturalFixture().slice(0, -1), natural.prompt)).toBe(false);
  });
  it("rejects an explicit skill hint, guessed registry, partial or failed callback", () => {
    expect(verifyNaturalDroidGeneration(naturalFixture(), { ...natural, prompt: "Use Skill relay-droid" }).status).toBe("FAIL");
    const missingRegistry = naturalFixture(); missingRegistry[0] = row("parent", "user", [{ type: "text", text: natural.prompt }]);
    expect(verifyNaturalDroidGeneration(missingRegistry, natural).status).toBe("FAIL");
    const partial = naturalFixture(); (partial[2]!.message!.content as Array<Record<string, unknown>>)[0]!.content = "# Generate";
    expect(verifyNaturalDroidGeneration(partial, natural).status).toBe("FAIL");
    const failed = naturalFixture(); (failed[2]!.message!.content as Array<Record<string, unknown>>)[0]!.is_error = true;
    expect(verifyNaturalDroidGeneration(failed, natural).status).toBe("FAIL");
  });
  it("accepts Factory's abbreviated real description but rejects an unrelated prefix and title-only completion", () => {
    const abbreviated = naturalFixture();
    const description = `${natural.skillDescription} Additional routing guidance.`;
    abbreviated[0] = row("parent", "user", [{ type: "text", text: `${natural.prompt}\nAvailable skills (name: when to use it):\nrelay-droid: ${natural.skillDescription}…` }]);
    expect(verifyNaturalDroidGeneration(abbreviated, { ...natural, skillDescription: description }).status).toBe("PASS");
    expect(verifyNaturalDroidGeneration(abbreviated, { ...natural, skillDescription: "An unrelated skill description." }).status).toBe("FAIL");
    const title = [row("title", "user", [{ type: "text", text: natural.prompt }]), row("title", "assistant", [{ type: "text", text: "Create JSON auditor" }])];
    expect(nativePromptHasFinalResponse(title, natural.prompt, "Available skills (name:")).toBe(false);
  });
  it("rejects shell work preceding discovery, wrong callback IDs and text-only success", () => {
    const early = naturalFixture(); [early[1], early[3]] = [early[3]!, early[1]!];
    expect(verifyNaturalDroidGeneration(early, natural).status).toBe("FAIL");
    const mismatch = naturalFixture(); (mismatch[4]!.message!.content as Array<Record<string, unknown>>)[0]!.tool_use_id = "unrelated";
    expect(verifyNaturalDroidGeneration(mismatch, natural).status).toBe("FAIL");
    expect(verifyNaturalDroidGeneration([naturalFixture()[0]!, naturalFixture()[5]!], natural).status).toBe("FAIL");
  });
  it("rejects automatic invocation, direct definition writes and premature fixture reads", () => {
    for (const [name, input] of [["mcp__droid__Task", { subagent_type: "json-auditor" }], ["Write", { file_path: natural.generatedPath }], ["Read", { file_path: "/owned/input.json" }]] as const) {
      const altered = naturalFixture(); altered.splice(5, 0, row("parent", "assistant", [{ type: "tool_use", id: "extra", name, input }]));
      expect(verifyNaturalDroidGeneration(altered, natural).status).toBe("FAIL");
    }
  });
  it("requires ordinary chat's own exact answer and no tool invocation", () => {
    const prompt = "法国的首都是哪里？只回答城市中文名。";
    const chat = [row("parent", "user", [{ type: "text", text: prompt }]), row("parent", "assistant", [{ type: "text", text: "巴黎" }])];
    expect(verifyOrdinaryChatRouting([...naturalFixture(), ...chat], prompt, "巴黎").status).toBe("PASS");
    const tool = row("parent", "assistant", [{ type: "tool_use", id: "skill-chat", name: "mcp__droid__Skill", input: { skill: "relay-droid" } }]);
    expect(verifyOrdinaryChatRouting([chat[0]!, tool, chat[1]!], prompt, "巴黎").status).toBe("FAIL");
  });
});
