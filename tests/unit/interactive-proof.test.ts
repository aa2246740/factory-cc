import { describe, expect, it } from "vitest";
import { verifyGeneratedDroidDelegation, type NativeProofRow } from "../../scripts/interactive-proof.js";

const expected = { sum: 56, nonce: "fixture-not-in-prompt" };
const prompt = "Read input.json and calculate its sum and nonce.";
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
