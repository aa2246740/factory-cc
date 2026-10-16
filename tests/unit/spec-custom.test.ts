import { describe, expect, it } from "vitest";
import { observedTools, parseSpecCustomArgs } from "../../scripts/verify-spec-custom.js";

describe("Spec and custom Droid real-path verifier", () => {
  it("requires an explicit implemented feature and a bounded deadline", () => {
    expect(parseSpecCustomArgs(["--feature", "custom", "--timeout", "120000"])).toMatchObject({ feature: "custom", timeoutMs: 120000 });
    expect(() => parseSpecCustomArgs(["--feature", "all"])).toThrow("spec or custom");
    expect(() => parseSpecCustomArgs(["--timeout", "0"])).toThrow("positive integer");
    expect(() => parseSpecCustomArgs(["--timeout", "Infinity"])).toThrow("positive integer");
  });

  it("does not treat proposed calls or request blobs as proof of successful native execution", () => {
    const calls = observedTools([
      { type: "assistant", sessionId: "native-parent", message: { content: [{ type: "tool_use", name: "mcp__droid__Task", id: "actual-task", input: { subagent_type: "relay-verifier" } }] } },
      { type: "api-request-blob", sessionId: "native-parent", message: { content: [{ type: "tool_result", tool_use_id: "actual-task", content: "historical success" }] } },
      { type: "api-request-blob", sessionId: "native-parent", message: { content: [{ type: "tool_use", name: "Write", id: "historical-write", input: {} }] } },
      { type: "user", sessionId: "native-parent", message: { content: [{ type: "tool_result", tool_use_id: "different-task", content: "unrelated success" }] } },
    ]);
    expect(calls).toEqual([{ name: "mcp__droid__Task", id: "actual-task", input: { subagent_type: "relay-verifier" }, sessionId: "native-parent", resultSeen: false, isError: false }]);
  });

  it("preserves rejected host tools as failures even when their call was observed", () => {
    const [call] = observedTools([
      { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__droid__ExitSpecMode", id: "exit", input: { plan: "concrete plan" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "exit", is_error: true, content: "not permitted in this exec session" }] } },
    ]);
    expect(call).toMatchObject({ name: "mcp__droid__ExitSpecMode", resultSeen: true, isError: true });
  });
});
