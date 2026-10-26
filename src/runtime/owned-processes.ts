import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logging.js";

export interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  started: string;
  state: string;
}

let reading: Promise<Map<number, ProcessIdentity>> | undefined;

/** Identity metadata only: never inspect process arguments or environments. */
export function processTable(): Promise<Map<number, ProcessIdentity>> {
  if (reading) return reading;
  reading = readTable().finally(() => { reading = undefined; });
  return reading;
}

async function readTable(): Promise<Map<number, ProcessIdentity>> {
  const rows = new Map<number, ProcessIdentity>();
  if (process.platform === "linux") {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const raw = readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        rows.set(Number(entry), { pid: Number(entry), parent: Number(fields[1]), group: Number(fields[2]), started: fields[19]!, state: fields[0]! });
      } catch { /* Exited during the snapshot. */ }
    }
    return rows;
  }
  if (process.platform !== "darwin") throw new Error("Owned process trees require macOS or Linux");
  const output = await new Promise<string>((resolve, reject) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(\S+)/.exec(line);
    if (match) rows.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), started: match[4]!, state: match[5]! });
  }
  return rows;
}

function running(row: ProcessIdentity): boolean { return !/^[ZX]/.test(row.state); }
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Tree {
  owner: string;
  child: ChildProcess;
  pid: number;
  members: Map<number, ProcessIdentity>;
  stopping?: Promise<void>;
}

export interface ProcessDeadlines { graceMs: number; termMs: number; killMs: number }
const DEFAULT_DEADLINES: ProcessDeadlines = { graceMs: 2000, termMs: 2000, killMs: 1000 };

/** Each entry is created by our own spawn, never by a process-name scan. */
export class OwnedProcesses {
  private readonly trees = new Map<string, Tree>();
  private readonly timer: NodeJS.Timeout;
  private scanning?: Promise<void>;
  private closed = false;
  private reaped = 0;
  private failures = 0;
  private lastScanAt?: string;
  private lastProcessCount = 0;

  constructor(private readonly logger: Logger, private readonly deadlines = DEFAULT_DEADLINES, intervalMs = 1000) {
    this.timer = setInterval(() => { void this.scan().catch(() => { this.failures++; }); }, intervalMs);
    this.timer.unref();
  }

