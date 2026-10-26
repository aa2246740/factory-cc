import type { ServerResponse } from "node:http";
import { BridgeError, type ContentBlock, type MessagesResponse, type Usage } from "../types.js";
import { writeSseHeaders } from "./sse.js";

/** Same cadence as the Anthropic API, so proxies and clients keep an idle stream open. */
export const PING_INTERVAL_MS = 15_000;

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
  private contentComplete = false;
  private readonly wireContent: ContentBlock[] = [];
  private inputTokens = 0;
  private pingTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly res: ServerResponse,
    private readonly meta: { id: string; model: string },
    private readonly pingMs = PING_INTERVAL_MS,
  ) {}

  get headersSent(): boolean {
    return this.started;
  }

  start(usage?: Pick<Usage, "input_tokens">): void {
    if (this.started || this.finished || this.res.destroyed) return;
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
    this.startPings();
  }

  /** Stop the keepalive. Called on every exit path; safe to call repeatedly. */
  dispose = (): void => {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.res.off("close", this.dispose);
  };

  private startPings(): void {
    this.res.once("close", this.dispose);
    this.pingTimer = setInterval(() => {
      if (this.finished || this.res.destroyed || this.res.writableEnded) {
        this.dispose();
        return;
      }
      this.res.write('event: ping\ndata: {"type": "ping"}\n\n');
    }, this.pingMs);
    this.pingTimer.unref();
  }

  textDelta(text: string): void {
    this.writeTextDelta(text, true);
  }

  private writeTextDelta(text: string, modelText: boolean): void {
    if (!text || this.finished || this.contentComplete || this.res.destroyed) return;
    this.start();
    if (!this.textOpen) {
      this.textIndex = this.index;
      this.wireContent[this.textIndex] = { type: "text", text: "" };
      event(this.res, "content_block_start", {
        type: "content_block_start",
        index: this.textIndex,
        content_block: { type: "text", text: "" },
      });
      this.textOpen = true;
    }
    (this.wireContent[this.textIndex] as { type: "text"; text: string }).text += text;
    event(this.res, "content_block_delta", {
      type: "content_block_delta",
      index: this.textIndex,
      delta: { type: "text_delta", text },
    });
    if (modelText) this.streamedText = true;
  }

  toolTrace(name: string, detail: string): void {
    this.writeTextDelta(`\n[${name}] ${detail}\n`, false);
  }

  closeText(): void {
    if (!this.textOpen || this.finished || this.res.destroyed) return;
    event(this.res, "content_block_stop", { type: "content_block_stop", index: this.textIndex });
    this.textOpen = false;
    this.index = this.textIndex + 1;
  }

  toolUse(block: Extract<ContentBlock, { type: "tool_use" }>): void {
    if (this.finished || this.contentComplete || this.res.destroyed) return;
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
    this.wireContent[this.index] = JSON.parse(JSON.stringify({ type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} })) as ContentBlock;
    this.index += 1;
  }

  /** Flush content before persisting history, retaining exactly what a normal
   * Anthropic stream client reconstructs, including traces and whitespace. */
  completeContent(message: MessagesResponse): ContentBlock[] {
    if (this.finished || this.contentComplete || this.res.destroyed) return structuredClone(this.wireContent);
    this.start(message.usage);
    this.closeText();
    // Snapshot before fallback emission: every final text block must be sent
    // when the SDK emitted only tool traces (or no deltas at all).
    const hadModelText = this.streamedText;
    for (const block of message.content) {
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        if (hadModelText) continue;
        this.textDelta(block.text);
        this.closeText();
      } else if (block.type === "tool_use" && "id" in block && typeof block.id === "string" && typeof block.name === "string") {
        this.toolUse({ type: "tool_use", id: block.id, name: block.name, input: block.input ?? {} });
      }
    }
    this.contentComplete = true;
    return structuredClone(this.wireContent);
  }

  finish(message: MessagesResponse): ContentBlock[] {
    const content = this.completeContent(message);
    if (this.finished || this.res.destroyed) return content;
    event(this.res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence },
      usage: {
        // The stream starts before the native agent has reported usage. The
        // final delta must replace that provisional zero for standard clients.
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
        cache_read_input_tokens: message.usage.cache_read_input_tokens,
      },
    });
    event(this.res, "message_stop", { type: "message_stop" });
    this.res.end();
    this.finished = true;
    this.dispose();
    return content;
  }

  fail(error: unknown): void {
    if (this.finished || this.res.destroyed) return;
    const detail = error instanceof BridgeError
      ? { type: error.code, message: error.message, ...error.extra }
      : { type: "internal_error", message: error instanceof Error ? error.message : String(error) };
    if (!this.started) {
      if (error instanceof BridgeError && typeof error.extra?.retry_after === "number") this.res.setHeader("retry-after", String(error.extra.retry_after));
      this.res.writeHead(error instanceof BridgeError ? error.status : 500, { "Content-Type": "application/json; charset=utf-8" });
      this.res.end(JSON.stringify({ type: "error", error: detail }));
      this.finished = true;
      this.dispose();
      return;
    }
    event(this.res, "error", { type: "error", error: detail });
    this.finished = true;
    this.res.end();
    this.dispose();
  }
}
