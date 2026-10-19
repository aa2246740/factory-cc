import type { RoleTag, SessionState } from "../types.js";

export interface SessionRecord {
  bridgeSessionId: string;
  droidSessionId?: string;
  factorySessionId?: string;
  factoryCwd?: string;
  sdkSessionId?: string;
  /** Persist replay safety independently of process-local callback state. */
  hostEnded?: "resumable" | "terminal" | "interrupted";
  role: RoleTag;
  state: SessionState;
  model: string;
  historyHash?: string;
  /** Stable execution configuration, excluding dynamic host context and tools. */
  contextHash?: string;
  /** Message fingerprints of the request currently being handled. */
  requestMessageHashes?: string[];
  /** Completed client-visible transcript, including the assistant response. */
  historyMessageHashes?: string[];
  toolNames: string[];
  createdAt: string;
  updatedAt: string;
  pendingToolIds: string[];
  /** IDs that were pending when the session ended. Never matched as owners; kept so a retried result gets a clear 409. */
  endedToolIds?: string[];
  cancelRequested: boolean;
  notes: string[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    estimated: boolean;
  };
}

/** A session in this condition can never resume or complete another tool round trip. */
export function isEnded(session: Pick<SessionRecord, "state" | "hostEnded">): boolean {
  return session.state === "CANCELLED" || session.state === "FAILED"
    || session.hostEnded === "terminal" || session.hostEnded === "interrupted";
}

/**
 * Release the tool IDs of an ended session. Factory keeps the matching
 * tool_result in its history, so a pending ID left behind would route every
 * later request of that conversation to a session that can only answer 409.
 */
export function retirePendingTools(record: SessionRecord): SessionRecord {
  if (!isEnded(record) || record.pendingToolIds.length === 0) return record;
  record.endedToolIds = [...new Set([...(record.endedToolIds ?? []), ...record.pendingToolIds])];
  record.pendingToolIds = [];
  return record;
}

export function transition(record: SessionRecord, next: SessionState): SessionRecord {
  const allowed: Record<SessionState, SessionState[]> = {
    NEW: ["GENERATING", "CANCELLED", "FAILED"],
    GENERATING: ["WAITING_DROID_TOOL", "IDLE", "CANCELLED", "FAILED"],
    WAITING_DROID_TOOL: ["RESUMING", "IDLE", "CANCELLED", "FAILED"],
    RESUMING: ["GENERATING", "WAITING_DROID_TOOL", "IDLE", "CANCELLED", "FAILED"],
    IDLE: ["GENERATING", "CANCELLED", "FAILED"],
    CANCELLED: [],
    FAILED: [],
  };
  if (!allowed[record.state].includes(next) && record.state !== next) {
    record.notes.push(`illegal transition ${record.state} -> ${next}`);
  }
  record.state = next;
  record.updatedAt = new Date().toISOString();
  return retirePendingTools(record);
}
