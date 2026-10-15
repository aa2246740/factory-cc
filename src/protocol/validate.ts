import { z } from "zod";
import { BridgeError, type MessagesRequest } from "../types.js";

const contentBlockSchema = z.object({ type: z.string() }).passthrough();

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});

const toolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.any()),
});

export const messagesRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    max_tokens: z.number().int().positive(),
    system: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
    tools: z.array(toolSchema).optional(),
    tool_choice: z.any().optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    thinking: z.any().optional(),
    cache_control: z.any().optional(),
  })
  .passthrough();

export function parseMessagesRequest(body: unknown): MessagesRequest {
  const parsed = messagesRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new BridgeError(400, "invalid_request_error", parsed.error.issues.map((i) => i.message).join("; "));
  }
  return parsed.data as MessagesRequest;
}
