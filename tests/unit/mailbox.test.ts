import { describe, expect, it } from "vitest";
import { ToolMailbox } from "../../src/relay/mailbox.js";
import { BridgeError } from "../../src/types.js";

describe("ToolMailbox", () => {
  it("delivers a result that arrives after the waiter", async () => {
    const box = new ToolMailbox();
    box.registerCall({ callId: "toolu_1", originalName: "Read", mcpName: "Read", input: {} });
    const pending = box.wait("toolu_1", 1000);
    expect(box.submitResult({ callId: "toolu_1", content: "hello" })).toBe("accepted");
    const result = await pending;
    expect(result.content).toBe("hello");
  });

  it("stores a result that arrives before the waiter", async () => {
    const box = new ToolMailbox();
    box.registerCall({ callId: "toolu_2", originalName: "Read", mcpName: "Read", input: {} });
    expect(box.submitResult({ callId: "toolu_2", content: "early" })).toBe("accepted");
    const result = await box.wait("toolu_2", 1000);
    expect(result.content).toBe("early");
  });

  it("dedupes the same result id", () => {
    const box = new ToolMailbox();
    box.registerCall({ callId: "toolu_3", originalName: "Read", mcpName: "Read", input: {} });
    expect(box.submitResult({ callId: "toolu_3", content: "a" })).toBe("accepted");
    expect(box.submitResult({ callId: "toolu_3", content: "a" })).toBe("duplicate");
  });

  it("rejects unknown ids", () => {
    const box = new ToolMailbox();
    expect(() => box.submitResult({ callId: "missing", content: "x" })).toThrow(BridgeError);
  });

  it("keeps two identical-name calls distinct", async () => {
    const box = new ToolMailbox();
    box.registerCall({ callId: "a", originalName: "Read", mcpName: "Read", input: { n: 1 } });
    box.registerCall({ callId: "b", originalName: "Read", mcpName: "Read", input: { n: 2 } });
    const first = box.wait("a", 1000);
    box.submitResult({ callId: "b", content: "second" });
    box.submitResult({ callId: "a", content: "first" });
    expect((await first).content).toBe("first");
    expect((await box.wait("b", 1000)).content).toBe("second");
  });
});
