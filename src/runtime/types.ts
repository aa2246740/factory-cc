import type { ContentBlock, MessagesRequest, MessagesResponse, RoleTag } from "../types.js";
import type { SessionRecord } from "../sessions/state.js";

export interface RuntimeRequest {
  request: MessagesRequest;
  role: RoleTag;
  session: SessionRecord;
  headers: Record<string, string | string[] | undefined>;
}

export interface RuntimeTurn {
  response: MessagesResponse;
  pendingToolIds: string[];
  events?: RuntimeEvent[];
  notes?: string[];
}

export interface RuntimeEvent {
  at: string;
  type: string;
  data?: Record<string, unknown>;
}

export interface BridgeRuntime {
  readonly kind: "mock" | "fake" | "sdk";
  handle(input: RuntimeRequest): Promise<RuntimeTurn>;
  cancel(sessionId: string, reason: string): Promise<void>;
  deliverResults(
    sessionId: string,
    results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>,
  ): Promise<Array<"accepted" | "duplicate">>;
}
