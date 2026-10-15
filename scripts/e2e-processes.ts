import { readdirSync, readFileSync } from "node:fs";

interface ProcessIdentity { pid: number; parent: number; group: number; started: string; state: string }

export interface ProcessCleanupReport {
  supported: boolean;
  observedProcessCount: number;
  terminatedProcessCount: number;
  remainingProcessIds: number[];
  complete: boolean;
}

/** Read only process identity metadata, never arguments, environments or credentials. */
function processes(): Map<number, ProcessIdentity> {
  const rows = new Map<number, ProcessIdentity>();
  if (process.platform !== "linux") return rows;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // comm may contain spaces and parentheses, so split after its last ')'.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.set(Number(entry), { pid: Number(entry), parent: Number(fields[1]), group: Number(fields[2]),
        state: fields[0]!, started: fields[19]! });
    } catch { /* The process can exit between readdir and read. */ }
  }
  return rows;
}

function alive(identity: ProcessIdentity, rows: Map<number, ProcessIdentity>): boolean {
  const current = rows.get(identity.pid);
  return current?.started === identity.started && current.state !== "Z" && current.state !== "X";
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Track this isolated E2E's descendants while their original parent is alive.
 * Recorded PID + kernel start time keeps later cleanup safe across reparenting
 * and PID reuse. Existing descendants are outside this tracker's ownership.
 */
export function trackOwnedProcesses(rootPid = process.pid): { close(): Promise<ProcessCleanupReport> } {
  const supported = process.platform === "linux";
  const initial = processes();
  const excluded = new Set<number>();
  const initialParents = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of initial.values()) if (initialParents.has(row.parent) && !initialParents.has(row.pid)) {
      initialParents.add(row.pid); excluded.add(row.pid); grew = true;
    }
  }
  const tracked = new Map<number, ProcessIdentity>();
  const refresh = () => {
    const rows = processes();
    const parents = new Set([rootPid, ...[...tracked.values()].filter((row) => alive(row, rows)).map((row) => row.pid)]);
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows.values()) {
        if (!parents.has(row.parent) || parents.has(row.pid) || excluded.has(row.pid)) continue;
        parents.add(row.pid); tracked.set(row.pid, row); grew = true;
      }
    }
    return rows;
  };
  const timer = setInterval(refresh, 100);
  timer.unref();
  let closing: Promise<ProcessCleanupReport> | undefined;
  return { close: () => closing ??= (async () => {
    clearInterval(timer);
    let rows = refresh();
    // SDK close normally makes its subprocess exit asynchronously. Give it a
    // bounded grace period before cleaning up still-owned descendants.
    for (const deadline = Date.now() + 1000; Date.now() < deadline && [...tracked.values()].some((row) => alive(row, rows));) {
      await pause(25); rows = refresh();
    }
    const terminated = new Set<number>();
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      for (const row of tracked.values()) if (alive(row, rows)) {
        try { process.kill(row.pid, signal); terminated.add(row.pid); } catch { /* Already exited. */ }
      }
      for (const deadline = Date.now() + (signal === "SIGTERM" ? 1000 : 500); Date.now() < deadline;) {
        rows = refresh();
        if (![...tracked.values()].some((row) => alive(row, rows))) break;
        await pause(25);
      }
    }
    rows = refresh();
    const remainingProcessIds = [...tracked.values()].filter((row) => alive(row, rows)).map((row) => row.pid);
    return { supported, observedProcessCount: tracked.size, terminatedProcessCount: terminated.size,
      remainingProcessIds, complete: supported && remainingProcessIds.length === 0 };
  })() };
}

export async function verifyProcessGroupExit(group: number | undefined): Promise<ProcessCleanupReport> {
  const supported = process.platform === "linux";
  const observed = new Set<number>();
  let remainingProcessIds: number[] = [];
  for (const deadline = Date.now() + 1500;;) {
    remainingProcessIds = [...processes().values()].filter((row) => row.group === group && row.state !== "Z" && row.state !== "X").map((row) => row.pid);
    for (const pid of remainingProcessIds) observed.add(pid);
    if (!remainingProcessIds.length || Date.now() >= deadline) break;
    await pause(25);
  }
  return { supported, observedProcessCount: observed.size, terminatedProcessCount: 0, remainingProcessIds,
    complete: supported && remainingProcessIds.length === 0 };
}
