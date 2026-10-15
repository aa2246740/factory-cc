import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { controlBaseUrl } from "./control.js";
import { canonicalWorkspacePath } from "../src/workspace.js";

const help = `Usage: npm run run-droid -- [wrapper options] -- [Droid arguments]

  --home <directory>   Factory home base (uses <directory>/.factory; HOME is preserved)
  --cwd <directory>    Project directory (default: current directory)
  --airgap <0|1>       Explicitly disable or enable FACTORY_AIRGAP_ENABLED
  --timeout <ms>       Optional total runtime limit (default: none)
  --factory-key keep  Explicitly inherit FACTORY_API_KEY (otherwise removed)
  --out <file>        Save a private stdout/stderr report while streaming output

BRIDGE_ADMIN_TOKEN is required. BRIDGE_CONTROL_URL defaults to http://127.0.0.1:18787.
BRIDGE_DROID_EXECUTABLE selects the Droid executable (default: droid).
Project Factory hooks must be installed for session lifecycle and cancellation.
Arguments after -- are passed unchanged; without Droid arguments the interactive CLI starts.`;

export interface DroidWrapperArgs {
  home?: string;
  cwd?: string;
  airgap?: "0" | "1";
  timeoutMs?: number;
  keepFactoryKey: boolean;
  out?: string;
  help: boolean;
  args: string[];
}

export function parseDroidWrapperArgs(argv: string[]): DroidWrapperArgs {
  const result: DroidWrapperArgs = { keepFactoryKey: false, help: false, args: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") { result.args = argv.slice(index + 1); break; }
    if (!argument.startsWith("-")) { result.args = argv.slice(index); break; }
    if (argument === "--help" || argument === "-h") { result.help = true; continue; }
    if (!["--home", "--cwd", "--airgap", "--timeout", "--factory-key", "--out"].includes(argument)) {
      throw new Error("Unknown wrapper option. Put Droid arguments after --; provide credentials through environment variables.");
    }
    const value = argv[++index];
    if (!value || value === "--" || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    switch (argument) {
      case "--home": result.home = value; break;
      case "--cwd": result.cwd = value; break;
      case "--out": result.out = value; break;
      case "--airgap":
        if (value !== "0" && value !== "1") throw new Error("--airgap must be 0 or 1.");
        result.airgap = value;
        break;
      case "--factory-key":
        if (value !== "keep") throw new Error("--factory-key only accepts keep.");
        result.keepFactoryKey = true;
        break;
      case "--timeout": {
        const timeout = Number(value);
        if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new Error("--timeout must be a positive number of milliseconds, at most 2147483647.");
        result.timeoutMs = timeout;
        break;
      }
    }
  }
  return result;
}

interface RunDroidOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  handleProcessSignals?: boolean;
  stdio?: "inherit" | "ignore";
  terminationGraceMs?: number;
}

function processGroupSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function groupExists(child: ChildProcess): boolean {
  if (!child.pid) return false;
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
    return true;
  } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function finishOwnedProcessGroup(child: ChildProcess, graceMs: number): Promise<void> {
  if (!groupExists(child)) return;
  processGroupSignal(child, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (groupExists(child) && Date.now() < deadline) await new Promise<void>((done) => setTimeout(done, Math.min(50, graceMs)));
  if (groupExists(child)) processGroupSignal(child, "SIGKILL");
}

export async function runDroid(argv: string[], options: RunDroidOptions = {}): Promise<number> {
  const parsed = parseDroidWrapperArgs(argv);
  if (parsed.help) { process.stdout.write(`${help}\n`); return 0; }
  const sourceEnv = options.env ?? process.env;
  const token = sourceEnv.BRIDGE_ADMIN_TOKEN?.trim();
  if (!token) throw new Error("BRIDGE_ADMIN_TOKEN is required for launch-scoped cancellation; Droid was not started.");
  const baseUrl = controlBaseUrl(sourceEnv.BRIDGE_CONTROL_URL);
  const cwd = canonicalWorkspacePath(parsed.cwd ?? process.cwd());
  const graceMs = options.terminationGraceMs ?? 5_000;
  const request = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(5_000),
      });
    } catch { throw new Error("Bridge lifecycle control was unreachable; check the local bridge and its control page."); }
    if (!response.ok) throw new Error(`Bridge lifecycle control failed (HTTP ${response.status}).`);
    try { return await response.json(); } catch { throw new Error("Bridge lifecycle control returned invalid JSON."); }
  };

  let child: ChildProcess | undefined;
  let launchId: string | undefined;
  let stopSignal: NodeJS.Signals | undefined;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let cancelPromise: Promise<unknown> | undefined;
  let controlFailure: unknown;
  let stdout = "";
  let stderr = "";
  let streamsClosed: Promise<void> | undefined;
  const cancelLaunch = (): Promise<unknown> | undefined => {
    if (!launchId) return undefined;
    // Never retry an uncertain control mutation.
    cancelPromise ??= request(`/internal/launches/${encodeURIComponent(launchId)}/cancel`, {}).catch((error: unknown) => { controlFailure = error; });
    return cancelPromise;
  };
  const stop = (signal: NodeJS.Signals): void => {
    if (stopSignal) return;
    stopSignal = signal;
    if (child) {
      processGroupSignal(child, signal);
      killTimer = setTimeout(() => { if (child) processGroupSignal(child, "SIGKILL"); }, graceMs);
    }
    void cancelLaunch();
  };
  const onInterrupt = (): void => stop("SIGINT");
  const onTerminate = (): void => stop("SIGTERM");
  const onAbort = (): void => stop("SIGTERM");
  if (options.handleProcessSignals !== false) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let code = 1;
  try {
    if (options.signal?.aborted) stop("SIGTERM");
    if (stopSignal) { code = 143; return code; }
    const created = await request("/internal/launches", { cwd });
    if (!created || typeof created !== "object" || !("launchId" in created) || typeof created.launchId !== "string" || !created.launchId || created.launchId.length > 1024) {
      throw new Error("Bridge did not return a valid launch ID; Droid was not started.");
    }
    launchId = created.launchId;
    if (stopSignal) { await cancelLaunch(); code = stopSignal === "SIGINT" ? 130 : 143; return code; }
    const factoryHome = resolve(parsed.home ?? sourceEnv.FACTORY_HOME_OVERRIDE ?? mkdtempSync(join(tmpdir(), "relay-droid-home-")));
    mkdirSync(join(factoryHome, ".factory"), { recursive: true });
    const env: NodeJS.ProcessEnv = { ...sourceEnv, FACTORY_HOME_OVERRIDE: factoryHome, BRIDGE_FACTORY_LAUNCH_ID: launchId };
    // Hooks authenticate through their private configuration; the child does
    // not need the wrapper's administrator credential in its environment.
    delete env.BRIDGE_ADMIN_TOKEN;
    if (!parsed.keepFactoryKey) delete env.FACTORY_API_KEY;
    if (parsed.airgap === "0") delete env.FACTORY_AIRGAP_ENABLED;
    if (parsed.airgap === "1") env.FACTORY_AIRGAP_ENABLED = "1";
    child = spawn(sourceEnv.BRIDGE_DROID_EXECUTABLE ?? "droid", parsed.args, {
      cwd, env, detached: process.platform !== "win32",
      stdio: parsed.out ? [options.stdio === "ignore" ? "ignore" : "inherit", "pipe", "pipe"] : options.stdio ?? "inherit",
    });
    streamsClosed = new Promise<void>((done) => child!.once("close", () => done()));
    if (parsed.out) {
      child.stdout?.on("data", (chunk: Buffer) => { if (options.stdio !== "ignore") process.stdout.write(chunk); stdout = (stdout + chunk.toString()).slice(0, 50_000); });
      child.stderr?.on("data", (chunk: Buffer) => { if (options.stdio !== "ignore") process.stderr.write(chunk); stderr = (stderr + chunk.toString()).slice(0, 50_000); });
    }
    if (parsed.timeoutMs) timeout = setTimeout(() => { timedOut = true; stop("SIGTERM"); }, parsed.timeoutMs);
    code = await new Promise<number>((resolveExit, reject) => {
      child!.once("error", () => reject(new Error("Unable to start Droid; check BRIDGE_DROID_EXECUTABLE and the working directory.")));
      child!.once("exit", (exitCode, signal) => resolveExit(exitCode ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
    });
    if (timeout) { clearTimeout(timeout); timeout = undefined; }
    if (stopSignal) code = timedOut ? 124 : stopSignal === "SIGINT" ? 130 : 143;
    if (code !== 0) await cancelLaunch();
    else await request(`/internal/launches/${encodeURIComponent(launchId)}/end`, {});
    if (stopSignal) code = timedOut ? 124 : stopSignal === "SIGINT" ? 130 : 143;
    return code;
  } catch (error) {
    await cancelLaunch();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    // The native side closes through authenticated control; OS cleanup targets
    // only the Droid process group created by this wrapper.
    if (child) await finishOwnedProcessGroup(child, stopSignal ? 0 : graceMs);
    if (killTimer) clearTimeout(killTimer);
    if (streamsClosed) {
      let drainTimer: NodeJS.Timeout | undefined;
      await Promise.race([streamsClosed, new Promise<void>((done) => { drainTimer = setTimeout(done, 1_000); })]);
      if (drainTimer) clearTimeout(drainTimer);
    }
    await cancelPromise;
    if (options.handleProcessSignals !== false) {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
    options.signal?.removeEventListener("abort", onAbort);
    if (parsed.out) {
      if (existsSync(resolve(parsed.out))) chmodSync(resolve(parsed.out), 0o600);
      writeFileSync(resolve(parsed.out), `${JSON.stringify({ code, stdout, stderr }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(resolve(parsed.out), 0o600);
    }
    if (controlFailure) process.stderr.write(`${controlFailure instanceof Error ? controlFailure.message : "Bridge cancellation was not confirmed."}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runDroid(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Unable to run Droid.");
    process.exitCode = 1;
  });
}
