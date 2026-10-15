import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import { createBridgeApp, listen, type BridgeApp } from "../src/http/app.js";
import { createLogger } from "../src/logging.js";
import { publicSelection, selectionFromConfig, type UpstreamSelection } from "../src/upstream/providers.js";
import { writeJson } from "./lib.js";
import { trackOwnedProcesses, verifyProcessGroupExit, type ProcessCleanupReport } from "./e2e-processes.js";
import { installFactoryHooks } from "../src/control/factory-hooks.js";

export interface IsolatedBridge {
  app: BridgeApp;
  config: BridgeConfig;
  token: string;
  /** Temporary container for Factory data; never assigned to HOME. */
  home: string;
  factoryHome: string;
  settingsPath: string;
  workspace: string;
  selection: UpstreamSelection;
  hostHooks: ReturnType<typeof installFactoryHooks>;
  processCleanup?: ProcessCleanupReport;
  close(): Promise<void>;
}

export interface CapturedCommand {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal?: NodeJS.Signals | null;
  processCleanup: ProcessCleanupReport;
}

export async function resolveSelection(): Promise<UpstreamSelection> {
  const preset = selectionFromConfig({
    baseUrl: process.env.BRIDGE_UPSTREAM_BASE_URL,
    model: process.env.BRIDGE_UPSTREAM_MODEL,
    tokenEnv: process.env.BRIDGE_UPSTREAM_TOKEN_ENV,
  });
  if (preset) return preset;
  throw new Error("E2E requires an explicit BRIDGE_UPSTREAM_BASE_URL, BRIDGE_UPSTREAM_MODEL and BRIDGE_UPSTREAM_TOKEN_ENV with a nonempty key; automatic provider discovery is disabled.");
}

export async function startSdkBridge(port: number, dataDir: string, selection: UpstreamSelection,
  existing?: { home: string; workspace: string }): Promise<IsolatedBridge> {
  const token = randomBytes(24).toString("hex");
  if (existing) {
    for (const [path, prefix] of [[existing.home, "relay-e2e-home-"], [existing.workspace, "relay-e2e-ws-"]] as const) {
      const actual = realpathSync(path);
      if (actual !== path || dirname(actual) !== realpathSync(tmpdir()) || !basename(actual).startsWith(prefix)) {
        throw new Error("Recovery only accepts explicitly owned E2E temporary home/workspace directories");
      }
    }
  }
  const home = existing?.home ?? mkdtempSync(join(tmpdir(), "relay-e2e-home-"));
  const factoryHome = join(home, ".factory");
  const settingsPath = join(factoryHome, "settings.json");
  const workspace = existing?.workspace ?? mkdtempSync(join(tmpdir(), "relay-e2e-ws-"));
  const previousEnv = {
    BRIDGE_DROID_HOME: process.env.BRIDGE_DROID_HOME,
    BRIDGE_SDK_CWD: process.env.BRIDGE_SDK_CWD,
    BRIDGE_WAIT_FOR_MISSION_DIR: process.env.BRIDGE_WAIT_FOR_MISSION_DIR,
  };
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  // Existing caller settings cannot redirect these isolated test sessions to a
  // real workspace. Authentication and permissions come from config below.
  process.env.BRIDGE_DROID_HOME = home;
  process.env.BRIDGE_SDK_CWD = workspace;
  delete process.env.BRIDGE_WAIT_FOR_MISSION_DIR;
  let app: BridgeApp | undefined;
  const ownedProcesses = trackOwnedProcesses();
  try {
    const config = loadConfig({
      mode: "sdk", host: "127.0.0.1", port, clientToken: token, dataDir,
      adminToken: randomBytes(24).toString("hex"),
      persistSessions: true, requestTimeoutMs: 10 * 60 * 1000,
      toolWaitMs: 30 * 60 * 1000, maxTurns: 160, maxSessions: 32,
      authMode: "byok", permissionMode: "bypass", sdkCwd: workspace,
      upstreamBaseUrl: selection.provider.baseUrl,
      upstreamModel: selection.provider.model,
      upstreamTokenEnv: selection.provider.tokenEnv,
    });
    mkdirSync(join(dataDir, "sandbox"), { recursive: true });
    writeFileSync(join(dataDir, "sandbox", "CANARY.txt"), "RELAY_CANARY_E2E\n");
    writeJson(join(dataDir, "upstream.json"), publicSelection(selection));
    app = createBridgeApp(config, createLogger(config.logDir), join(dataDir, "sandbox", "CANARY.txt"));
    await listen(app, config);
    mkdirSync(factoryHome, { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify({
      customModels: ["chat", "orchestrator", "worker", "validator"].map((role) => ({
        model: `relay-${role}`, displayName: `Relay ${role}`, baseUrl: app!.url,
        apiKey: token, provider: "anthropic", authMode: "bearer", maxOutputTokens: 8192,
        extraHeaders: { "X-Bridge-Role": role },
      })),
      missionModelSettings: { skipScrutiny: false, skipUserTesting: false },
    }, null, 2)}\n`, { mode: 0o600 });
    const hostHooks = installFactoryHooks({
      hooksPath: join(workspace, ".factory/hooks.json"), configPath: join(factoryHome, "relay-hooks.json"),
      url: app.url, adminToken: config.adminToken,
    });
    const activeApp = app;
    let closing: Promise<void> | undefined;
    const isolated: IsolatedBridge = {
      app, config, token, home, factoryHome, settingsPath, workspace, selection, hostHooks,
      close: () => closing ??= (async () => {
        // Close the SDK as well as HTTP. A client holding an HTTP socket open
        // cannot keep cleanup waiting indefinitely.
        const timer = setTimeout(() => activeApp.server.closeAllConnections(), 5_000);
        try { await activeApp.close(); }
        finally {
          clearTimeout(timer);
          try { isolated.processCleanup = await ownedProcesses.close(); }
          finally { restoreEnv(); }
        }
      })(),
    };
    return isolated;
  } catch (error) {
    if (app?.server.listening) await app.close().catch(() => undefined);
    await ownedProcesses.close();
    restoreEnv();
    throw error;
  }
}

export function droidEnv(home: string, token: string, launchId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Factory treats this as a HOME base and appends its own .factory folder.
    FACTORY_HOME_OVERRIDE: home,
    BRIDGE_CLIENT_TOKEN: token,
    FACTORY_AIRGAP_ENABLED: "1",
  };
  delete env.FACTORY_API_KEY;
  // A parent's launch capability cannot accidentally bind this isolated run.
  delete env.BRIDGE_FACTORY_LAUNCH_ID;
  delete env.BRIDGE_FACTORY_BINDING;
  if (launchId) env.BRIDGE_FACTORY_LAUNCH_ID = launchId;
  return env;
}

export async function beginFactoryLaunch(isolated: IsolatedBridge): Promise<string> {
  const response = await fetch(`${isolated.app.url}/internal/launches`, {
    method: "POST", headers: { authorization: `Bearer ${isolated.config.adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ cwd: isolated.workspace }), signal: AbortSignal.timeout(3_000),
  });
  const body = await response.json() as { launchId?: unknown };
  if (!response.ok || typeof body.launchId !== "string") throw new Error("Failed to register isolated Factory launch");
  return body.launchId;
}

