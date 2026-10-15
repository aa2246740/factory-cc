import type { ServerResponse } from "node:http";
import type { ContentBlock, MessagesResponse, Usage } from "../types.js";
import { writeSseHeaders } from "./sse.js";

function event(res: ServerResponse, name: string, data: unknown): void {
  res.write(`event: ${name}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Live Anthropic SSE writer. Token deltas go out as they arrive
 * (includePartialMessages), instead of dumping the finished message at once.
 */
export class SseWriter {
  private started = false;
  private index = 0;
  private textOpen = false;
  private textIndex = 0;
  private finished = false;
  private streamedText = false;
  private inputTokens = 0;

  constructor(
    private readonly res: ServerResponse,
    private readonly meta: { id: string; model: string },
  ) {}

  get headersSent(): boolean {
    return this.started;
  }

  start(usage?: Pick<Usage, "input_tokens">): void {
    if (this.started) return;
    this.inputTokens = usage?.input_tokens ?? 0;
    writeSseHeaders(this.res);
    event(this.res, "message_start", {
      type: "message_start",
      message: {
        id: this.meta.id,
        type: "message",
        role: "assistant",
        model: this.meta.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
    this.started = true;
  }

  textDelta(text: string): void {
    if (!text) return;
    this.start();
    if (!this.textOpen) {
      this.textIndex = this.index;
      event(this.res, "content_block_start", {
        type: "content_block_start",
        index: this.textIndex,
        content_block: { type: "text", text: "" },
      });
      this.textOpen = true;
    }
    event(this.res, "content_block_delta", {
      type: "content_block_delta",
      index: this.textIndex,
      delta: { type: "text_delta", text },
    });
    this.streamedText = true;
  }

  toolTrace(name: string, detail: string): void {
    this.textDelta(`\n[${name}] ${detail}\n`);
  }

  closeText(): void {
    if (!this.textOpen) return;
    event(this.res, "content_block_stop", { type: "content_block_stop", index: this.textIndex });
    this.textOpen = false;
    this.index = this.textIndex + 1;
  }

  toolUse(block: Extract<ContentBlock, { type: "tool_use" }>): void {
    this.start();
    this.closeText();
    event(this.res, "content_block_start", {
      type: "content_block_start",
      index: this.index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    event(this.res, "content_block_delta", {
      type: "content_block_delta",
      index: this.index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
    });
    event(this.res, "content_block_stop", { type: "content_block_stop", index: this.index });
    this.index += 1;
  }

  finish(message: MessagesResponse): void {
    if (this.finished) return;
    this.start(message.usage);
    this.closeText();
    for (const block of message.content) {
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        if (this.streamedText) continue;
        this.textDelta(block.text);
        this.closeText();
      } else if (block.type === "tool_use" && "id" in block && typeof block.id === "string" && typeof block.name === "string") {
        this.toolUse({ type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} });
      }
    }
    event(this.res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
      usage: {
        output_tokens: message.usage.output_tokens,
        cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
        cache_read_input_tokens: message.usage.cache_read_input_tokens,
      },
    });
    event(this.res, "message_stop", { type: "message_stop" });
    this.res.end();
    this.finished = true;
  }
}
