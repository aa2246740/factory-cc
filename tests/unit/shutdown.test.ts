import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const processes: ChildProcess[] = [];
const workerPids: number[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const pid of workerPids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-shutdown-test-"));
  tempDirs.push(dir);
  return dir;
}

function launch(script: string, env: NodeJS.ProcessEnv = {}) {
  // Intentionally start without upstream credentials; these are process-lifecycle tests.
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: resolve("."), env, stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  let output = "";
  child.stdout!.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr!.on("data", (data: Buffer) => { output += data.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return {
    child, exited, output: () => output,
    waitFor: async (text: string) => {
      await vi.waitFor(() => expect(output).toContain(text), { timeout: 5_000 });
    },
  };
}

function fixture(closeBody: string, setup = "", timeout = 10_000): string {
  const script = join(tempDir(), "shutdown.mjs");
  writeFileSync(script, `
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { installShutdownHandlers } from ${JSON.stringify(pathToFileURL(resolve("src/index.ts")).href)};
const server = createServer((_req, res) => res.end("ok"));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const logger = Object.fromEntries(["info", "warn", "error"].map(level => [level, (event) => console.log(event)]));
${setup}
installShutdownHandlers({ server, async close() {
  console.log("close-called");
  ${closeBody}
}}, logger, ${timeout});
console.log("fixture-ready");
`);
  return script;
}

describe("CLI shutdown", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("closes the actual mock bridge on %s", async (signal) => {
    const bridge = launch(resolve("src/index.ts"), {
      BRIDGE_MODE: "mock", BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "0",
      BRIDGE_DATA_DIR: tempDir(), BRIDGE_CLIENT_TOKEN: "shutdown-test-only", BRIDGE_PERSIST: "0",
    });
    await bridge.waitFor("Relay Bridge listening");
    bridge.child.kill(signal);
    expect(await bridge.exited).toEqual({ code: 0, signal: null });
    expect(bridge.output()).toContain("shutdown_started");
    expect(bridge.output()).toContain("shutdown_complete");
  });

  it("closes once and lets owned subprocess cleanup finish before exiting", async () => {
    const script = fixture(
      `server.close(); setTimeout(() => worker.kill("SIGTERM"), 250);`,
      `const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
       console.log("worker-pid=" + worker.pid);
       worker.once("exit", () => console.log("worker-exited"));`,
    );
    const bridge = launch(script);
    await bridge.waitFor("fixture-ready");
    const workerPid = Number(bridge.output().match(/worker-pid=(\d+)/)![1]);
    workerPids.push(workerPid);
    bridge.child.kill("SIGTERM");
    await bridge.waitFor("close-called");
    bridge.child.kill("SIGINT");
    expect(await bridge.exited).toEqual({ code: 0, signal: null });
    expect(bridge.output().match(/close-called/g)).toHaveLength(1);
    expect(bridge.output()).toContain("worker-exited");
    expect(() => process.kill(workerPid, 0)).toThrow();
  });

  it("bounds shutdown when close cannot drain the server", async () => {
    const bridge = launch(fixture("await new Promise(() => {});", "", 100));
    await bridge.waitFor("fixture-ready");
    bridge.child.kill("SIGTERM");
    expect(await bridge.exited).toEqual({ code: 1, signal: null });
    expect(bridge.output()).toContain("shutdown_timeout");
  });

  it("reports a close failure and exits unsuccessfully", async () => {
    const bridge = launch(fixture('server.close(); throw new Error("fixture shutdown failure");'));
    await bridge.waitFor("fixture-ready");
    bridge.child.kill("SIGTERM");
    expect(await bridge.exited).toEqual({ code: 1, signal: null });
    expect(bridge.output()).toContain("shutdown_failed");
  });
});
