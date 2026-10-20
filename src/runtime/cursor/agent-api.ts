import type { CursorUpdate } from "./events.js";

export interface CursorRunResult {
  status: "running" | "finished" | "error" | "cancelled";
  result?: string;
  error?: { message?: string };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export interface CursorRunLike {
  id: string;
  status: CursorRunResult["status"];
  cancel(): Promise<void>;
  wait(): Promise<CursorRunResult>;
}

export interface CursorSendOptions {
  model?: { id: string; params?: Array<{ id: string; value: string }> };
  onDelta?: (args: { update: CursorUpdate }) => void | Promise<void>;
  local?: {
    customTools?: Record<string, {
      description?: string;
      inputSchema?: Record<string, unknown>;
      execute: (args: Record<string, unknown>, context: { toolCallId?: string }) => Promise<unknown>;
    }>;
  };
}

export interface CursorAgentLike {
  agentId: string;
  send(message: string | { text: string; images?: Array<{ data: string; mimeType: string }> }, options?: CursorSendOptions): Promise<CursorRunLike>;
  close(): void;
}

export interface CursorAgentApi {
  create(options: Record<string, unknown>): Promise<CursorAgentLike>;
  resume(agentId: string, options?: Record<string, unknown>): Promise<CursorAgentLike>;
  cancelRun?(runId: string, options?: Record<string, unknown>): Promise<void>;
}
