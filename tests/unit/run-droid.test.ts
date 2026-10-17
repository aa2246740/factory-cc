import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDroidWrapperArgs, prepareDroidExecArgs, runDroid } from "../../scripts/run-droid.js";

const directories: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "relay-wrapper-test-"));
  directories.push(directory);
  return directory;
}

async function control() {
  const requests: Array<{ path: string; body: unknown; authenticated: boolean }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url!, body: JSON.parse(raw), authenticated: req.headers.authorization === "Bearer test-admin" });
    res.end(JSON.stringify(req.url === "/internal/launches" ? { launchId: "owned-launch" } : { ok: true }));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const env = {
    ...process.env,
    BRIDGE_ADMIN_TOKEN: "test-admin",
    BRIDGE_CONTROL_URL: `http://127.0.0.1:${address.port}`,
    BRIDGE_DROID_EXECUTABLE: process.execPath,
  };
  return { env, requests };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise<void>((done) => setTimeout(done, 20));
  }
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux" && readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z")) return false;
    return true;
  } catch { return false; }
}

describe("Droid launch wrapper", () => {
  it("keeps the official spec approval transition available without changing unrelated tool restrictions", () => {
    expect(prepareDroidExecArgs(["exec", "--use-spec", "--auto", "high", "make a plan"])).toEqual(["exec", "--add-tools", "ExitSpecMode", "--use-spec", "--auto", "high", "make a plan"]);
    expect(prepareDroidExecArgs(["exec", "--spec-model=relay", "--add-tools=Read,Grep", "task"])).toContain("--add-tools=Read,Grep,ExitSpecMode");
    expect(prepareDroidExecArgs(["exec", "--use-spec", "--disabled-tools", "Execute", "task"])).toEqual(["exec", "--additional-tools", "ExitSpecMode", "--use-spec", "--disabled-tools", "Execute", "task"]);
    const explicit = ["exec", "--use-spec", "--only-tools", "Read,exit-spec-mode", "task"];
    expect(prepareDroidExecArgs(explicit)).toEqual(explicit);
    expect(() => prepareDroidExecArgs(["exec", "--use-spec", "--remove-tools", "ExitSpecMode", "task"])).toThrow("explicit removed-tools policy");
    expect(() => prepareDroidExecArgs(["exec", "--use-spec", "--only-tools", "Read", "task"])).toThrow("explicit tool allowlist");
  });

  it("does not interpret literal prompt or option payloads as exec spec flags", () => {
    for (const args of [
      ["exec", "explain --use-spec"],
      ["exec", "--", "--use-spec"],
      ["exec", "--append-system-prompt", "--use-spec", "task"],
      ["exec", "--settings", "--use-spec", "task"],
      ["--use-spec"],
      ["exec", "--input-format", "stream-jsonrpc", "--use-spec"],
      ["exec", "--future-option", "payload", "--use-spec", "task"],
    ]) expect(prepareDroidExecArgs(args)).toEqual(args);
  });

  it("rejects a spec allowlist conflict before lifecycle registration or process spawn", async () => {
    const { env, requests } = await control();
    await expect(runDroid(["--", "exec", "--use-spec", "--only-tools", "Read", "task"], { env, stdio: "ignore", handleProcessSignals: false })).rejects.toThrow("explicit tool allowlist");
    expect(requests).toHaveLength(0);
  });

  it("passes every argument after -- unchanged, preserving literal settings", () => {
    const args = ["exec", "--settings", '{"customModels":[{"apiKey":"literal-test-key"}]}', "--auto", "low", "say --exact"];
    expect(parseDroidWrapperArgs(["--home", "/tmp/test", "--airgap", "1", "--", ...args])).toMatchObject({ home: "/tmp/test", airgap: "1", args });
    expect(parseDroidWrapperArgs(["exec", "--settings", "settings.json"]).args).toEqual(["exec", "--settings", "settings.json"]);
    expect(() => parseDroidWrapperArgs(["--token", "not-accepted"])).toThrow("environment variables");
    expect(() => parseDroidWrapperArgs(["--timeout", "NaN"])).toThrow("positive number");
  });

  it("registers before spawning, preserves HOME, isolates Factory, and ends only its launch", async () => {
    const directory = temporaryDirectory();
    const { env, requests } = await control();
    const observedFile = join(directory, "observed.json");
    const script = join(directory, "droid.mjs");
    writeFileSync(script, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify({args:process.argv.slice(3), home:process.env.HOME, factory:process.env.FACTORY_HOME_OVERRIDE, launch:process.env.BRIDGE_FACTORY_LAUNCH_ID, airgap:process.env.FACTORY_AIRGAP_ENABLED, hasFactoryKey:!!process.env.FACTORY_API_KEY, hasAdminToken:!!process.env.BRIDGE_ADMIN_TOKEN, hasBinding:process.env.BRIDGE_FACTORY_BINDING!==undefined}));`);
    const code = await runDroid(["--home", directory, "--cwd", directory, "--airgap", "1", "--", script, observedFile, "--settings", '{"key":"literal"}', "--auto", "low"], {
      env: { ...env, HOME: "/original/home-not-read", FACTORY_API_KEY: "unused-real-login-marker", BRIDGE_FACTORY_BINDING: "stale-parent-binding", BRIDGE_FACTORY_LAUNCH_ID: "stale-parent-launch" }, stdio: "ignore", handleProcessSignals: false,
    });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(observedFile, "utf8"))).toEqual({ args: ["--settings", '{"key":"literal"}', "--auto", "low"], home: "/original/home-not-read", factory: directory, launch: "owned-launch", airgap: "1", hasFactoryKey: false, hasAdminToken: false, hasBinding: false });
    expect(requests).toEqual([
      { path: "/internal/launches", body: { cwd: realpathSync(directory) }, authenticated: true },
      { path: "/internal/launches/owned-launch/end", body: {}, authenticated: true },
    ]);
  });

  it("does not spawn without authenticated lifecycle control and cancels a failed spawn", async () => {
    await expect(runDroid([], { env: {}, handleProcessSignals: false })).rejects.toThrow("Droid was not started");
    const directory = temporaryDirectory();
    const { env, requests } = await control();
    await expect(runDroid(["--home", directory, "--"], {
      env: { ...env, BRIDGE_DROID_EXECUTABLE: join(directory, "missing-binary") }, stdio: "ignore", handleProcessSignals: false,
    })).rejects.toThrow("Unable to start Droid");
    expect(requests.map((entry) => entry.path)).toEqual(["/internal/launches", "/internal/launches/owned-launch/cancel"]);
  });

  it("registers and spawns the physical workspace when --cwd names a symlink", async () => {
    const directory = temporaryDirectory();
    const physical = realpathSync(directory);
    const alias = `${directory}-alias`; directories.push(alias);
    symlinkSync(physical, alias, "junction");
    const { env, requests } = await control();
    const observed = join(directory, "cwd.txt");
    const script = join(directory, "droid.mjs");
    writeFileSync(script, "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2],process.cwd());");
    expect(await runDroid(["--home", directory, "--cwd", alias, "--", script, observed], { env, stdio: "ignore", handleProcessSignals: false })).toBe(0);
    expect(readFileSync(observed, "utf8")).toBe(physical);
    expect(requests[0]).toEqual({ path: "/internal/launches", body: { cwd: physical }, authenticated: true });
  });

  it.skipIf(process.platform === "win32")("kills an unresponsive owned process tree on timeout and cancels exactly once", async () => {
    const directory = temporaryDirectory();
    const { env, requests } = await control();
    const script = join(directory, "droid.mjs");
    const pidFile = join(directory, "pids.json");
    writeFileSync(script, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'}); writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);`);
    const code = await runDroid(["--home", directory, "--timeout", "500", "--", script, pidFile], {
      env, stdio: "ignore", handleProcessSignals: false, terminationGraceMs: 100,
    });
    expect(code).toBe(124);
    const pids = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
    await waitUntil(() => pids.every((pid) => !processRunning(pid)));
    expect(requests.map((entry) => entry.path)).toEqual(["/internal/launches", "/internal/launches/owned-launch/cancel"]);
  });

  it.skipIf(process.platform === "win32")("treats a real SIGHUP like SIGTERM: stops Droid, exits 143, and cancels without an end receipt", async () => {
    const directory = temporaryDirectory();
    const { env, requests } = await control();
    const script = join(directory, "droid.mjs");
    const ready = join(directory, "ready");
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; process.on('SIGHUP',()=>{}); process.on('SIGTERM',()=>process.exit(0)); writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);`);
    const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/run-droid.ts"), "--home", directory, "--", script, ready], { env, stdio: "ignore" });
    children.push(child);
    const exit = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
    await waitUntil(() => existsSync(ready));
    const droidPid = Number(readFileSync(ready, "utf8"));
    child.kill("SIGHUP");
    expect(await exit).toBe(143);
    await waitUntil(() => !processRunning(droidPid));
    expect(requests.map((entry) => entry.path)).toEqual(["/internal/launches", "/internal/launches/owned-launch/cancel"]);
  }, 10_000);

  it.skipIf(process.platform === "win32")("forwards a real SIGINT, exits130, and never sends an ordinary end receipt", async () => {
    const directory = temporaryDirectory();
    const { env, requests } = await control();
    const script = join(directory, "droid.mjs");
    const ready = join(directory, "ready");
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; process.on('SIGINT',()=>process.exit(0)); writeFileSync(process.argv[2],String(process.pid)); setInterval(()=>{},1000);`);
    const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/run-droid.ts"), "--home", directory, "--", script, ready], { env, stdio: "ignore" });
    children.push(child);
    const exit = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
    await waitUntil(() => existsSync(ready));
    const droidPid = Number(readFileSync(ready, "utf8"));
    child.kill("SIGINT");
    expect(await exit).toBe(130);
    expect(processRunning(droidPid)).toBe(false);
    expect(requests.map((entry) => entry.path)).toEqual(["/internal/launches", "/internal/launches/owned-launch/cancel"]);
  }, 10_000);
});
