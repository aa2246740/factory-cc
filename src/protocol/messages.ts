import { randomUUID } from "node:crypto";
import type { ContentBlock, MessagesRequest, MessagesResponse, Usage } from "../types.js";

export function messageId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}

export function assistantMessage(
  model: string,
  content: ContentBlock[],
  stopReason: MessagesResponse["stop_reason"],
  usage?: Partial<Usage>,
): MessagesResponse {
  return {
    id: messageId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens,
      cache_read_input_tokens: usage?.cache_read_input_tokens,
      estimated: usage?.estimated ?? true,
    },
  };
}

export function estimatedUsage(request: MessagesRequest, outputChars: number): Usage {
  const inputChars = JSON.stringify(request.messages).length + JSON.stringify(request.system ?? "").length;
  return {
    input_tokens: Math.max(1, Math.ceil(inputChars / 4)),
    output_tokens: Math.max(1, Math.ceil(outputChars / 4)),
    estimated: true,
  };
}

export function apiError(status: number, type: string, message: string) {
  return {
    type: "error",
    error: { type, message },
    status,
  };
}

export const UNSUPPORTED_FIELDS = [
  "thinking",
  "tool_choice",
  "stop_sequences",
  "top_k",
  "cache_control",
] as const;
