import { afterEach, describe, expect, it, vi } from "vitest";
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

  describe("one waiter per call", () => {
    afterEach(() => vi.useRealTimers());
    const box = (callId = "toolu_w") => {
      const mailbox = new ToolMailbox();
      mailbox.registerCall({ callId, originalName: "Read", mcpName: "Read", input: {} });
      return mailbox;
    };

    it("answers a second wait on the same id with a 409 and leaves the first waiter intact", async () => {
      const mailbox = box();
      const first = mailbox.wait("toolu_w", 1000);
      await expect(mailbox.wait("toolu_w", 1000)).rejects.toMatchObject({ status: 409, code: "duplicate_tool_wait" });
      expect(mailbox.submitResult({ callId: "toolu_w", content: "for the first waiter" })).toBe("accepted");
      expect((await first).content).toBe("for the first waiter");
    });

    it("lets the id be waited for again once the waiter timed out, and a timeout never touches another waiter", async () => {
      vi.useFakeTimers();
      const mailbox = box();
      mailbox.registerCall({ callId: "toolu_other", originalName: "Read", mcpName: "Read", input: {} });
      const other = mailbox.wait("toolu_other", 10_000);
      const expired = mailbox.wait("toolu_w", 100);
      const timedOut = expect(expired).rejects.toMatchObject({ status: 504, code: "tool_wait_timeout" });
      await vi.advanceTimersByTimeAsync(100);
      await timedOut;
      const again = mailbox.wait("toolu_w", 10_000);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(mailbox.submitResult({ callId: "toolu_w", content: "late but welcome" })).toBe("accepted");
      expect((await again).content).toBe("late but welcome");
      // The unrelated waiter was neither removed nor rejected by the other call's timeout.
      expect(mailbox.submitResult({ callId: "toolu_other", content: "other result" })).toBe("accepted");
      expect((await other).content).toBe("other result");
    });

    it("does not let a timeout of an old wait remove a waiter that replaced it after cancel", async () => {
      vi.useFakeTimers();
      const mailbox = box();
      const cancelled = mailbox.wait("toolu_w", 100);
      const settled = expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
      mailbox.cancel("session ended");
      await settled;
      const replacement = mailbox.wait("toolu_w", 10_000);
      await vi.advanceTimersByTimeAsync(500);
      expect(mailbox.submitResult({ callId: "toolu_w", content: "still waiting" })).toBe("accepted");
      expect((await replacement).content).toBe("still waiting");
    });
  });

  describe("duplicate results", () => {
    const text = (content: string) => ({ callId: "toolu_d", content });
    const box = () => {
      const mailbox = new ToolMailbox();
      mailbox.registerCall({ callId: "toolu_d", originalName: "Read", mcpName: "Read", input: {} });
      return mailbox;
    };

    it("stay idempotent when identical, whether or not a waiter consumed the first", async () => {
      const early = box();
      expect(early.submitResult(text("same"))).toBe("accepted");
      expect(early.submitResult(text("same"))).toBe("duplicate");
      const waited = box();
      const pending = waited.wait("toolu_d", 1000);
      waited.submitResult(text("same"));
      await pending;
      expect(waited.submitResult(text("same"))).toBe("duplicate");
      const blocks = box();
      const image = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }];
      blocks.submitResult({ callId: "toolu_d", content: image });
      expect(blocks.submitResult({ callId: "toolu_d", content: structuredClone(image) })).toBe("duplicate");
      // Key order of an equal block is not a difference.
      expect(blocks.submitResult({ callId: "toolu_d", content: [{ source: { data: "AAAA", media_type: "image/png", type: "base64" }, type: "image" }] })).toBe("duplicate");
    });

    it("are refused with a 409 when their content or error flag differs, before and after delivery", async () => {
      const early = box();
      early.submitResult(text("first"));
      expect(() => early.submitResult(text("second"))).toThrowError(expect.objectContaining({ status: 409, code: "conflicting_tool_result" }));
      expect(() => early.submitResult({ ...text("first"), isError: true })).toThrowError(expect.objectContaining({ status: 409, code: "conflicting_tool_result" }));
      const waited = box();
      const pending = waited.wait("toolu_d", 1000);
      waited.submitResult(text("first"));
      expect((await pending).content).toBe("first");
      expect(() => waited.submitResult(text("changed after delivery"))).toThrowError(expect.objectContaining({ code: "conflicting_tool_result" }));
      // The original result stays what the waiter was given.
      expect((await waited.wait("toolu_d", 1000)).content).toBe("first");
    });
  });
});
