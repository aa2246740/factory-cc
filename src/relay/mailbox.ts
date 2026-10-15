import type { ContentBlock } from "../types.js";
import { BridgeError } from "../types.js";

export interface ToolCallRecord {
  callId: string;
  originalName: string;
  mcpName: string;
  input: unknown;
  createdAt: string;
  delivered: boolean;
}

export interface ToolResultRecord {
  callId: string;
  content: string | ContentBlock[];
  isError?: boolean;
  arrivedAt: string;
}

interface Waiter {
  resolve: (result: ToolResultRecord) => void;
  reject: (error: Error) => void;
}

export class ToolMailbox {
  private readonly calls = new Map<string, ToolCallRecord>();
  private readonly results = new Map<string, ToolResultRecord>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly deliveredResults = new Set<string>();
  private readonly lastDelivered = new Map<string, ToolResultRecord>();

  registerCall(call: Omit<ToolCallRecord, "createdAt" | "delivered">): ToolCallRecord {
    const record: ToolCallRecord = {
      ...call,
      createdAt: new Date().toISOString(),
      delivered: false,
    };
    this.calls.set(call.callId, record);
    return record;
  }

  pendingCalls(): ToolCallRecord[] {
    return [...this.calls.values()].filter((call) => !this.deliveredResults.has(call.callId));
  }

  getCall(callId: string): ToolCallRecord | undefined {
    return this.calls.get(callId);
  }

  hasCall(callId: string): boolean {
    return this.calls.has(callId);
  }

  submitResult(result: Omit<ToolResultRecord, "arrivedAt"> | { tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }): "accepted" | "duplicate" {
    const normalized: Omit<ToolResultRecord, "arrivedAt"> = "callId" in result
      ? result
      : { callId: result.tool_use_id, content: result.content, isError: result.is_error };
    if (this.deliveredResults.has(normalized.callId) || this.results.has(normalized.callId)) {
      return "duplicate";
    }
    if (!this.calls.has(normalized.callId)) {
      throw new BridgeError(409, "unknown_tool_use_id", `unknown tool_use_id ${normalized.callId}`);
    }
    const record: ToolResultRecord = { ...normalized, arrivedAt: new Date().toISOString() };
    this.results.set(normalized.callId, record);
    this.lastDelivered.set(normalized.callId, record);
    const waiter = this.waiters.get(normalized.callId);
    if (waiter) {
      this.waiters.delete(normalized.callId);
      this.deliveredResults.add(normalized.callId);
      waiter.resolve(record);
    }
    return "accepted";
  }

  wait(callId: string, timeoutMs: number): Promise<ToolResultRecord> {
    const existing = this.results.get(callId) ?? this.lastDelivered.get(callId);
    if (existing) {
      this.deliveredResults.add(callId);
      this.results.delete(callId);
      return Promise.resolve(existing);
    }
    return new Promise<ToolResultRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(callId);
        reject(new BridgeError(504, "tool_wait_timeout", `timed out waiting for tool_result ${callId}`));
      }, timeoutMs);
      this.waiters.set(callId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  cancel(reason = "cancelled"): void {
    for (const [id, waiter] of this.waiters) {
      waiter.reject(new BridgeError(499, "cancelled", `${reason}: ${id}`));
    }
    this.waiters.clear();
  }

  rejectUnknownOrConflict(callId: string, sessionOwns: boolean, conflicting?: boolean): void {
    if (!sessionOwns) {
      throw new BridgeError(409, "cross_session_tool_result", `tool_use_id ${callId} is not owned by this session`);
    }
    if (conflicting) {
      throw new BridgeError(409, "conflicting_tool_result", `conflicting result for ${callId}`);
    }
  }
}
