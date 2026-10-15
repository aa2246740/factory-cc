import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";
import { SseWriter } from "../../src/http/sse-stream.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import { BridgeError } from "../../src/types.js";
import { contentFromSse } from "../helpers/sse.js";

function collect(): { res: ServerResponse; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const res = stream as unknown as ServerResponse;
  res.writeHead = ((status: number, headers: Record<string, string>) => {
    stream.write(`HTTP ${status} ${JSON.stringify(headers)}\n`);
    return res;
  }) as ServerResponse["writeHead"];
  return {
    res,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("live SSE", () => {
  it("returns the exact wire transcript with traces, original whitespace and tool inputs", () => {
    const { res, text } = collect();
    const writer = new SseWriter(res, { id: "msg_wire", model: "relay-chat" });
    writer.toolTrace("Read", " file.ts ");
    writer.textDelta("\n  Answer");
    writer.textDelta(" \n");
    const tool = { type: "tool_use" as const, id: "tool_1", name: "CompleteMission", input: { status: "done", details: [1, 2] } };
    const response = assistantMessage("relay-chat", [{ type: "text", text: "Answer" }, tool], "tool_use");
    const completed = writer.completeContent(response);
    expect(text()).not.toContain("event: message_stop");
    writer.textDelta("ignored after content completion");
    expect(writer.finish(response)).toEqual(completed);
    expect(writer.finish(response)).toEqual(completed);
    expect(completed).toEqual([
      { type: "text", text: "\n[Read]  file.ts \n\n  Answer \n" },
      tool,
    ]);
    expect(contentFromSse(text())).toEqual(completed);
    expect(text()).not.toContain("ignored after content completion");
    expect(text().match(/event: message_stop/g)).toHaveLength(1);
  });

  it("does not suppress any final text blocks when only a tool trace was streamed", () => {
    const { res, text } = collect();
    const writer = new SseWriter(res, { id: "msg_fallback", model: "relay-chat" });
    writer.toolTrace("Read", "file.ts");
    const response = assistantMessage("relay-chat", [
      { type: "text", text: "  first answer\n" },
      { type: "text", text: "\nsecond answer  " },
    ], "end_turn");
    const completed = writer.finish(response);
    expect(completed).toEqual([{ type: "text", text: "\n[Read] file.ts\n" }, ...response.content]);
    expect(contentFromSse(text())).toEqual(completed);
  });

  it("terminates a partial response with an error event, never a successful end_turn", () => {
    const { res, text } = collect();
    const writer = new SseWriter(res, { id: "msg_failure", model: "relay-chat" });
    writer.textDelta("partial output");
    writer.fail(new BridgeError(504, "sdk_turn_timeout", "SDK timed out"));
    writer.textDelta("late output must be ignored");
    writer.finish(assistantMessage("relay-chat", [{ type: "text", text: "late completion" }], "end_turn"));
    writer.fail(new Error("second failure"));
    expect(text()).toContain('event: error\ndata: {"type":"error","error":{"type":"sdk_turn_timeout","message":"SDK timed out"}}');
    expect(text()).toContain("partial output");
    expect(text()).not.toContain("event: message_stop");
    expect(text()).not.toContain("end_turn");
    expect(text()).not.toContain("late output");
    expect(text()).not.toContain("late completion");
    expect(text()).not.toContain("second failure");
  });

  it("emits token deltas before message_stop", () => {
    const { res, text } = collect();
    const writer = new SseWriter(res, { id: "msg_test", model: "relay-chat" });
    writer.start();
    writer.textDelta("Hel");
    writer.textDelta("lo");
    writer.finish(assistantMessage("relay-chat", [{ type: "text", text: "Hello" }], "end_turn", {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
    }));
    const raw = text();
    expect(raw.indexOf("Hel")).toBeLessThan(raw.indexOf("event: message_stop"));
    expect(raw).toContain("event: content_block_delta");
    expect(raw).toContain("\"text\":\"Hel\"");
    expect(raw).toContain("\"text\":\"lo\"");
    expect(raw).toContain("cache_read_input_tokens");
    expect(raw).toContain("event: message_stop");
  });
});
