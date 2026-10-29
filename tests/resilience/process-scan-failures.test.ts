import { expect, it, vi } from "vitest";
import { once } from "node:events";
import * as childProcess from "node:child_process";
import { OwnedProcesses, processTable } from "../../src/runtime/owned-processes.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

it("counts one failed shared scan once and records only process error metadata", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const owned = new OwnedProcesses(logger, { graceMs: 500, termMs: 500, killMs: 1000 }, 1000);
  const child = owned.spawn("scan-failure-test", {
    command: process.execPath,
    args: ["-e", "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); console.log('ready')"],
    env: process.env,
  });
  await once(child.stdout!, "data");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  let failRead: (() => void) | undefined;
  const read = vi.mocked(childProcess.execFile).mockImplementation((...args) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("Expected process-table callback");
    const error: childProcess.ExecFileException = new Error("PRIVATE_CANARY in stderr and command");
    error.code = "ETIMEDOUT";
    error.signal = "SIGTERM";
    error.killed = true;
    failRead = () => callback(error, "PRIVATE_CANARY", "PRIVATE_CANARY");
    return child;
  });
  try {
    const first = owned.scan();
    const rejected = expect(first).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(3100);
    expect(read).toHaveBeenCalledTimes(1);
    if (!failRead) throw new Error("No process-table read was started");
    failRead();
    await rejected;
    await Promise.resolve();
    expect(owned.describe().reaperFailures).toBe(1);
    expect(owned.describe()).toMatchObject({ reaperFailures: 1, scanFailures: 1, cleanupFailures: 0 });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("sdk_process_scan_failed", expect.objectContaining({
      code: "ETIMEDOUT", signal: "SIGTERM", killed: true,
      stdoutBytes: 14, stderrBytes: 14, elapsedMs: expect.any(Number),
    }));
    expect(JSON.stringify(owned.describe()) + JSON.stringify(logger.error.mock.calls)).not.toContain("PRIVATE_CANARY");
    expect(owned.size).toBe(1);
  } finally {
    read.mockRestore();
    Object.defineProperty(process, "platform", platform);
    await owned.close();
    vi.useRealTimers();
  }
});

it.runIf(process.platform === "darwin")("keeps a complete process table when the parent event loop is busy", async () => {
  const snapshot = processTable();
  const end = performance.now() + 3600;
  while (performance.now() < end) { /* Reproduce a busy SDK request in this isolated test process. */ }
  const rows = await snapshot;
  expect(rows.has(process.pid)).toBe(true);
});

it.runIf(process.platform === "darwin")("rejects an empty process snapshot instead of treating owners as absent", async () => {
  const read = vi.mocked(childProcess.execFile).mockImplementation((...args) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("Expected process-table callback");
    queueMicrotask(() => callback(null, "", ""));
    return new childProcess.ChildProcess();
  });
  try {
    await expect(processTable()).rejects.toThrow("Process table read failed");
  } finally { read.mockRestore(); }
});

it.runIf(process.platform === "darwin")("still terminates an unresponsive process-table command", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const read = vi.mocked(childProcess.execFile).mockImplementation((...args) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("Expected process-table callback");
    return actual.execFile(process.execPath, ["-e", "process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000);console.log(\"ready\")"], {
      encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, signal: AbortSignal.timeout(15000), killSignal: "SIGKILL",
    }, callback);
  });
  try {
    await expect(processTable()).rejects.toMatchObject({
      message: "Process table read failed",
      details: { timedOut: true, signal: "SIGKILL", killed: true, stdoutBytes: 6, stderrBytes: 0 },
    });
  } finally { read.mockRestore(); }
}, 20000);


it.runIf(process.platform === "darwin")("starts process-table silence timing after synchronous child launch returns", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const realNow = performance.now.bind(performance);
  let launchDelay = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + launchDelay);
  const read = vi.mocked(childProcess.execFile).mockImplementation((...args) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("Expected process-table callback");
    // Model time spent inside synchronous execFile/posix_spawn without burning CPU.
    launchDelay += 3600;
    return actual.execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="], {
      encoding: "utf8", signal: AbortSignal.timeout(8000), killSignal: "SIGKILL",
    }, callback);
  });
  try {
    const rows = await processTable();
    expect(rows.get(process.pid)?.pid).toBe(process.pid);
  } finally { read.mockRestore(); clock.mockRestore(); }
});


it.runIf(process.platform === "darwin")("accepts a complete table after a bounded silent enumeration retry", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const read = vi.mocked(childProcess.execFile).mockImplementation((...args) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("Expected process-table callback");
    return actual.execFile(process.execPath, ["-e", `
      setTimeout(() => {
        const { execFileSync } = require("node:child_process");
        process.stdout.write(execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="]));
      }, 3600);
    `], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, signal: AbortSignal.timeout(15000), killSignal: "SIGKILL" }, callback);
  });
  try {
    const rows = await processTable();
    expect(rows.get(process.pid)?.pid).toBe(process.pid);
  } finally { read.mockRestore(); }
}, 15000);
