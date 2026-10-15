import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";
import { SseWriter } from "../../src/http/sse-stream.js";
import { assistantMessage } from "../../src/protocol/messages.js";

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
