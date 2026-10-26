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
      // Retrying the same result is harmless; a different one must not pass as a repeat.
      const first = this.lastDelivered.get(normalized.callId);
      if (first && resultKey(first) !== resultKey(normalized)) {
        throw new BridgeError(409, "conflicting_tool_result", `conflicting result for ${normalized.callId}`);
      }
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
    // A second waiter would silently replace the first and strand it forever.
    if (this.waiters.has(callId)) {
      return Promise.reject(new BridgeError(409, "duplicate_tool_wait", `tool_result ${callId} is already being waited for`));
    }
    return new Promise<ToolResultRecord>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        // Only this waiter's own entry: the id may have been claimed again since.
        if (this.waiters.get(callId) === waiter) this.waiters.delete(callId);
        reject(new BridgeError(504, "tool_wait_timeout", `timed out waiting for tool_result ${callId}`));
      }, timeoutMs);
      this.waiters.set(callId, waiter);
    });
  }

  cancel(reason = "cancelled"): void {
    for (const [id, waiter] of this.waiters) {
      waiter.reject(new BridgeError(499, "cancelled", `${reason}: ${id}`));
    }
    this.waiters.clear();
  }

  pruneCompleted(keep = 256, maxBytes = 2 * 1024 * 1024): string[] {
    const completed = [...this.deliveredResults].filter((id) => !this.waiters.has(id));
    let bytes = 0;
    const retain = new Set<string>();
    for (const id of [...completed].reverse()) {
      const size = Buffer.byteLength(JSON.stringify([this.calls.get(id), this.lastDelivered.get(id)]));
      if (retain.size < keep && bytes + size <= maxBytes) { retain.add(id); bytes += size; }
    }
    const removed = completed.filter((id) => !retain.has(id));
    for (const id of removed) {
      this.calls.delete(id); this.results.delete(id); this.lastDelivered.delete(id); this.deliveredResults.delete(id);
    }
    return removed;
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

function resultKey(result: { content: string | ContentBlock[]; isError?: boolean }): string {
  return stableJson([result.content, Boolean(result.isError)]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