  spawn(owner: string, options: Pick<SpawnOptions, "command" | "args" | "cwd" | "env">): ChildProcess {
    if (this.closed || this.trees.has(owner)) throw new Error("Process owner is closed or already has a child");
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Verified process ownership requires macOS or Linux");
    const child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
      detached: true, windowsHide: true,
    });
    // The SDK custom-spawn contract does not consume stderr. Drain it without
    // persisting provider output (which can contain credentials or user text).
    child.stderr?.on("data", () => undefined);
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on("error", () => undefined);
    child.on("error", () => undefined);
    if (child.pid !== undefined) {
      this.trees.set(owner, { owner, child, pid: child.pid, members: new Map() });
      this.logger.info("sdk_process_spawned", { owner, pid: child.pid, group: child.pid });
    }
    // SDK cancellation still gets its documented grace window. Our stop()
    // independently verifies the whole tree and escalates regardless of killed.
    return child;
  }

  describe(): Record<string, unknown> {
    return { ownedTrees: this.trees.size, liveProcesses: this.lastProcessCount, stoppingTrees: [...this.trees.values()].filter((tree) => tree.stopping).length,
      reaperKills: this.reaped, reaperFailures: this.failures, lastScanAt: this.lastScanAt ?? null };
  }

  get size(): number { return this.trees.size; }
  has(owner: string): boolean { return this.trees.has(owner); }
  hasOrphans(liveOwners: ReadonlySet<string>): boolean {
    return [...this.trees.values()].some((tree) => !liveOwners.has(tree.owner) && !tree.stopping);
  }

  async scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    if (!this.trees.size) { this.lastProcessCount = 0; this.lastScanAt = new Date().toISOString(); return; }
    this.scanning = (async () => {
      const rows = await processTable();
      this.lastProcessCount = 0;
      for (const tree of this.trees.values()) {
        this.observe(tree, rows);
        this.lastProcessCount += this.alive(tree, rows).length;
      }
      this.lastScanAt = new Date().toISOString();
    })().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  /** A retired owner stays registered and consumes capacity until death is verified. */
  stop(owner: string): Promise<void> {
    const tree = this.trees.get(owner);
    if (!tree) return Promise.resolve();
    return tree.stopping ??= this.terminate(tree).finally(() => { tree.stopping = undefined; });
  }

  async reap(liveOwners: ReadonlySet<string>): Promise<void> {
    await this.scan();
    for (const [owner, tree] of this.trees) {
      if (liveOwners.has(owner) || tree.stopping) continue;
      this.logger.warn("sdk_orphan_reaped", { owner, pid: tree.pid });
      try { await this.stop(owner); this.reaped++; }
      catch { this.failures++; }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    const results = await Promise.allSettled([...this.trees.keys()].map((owner) => this.stop(owner)));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) throw new Error(`${failed.length} owned process trees did not terminate`);
  }

  private observe(tree: Tree, rows: Map<number, ProcessIdentity>): void {
    for (const [pid, member] of tree.members) if (pid !== tree.pid && rows.get(pid)?.started !== member.started) tree.members.delete(pid);
    const root = rows.get(tree.pid);
    // A reused leader PID must never confer ownership on its new process group.
    const recordedRoot = tree.members.get(tree.pid);
    const childRunning = tree.child.exitCode === null && tree.child.signalCode === null;
    const rootOwned = root && childRunning && (!recordedRoot || root.started === recordedRoot.started);
    if (rootOwned && !recordedRoot) tree.members.set(root.pid, root);
    const groupSafe = !root || rootOwned || (/^Z/.test(root.state) && recordedRoot?.started === root.started);
    const parents = new Set([...tree.members.values()].filter((member) => rows.get(member.pid)?.started === member.started).map((member) => member.pid));
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows.values()) {
        if (tree.members.has(row.pid)) continue;
        if ((groupSafe && row.group === tree.pid) || parents.has(row.parent)) {
          tree.members.set(row.pid, row); parents.add(row.pid); grew = true;
          if (row.pid !== tree.pid) this.logger.info("owned_process_observed", { owner: tree.owner, pid: row.pid, parent: row.parent, group: row.group });
        }
      }
    }
  }

  private alive(tree: Tree, rows: Map<number, ProcessIdentity>): ProcessIdentity[] {
    return [...tree.members.values()].filter((member) => {
      if (member.pid === tree.pid && (tree.child.exitCode !== null || tree.child.signalCode !== null)) return false;
      const row = rows.get(member.pid); return row?.started === member.started && running(row);
    });
  }

  private async terminate(tree: Tree): Promise<void> {
    tree.child.stdin?.end();
    const wait = async (ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      do {
        const rows = await processTable();
        this.observe(tree, rows);
        if (!this.alive(tree, rows).length && (tree.child.exitCode !== null || tree.child.signalCode !== null)) return true;
        await pause(Math.min(40, Math.max(1, deadline - Date.now())));
      } while (Date.now() < deadline);
      return false;
    };
    let gone = await wait(this.deadlines.graceMs);
    for (const [signal, ms] of [["SIGTERM", this.deadlines.termMs], ["SIGKILL", this.deadlines.killMs]] as const) {
      if (gone) break;
      const rows = await processTable();
      this.observe(tree, rows);
      const members = this.alive(tree, rows);
      let signalled = 0;
      // Only the detached group we created, and separately observed descendants
      // that moved groups. Re-check birth identity before every individual kill.
      const leader = rows.get(tree.pid);
      const knownLeader = tree.members.get(tree.pid);
      if (members.some((member) => rows.get(member.pid)?.group === tree.pid)
          && (!leader || leader.started === knownLeader?.started)) {
        try { process.kill(-tree.pid, signal); signalled += members.filter((member) => rows.get(member.pid)?.group === tree.pid).length; } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
      }
      for (const member of members) {
        const current = rows.get(member.pid);
        if (current?.started !== member.started || current.group === tree.pid) continue;
        try { process.kill(member.pid, signal); signalled++; } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
      }
      if (signalled) this.logger.warn("sdk_process_signal", { owner: tree.owner, pid: tree.pid, signal, processes: signalled });
      gone = await wait(ms);
    }
    if (!gone) { this.logger.error("sdk_process_cleanup_failed", { owner: tree.owner, pid: tree.pid }); throw new Error("Owned process tree is still alive"); }
    this.trees.delete(tree.owner);
    await this.scan();
    this.logger.info("sdk_process_exited", { owner: tree.owner, pid: tree.pid, verified: true });
  }
}
