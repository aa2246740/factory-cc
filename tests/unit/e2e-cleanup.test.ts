import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { runE2eCommand } from "../../scripts/e2e-lib.js";
import { trackOwnedProcesses } from "../../scripts/e2e-processes.js";

const children: ChildProcess[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
});

function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch { return false; }
}

describe.skipIf(process.platform !== "linux")("E2E owned process cleanup", () => {
  it("kills inherited descendants when a successful command leaves one running", async () => {
    const result = await runE2eCommand(process.execPath, ["-e", `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore',env:{}});
      console.log(child.pid); child.unref();
    `], { env: {}, timeoutMs: 3000 });
    const pid = Number(result.stdout.trim());
    pids.push(pid);
    expect(result.code).toBe(0);
    expect(result.processCleanup.complete).toBe(true);
    expect(result.processCleanup.remainingProcessIds).toEqual([]);
    expect(running(pid)).toBe(false);
  });

  it("verifies the process group is empty after timeout", async () => {
    const result = await runE2eCommand(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"], { env: {}, timeoutMs: 100 });
    expect(result.code).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.processCleanup.complete).toBe(true);
    expect(running(Number(result.stdout.trim()))).toBe(false);
  });

  it("remembers a detached descendant after its parent exits without reading environments", async () => {
    const parent = spawn(process.execPath, ["-e", `
      process.on('message', () => {
        const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore',detached:true,env:{}});
        child.unref(); process.send(child.pid);
      });
    `], { env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    children.push(parent);
    const tracker = trackOwnedProcesses(parent.pid!);
    const started = new Promise<number>((resolve) => parent.once("message", (value) => resolve(Number(value))));
    parent.send("start");
    const pid = await started;
    pids.push(pid);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await new Promise<void>((resolve) => { parent.once("exit", () => resolve()); parent.kill("SIGTERM"); });
    expect(running(pid)).toBe(true);
    const cleanup = await tracker.close();
    expect(cleanup.observedProcessCount).toBe(1);
    expect(cleanup.terminatedProcessCount).toBe(1);
    expect(cleanup.complete).toBe(true);
    expect(running(pid)).toBe(false);
  });
});
