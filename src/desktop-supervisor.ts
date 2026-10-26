import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendLogLine } from "./logging.js";
import { OwnedProcesses } from "./runtime/owned-processes.js";
import { randomUUID } from "node:crypto";

export const DESKTOP_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const restartBackoff = (failures: number): number => Math.min(60_000, 5000 * 2 ** Math.min(4, Math.max(0, failures - 1)));

/** Run one child at a time. Config/port failures back off instead of respawning launchd. */
export async function superviseDesktop(repo: string, state: string, signal: AbortSignal): Promise<void> {
  let failures = 0;
  const log = (name: string, chunk: string) => appendLogLine(join(state, name), chunk, DESKTOP_OUTPUT_MAX_BYTES);
  const owned = new OwnedProcesses({ info() {}, warn: (event, data) => log("stderr.log", JSON.stringify({ event, ...data })), error: (event, data) => log("stderr.log", JSON.stringify({ event, ...data })) }, { graceMs: 12_000, termMs: 2000, killMs: 1000 });
  const wait = (ms: number) => new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
  try { while (!signal.aborted) {
    const started = Date.now();
    let child: ChildProcess | undefined;
    const owner = randomUUID();
    if (existsSync(join(repo, "dist/index.js"))) {
      let stop: () => void = () => undefined;
      try {
        child = owned.spawn(owner, { command: process.execPath, args: [join(repo, "dist/index.js")], cwd: repo, env: process.env });
        child.stdout?.on("data", (chunk: Buffer) => log("stdout.log", chunk.toString("utf8")));
        child.stderr?.on("data", (chunk: Buffer) => log("stderr.log", chunk.toString("utf8")));
        await new Promise<void>((resolve, reject) => {
          child!.once("error", () => resolve());
          child!.once("exit", () => resolve());
          stop = () => {
            child!.kill("SIGTERM");
            // Allow the bridge's own ten-second shutdown first, but do not
            // wait forever for an unresponsive bridge to emit exit.
            void owned.stop(owner).then(resolve, reject);
          };
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
        });
      } finally { signal.removeEventListener("abort", stop); await owned.stop(owner); }
      log("stderr.log", JSON.stringify({ at: new Date().toISOString(), event: "desktop_child_exit", code: child?.exitCode, signal: child?.signalCode, uptimeMs: Date.now() - started }));
    }
    if (signal.aborted) break;
    failures = Date.now() - started >= 5 * 60_000 ? 1 : failures + 1;
    const retryMs = restartBackoff(failures);
    log("stderr.log", JSON.stringify({ at: new Date().toISOString(), event: "desktop_retry", retryMs, failures }));
    await wait(retryMs);
  } } finally { await owned.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => controller.abort());
  const [repo, state] = process.argv.slice(2);
  if (!repo || !state) throw new Error("desktop-supervisor requires repository and state paths");
  superviseDesktop(repo, state, controller.signal).catch(() => { process.exitCode = 1; });
}
