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

  create(input: { role: RoleTag; model: string; droidSessionId?: string; historyHash?: string; toolNames: string[] }): SessionRecord {
    const active = this.list().filter((s) => s.state !== "CANCELLED" && s.state !== "FAILED").length;
    if (active >= this.maxSessions) {
      throw new BridgeError(429, "session_limit", `active session limit ${this.maxSessions} reached`);
    }
    const record: SessionRecord = {
      bridgeSessionId: sessionId(),
      droidSessionId: input.droidSessionId,
      role: input.role,
      state: "NEW",
      model: input.model,
      historyHash: input.historyHash,
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
    transition(record, state);
    this.flush(record);
    return record;
  }

  update(id: string, patch: Partial<SessionRecord>): SessionRecord {
    const record = this.require(id);
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
  }
}
