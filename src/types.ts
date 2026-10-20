export type BridgeMode = "mock" | "fake" | "sdk";

export type RoleTag = "chat" | "orchestrator" | "worker" | "validator" | "unknown";

export type SessionState =
  | "NEW"
  | "GENERATING"
  | "WAITING_DROID_TOOL"
  | "RESUMING"
  | "IDLE"
  | "CANCELLED"
  | "FAILED";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type ContentBlock =
  | { type: "text"; text: string; cache_control?: Json }
  | {
      type: "image";
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    }
  | { type: "tool_use"; id: string; name: string; input: Json }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: string | ContentBlock[];
      is_error?: boolean;
    }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: string; [key: string]: Json | undefined };

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema: Record<string, Json>;
}

export interface MessagesRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
  system?: string | ContentBlock[];
  tools?: ToolDefinition[];
  tool_choice?: Json;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  metadata?: Record<string, Json>;
  thinking?: Json;
  /** Droid's reasoning selector. `effort` is the level; `format` stays rejected. */
  output_config?: Json;
  cache_control?: Json;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  estimated?: boolean;
}

export interface MessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: Usage;
}

export interface RedactedRequestRecord {
  at: string;
  method: string;
  path: string;
  role: RoleTag;
  sessionHint?: string;
  model?: string;
  stream?: boolean;
  toolNames?: string[];
  messageCount?: number;
  authOk: boolean;
  notes?: string[];
}

export class BridgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, Json> = {},
  ) {
    super(message);
    this.name = "BridgeError";
  }
}
