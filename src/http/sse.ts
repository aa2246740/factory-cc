import type { ServerResponse } from "node:http";
import type { ContentBlock, MessagesResponse } from "../types.js";

export function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function event(res: ServerResponse, name: string, data: unknown): void {
  res.write(`event: ${name}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function writeMessageSse(res: ServerResponse, message: MessagesResponse): void {
  writeSseHeaders(res);
  event(res, "message_start", {
    type: "message_start",
    message: {
      id: message.id,
      type: "message",
      role: "assistant",
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 },
    },
  });

  message.content.forEach((block, index) => writeBlock(res, index, block));

  event(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
    usage: { output_tokens: message.usage.output_tokens },
  });
  event(res, "message_stop", { type: "message_stop" });
  res.end();
}

function writeBlock(res: ServerResponse, index: number, block: ContentBlock): void {
  if (block.type === "text") {
    event(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    event(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: block.text },
    });
    event(res, "content_block_stop", { type: "content_block_stop", index });
    return;
  }
  if (block.type === "tool_use") {
    event(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    event(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
    });
    event(res, "content_block_stop", { type: "content_block_stop", index });
    return;
  }
  event(res, "content_block_start", { type: "content_block_start", index, content_block: block });
  event(res, "content_block_stop", { type: "content_block_stop", index });
}
