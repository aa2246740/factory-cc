import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionId } from "../relay/ids.js";
import type { RoleTag, SessionState } from "../types.js";
import { BridgeError } from "../types.js";
import { type SessionRecord, transition } from "./state.js";

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly persist: boolean,
    private readonly maxSessions: number,
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "sessions.jsonl");
    if (persist) this.load();
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  create(input: {
    role: RoleTag;
    model: string;
    droidSessionId?: string;
    historyHash?: string;
    contextHash?: string;
    requestMessageHashes?: string[];
    historyMessageHashes?: string[];
    toolNames: string[];
  }): SessionRecord {
    this.requireCapacity();
    const record: SessionRecord = {
      bridgeSessionId: sessionId(),
      droidSessionId: input.droidSessionId,
      role: input.role,
      state: "NEW",
      model: input.model,
      historyHash: input.historyHash,
      contextHash: input.contextHash,
      requestMessageHashes: input.requestMessageHashes,
      historyMessageHashes: input.historyMessageHashes,
      toolNames: input.toolNames,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pendingToolIds: [],
      cancelRequested: false,
      notes: [],
      usage: { input_tokens: 0, output_tokens: 0, estimated: true },
    };
    this.sessions.set(record.bridgeSessionId, record);
    this.flush(record);
    return record;
  }

  setState(id: string, state: SessionState): SessionRecord {
    const record = this.require(id);
    if (!isActive(record.state) && isActive(state)) this.requireCapacity();
    transition(record, state);
    this.flush(record);
    return record;
  }

  update(id: string, patch: Partial<SessionRecord>): SessionRecord {
    const record = this.require(id);
    if (patch.state && !isActive(record.state) && isActive(patch.state)) this.requireCapacity();
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    this.sessions.set(id, record);
    this.flush(record);
    return record;
  }

  require(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw new BridgeError(404, "session_not_found", id);
    return record;
  }

  snapshot(): void {
    if (!this.persist) return;
    writeFileSync(
      join(this.dir, "sessions-snapshot.json"),
      JSON.stringify(this.list(), null, 2),
    );
  }

  private flush(record: SessionRecord): void {
    if (!this.persist) return;
    appendFileSync(this.file, `${JSON.stringify(record)}\n`);
    this.snapshot();
  }

  private requireCapacity(): void {
    const active = this.list().filter((record) => isActive(record.state)).length;
    if (active >= this.maxSessions) {
      throw new BridgeError(429, "session_limit", `active session limit ${this.maxSessions} reached`);
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(this.file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as SessionRecord;
        this.sessions.set(record.bridgeSessionId, record);
      }
    } catch {
      // first run
    }
    // There is no process left to finish an interrupted generation. Keep its
    // identity and SDK checkpoint, but never silently replay unknown side effects.
    // WAITING_DROID_TOOL remains occupied so a lost waiter cannot be evicted or
    // matched as a fresh conversation after a restart.
    for (const record of this.sessions.values()) {
      if (record.state === "NEW" || record.state === "GENERATING" || record.state === "RESUMING") {
        transition(record, "FAILED");
        record.notes.push("bridge-restarted-during-generation");
        this.flush(record);
      }
    }
  }
}

function isActive(state: SessionState): boolean {
  return state === "NEW" || state === "GENERATING" || state === "WAITING_DROID_TOOL" || state === "RESUMING";
}
