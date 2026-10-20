import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logging.js";
import type { ModelProvider } from "../models.js";
import { sessionId } from "../relay/ids.js";
import type { RoleTag, SessionState } from "../types.js";
import { BridgeError } from "../types.js";
import { type SessionRecord, retirePendingTools, transition } from "./state.js";

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly persist: boolean,
    private readonly maxSessions: number,
    private readonly logger?: Pick<Logger, "warn">,
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
    provider?: ModelProvider;
    droidSessionId?: string;
    historyHash?: string;
    contextHash?: string;
    reasoning?: string;
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
      ...(input.provider ? { provider: input.provider } : {}),
      historyHash: input.historyHash,
      contextHash: input.contextHash,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
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
    // A host ending (hostEnded) ends the session just as a terminal state does.
    retirePendingTools(record);
    this.sessions.set(id, record);
    this.flush(record);
    return record;
  }

  /**
   * Give up a session parked on a Droid tool: its native process is gone (a bridge
   * restart) or has just been stopped (reclaimed for its slot), so no result can
   * ever be delivered. Keep its identity but release its slot, and make sure it is
   * never matched, resumed or replayed. Other states are left alone.
   */
  interrupt(id: string, note: string): SessionRecord {
    const record = this.require(id);
    if (record.state !== "WAITING_DROID_TOOL") return record;
    interruptWaiting(record, note);
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
    atomicWrite(join(this.dir, "sessions-snapshot.json"), JSON.stringify(this.list(), null, 2));
  }

  private flush(record: SessionRecord): void {
    if (!this.persist) return;
    this.terminateLastLine();
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.snapshot();
  }

  /** A crash can leave half a record behind. Never let the next append join that line. */
  private terminateLastLine(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.file, "r");
      const { size } = fstatSync(fd);
      if (size === 0) return;
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) appendFileSync(this.file, "\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private requireCapacity(): void {
    const active = this.list().filter((record) => isActive(record.state)).length;
    if (active >= this.maxSessions) {
      throw new BridgeError(429, "session_limit", `active session limit ${this.maxSessions} reached`);
    }
  }

  private load(): void {
    let readable = true;
    try {
      const raw = readFileSync(this.file, "utf8");
      raw.split("\n").forEach((line, index) => {
        if (!line.trim()) return;
        // One damaged line (a crash mid-write) must not hide the records after it.
        // Log where it is, never what it contains.
        try {
          const record = JSON.parse(line) as SessionRecord;
          if (!record || typeof record !== "object" || typeof record.bridgeSessionId !== "string" || typeof record.state !== "string") {
            throw new Error("not a session record");
          }
          this.sessions.set(record.bridgeSessionId, record);
        } catch {
          this.logger?.warn("session_store_corrupt_line", { line: index + 1, length: line.length });
        }
      });
    } catch (error) {
      // First run has no file. Anything else must not be compacted over.
      readable = (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    // There is no process left to finish an interrupted generation. Keep its
    // identity and SDK checkpoint, but never silently replay unknown side effects.
    // A session parked on a Droid tool can no longer complete either: the SDK
    // callback that would receive the result died with the old process.
    for (const record of this.sessions.values()) {
      if (record.state === "NEW" || record.state === "GENERATING" || record.state === "RESUMING") {
        transition(record, "FAILED");
        record.notes.push("bridge-restarted-during-generation");
      } else if (record.state === "WAITING_DROID_TOOL") {
        interruptWaiting(record, "bridge-restarted-while-waiting-for-tool");
      } else {
        // Records written before ended sessions released their tool IDs.
        retirePendingTools(record);
      }
    }
    if (readable && this.sessions.size > 0) this.compact();
  }

  /** The log appends a full record per change. Rewrite it once as one record per session. */
  private compact(): void {
    atomicWrite(this.file, this.list().map((record) => `${JSON.stringify(record)}\n`).join(""));
    this.snapshot();
  }
}

/** Write a private file that readers see either complete or not at all. */
function atomicWrite(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function interruptWaiting(record: SessionRecord, note: string): void {
  record.hostEnded = "interrupted";
  record.notes.push(note);
  transition(record, "IDLE");
}

function isActive(state: SessionState): boolean {
  return state === "NEW" || state === "GENERATING" || state === "WAITING_DROID_TOOL" || state === "RESUMING";
}