export async function endFactoryLaunch(isolated: IsolatedBridge, launchId: string, cancelled: boolean): Promise<void> {
  const response = await fetch(`${isolated.app.url}/internal/launches/${encodeURIComponent(launchId)}/${cancelled ? "cancel" : "end"}`, {
    method: "POST", headers: { authorization: `Bearer ${isolated.config.adminToken}`, "content-type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("Failed to finish isolated Factory launch");
}

export async function runDroid(
  args: string[],
  opts: { home: string; token: string; cwd: string; timeoutMs: number; launchId?: string },
): Promise<CapturedCommand> {
  if (args[0] !== "exec") throw new Error("runDroid only supports an isolated droid exec invocation");
  if (args.some((arg) => arg === "--settings" || arg.startsWith("--settings="))) {
    throw new Error("runDroid supplies its own isolated --settings file");
  }
  return runE2eCommand(process.env.BRIDGE_DROID_EXECUTABLE ?? "droid", [
    args[0], "--settings", join(opts.home, ".factory/settings.json"), ...args.slice(1),
  ], {
    cwd: opts.cwd, env: droidEnv(opts.home, opts.token, opts.launchId), timeoutMs: opts.timeoutMs,
  });
}

/** Bounded local command with owned-process-group cleanup, including timeout and spawn failure. */
export async function runE2eCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CapturedCommand> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error("E2E commands require a positive timeout");
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd, env: opts.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let stoppedBy: NodeJS.Signals | undefined;
    let finished = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number, signal?: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      void verifyProcessGroupExit(child.pid).then((processCleanup) => {
        resolve({ code: timedOut ? 124 : stoppedBy ? 128 + (stoppedBy === "SIGINT" ? 2 : 15) : code,
          stdout, stderr, timedOut, signal, processCleanup });
      });
    };
    const stop = (signal?: NodeJS.Signals) => {
      if (finished || cleanupTimer) return;
      if (signal) stoppedBy = signal;
      signalGroup(child, "SIGTERM");
      cleanupTimer = setTimeout(() => signalGroup(child, "SIGKILL"), 3_000);
      deadlineTimer = setTimeout(() => {
        signalGroup(child, "SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(1, stoppedBy ?? "SIGKILL");
      }, 5_000);
    };
    const interrupt = () => stop("SIGINT");
    const terminate = () => stop("SIGTERM");
    const timeout = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs);
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    child.stdout.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString()}`.slice(-8_000_000); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-2_000_000); });
    child.once("error", (error) => { stderr += `\n${error.message}`; finish(127); });
    // Descendants can keep inherited pipes open after the main CLI exits.
    child.once("exit", () => { if (!finished) stop(); });
    child.once("close", (code, signal) => {
      signalGroup(child, "SIGKILL");
      finish(code ?? 1, signal);
    });
  });
}

export function rolesSeen(app: BridgeApp): string[] {
  return app.records.filter((record) => record.authOk).map((record) => record.role);
}

/** Optional explicitly owned factoryd for installations that require one. */
export function startDroidDaemon(home: string, token: string, port: number): { child: ChildProcess; stop: () => Promise<void> } {
  const child = spawn(process.env.BRIDGE_DROID_EXECUTABLE ?? "droid", [
    "daemon", "--host", "127.0.0.1", "--port", String(port), "--parent-pid", String(process.pid),
    "--settings", join(home, ".factory/settings.json"),
  ], { env: droidEnv(home, token), detached: process.platform !== "win32", stdio: "ignore" });
  let exited = false;
  child.once("error", () => { exited = true; });
  child.once("exit", () => { exited = true; });
  return {
    child,
    stop: async () => {
      signalGroup(child, "SIGTERM");
      if (!exited) await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      signalGroup(child, "SIGKILL");
    },
  };
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}
