import type { RoleTag, SessionState } from "../types.js";

export interface SessionRecord {
  bridgeSessionId: string;
  droidSessionId?: string;
  sdkSessionId?: string;
  role: RoleTag;
  state: SessionState;
  model: string;
  historyHash?: string;
  toolNames: string[];
  createdAt: string;
  updatedAt: string;
  pendingToolIds: string[];
  cancelRequested: boolean;
  notes: string[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    estimated: boolean;
  };
}

export function transition(record: SessionRecord, next: SessionState): SessionRecord {
  const allowed: Record<SessionState, SessionState[]> = {
    NEW: ["GENERATING", "CANCELLED", "FAILED"],
    GENERATING: ["WAITING_DROID_TOOL", "IDLE", "CANCELLED", "FAILED"],
    WAITING_DROID_TOOL: ["RESUMING", "CANCELLED", "FAILED"],
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
  return record;
}
