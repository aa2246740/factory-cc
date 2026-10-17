import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.js";
import { isAnthropicHost, preflightAuth } from "../src/upstream/auth-env.js";
import { installFactoryHooks, removeFactoryHooks } from "../src/control/factory-hooks.js";
import { createBridgeApp, listen, type BridgeApp } from "../src/http/app.js";
import { createLogger } from "../src/logging.js";
import { modelsFromIds, parseModelIds } from "../src/models.js";
import { configureDroid } from "./configure-droid.js";
import { installDroidCommand } from "./generate-droid.js";
import { runDroid } from "./run-droid.js";

const help = `Usage: npm run local -- <project> [options]

Start an isolated Bridge and interactive Droid for an existing project.
Claude Code and Droid must already be installed and available on PATH.

  --auth <mode>     byok (default) | subscription | anthropic-api
  --base-url <URL>  Anthropic-compatible BYOK endpoint (prompted if omitted)
  --model <ID>      Default model (prompted for byok if omitted)
  --models <IDs>    Actual model choices, e.g. glm-5.2,glm-4.7 or sonnet,opus,haiku
  --key-env <NAME>  Read the BYOK key from this explicitly named environment variable
  -h, --help       Show help without changing any files

If BRIDGE_AUTH is set and differs from --auth, the launcher exits instead of
silently using byok. subscription and anthropic-api skip the endpoint, model and
key prompts and default to sonnet,opus,haiku. They do not isolate CLAUDE_CONFIG_DIR.
Run \`npm run doctor -- --auth subscription\` before the first real query; that
check sends no prompt. An sk-ant- key is refused unless the BYOK host is anthropic.com.

Without --key-env, the BYOK key is requested with terminal echo disabled. It is never
saved. Defaults are https://api.z.ai/api/anthropic and glm-5.2; endpoint and model
are remembered per project. The launcher installs /relay-droid and its discovery
skill, preserves other project hooks, and removes its own hooks when Droid exits.
State stays in this repository's tmp/local directory. Native tool permissions stay
in ask mode. For native approvals, open the printed control URL and load its private
admin-token file. FACTORY_AIRGAP_ENABLED=1 remains an experimental Factory CLI mode.`;

const LOCAL_AUTH = ["byok", "subscription", "anthropic-api"] as const;
type LocalAuth = (typeof LOCAL_AUTH)[number];

export interface LocalArgs { project: string; baseUrl?: string; model?: string; models?: string[]; keyEnv?: string; auth: LocalAuth; help: boolean }

function endpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("--base-url must be an HTTP(S) URL without credentials, query or fragment."); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new Error("--base-url must be an HTTP(S) URL without credentials, query or fragment.");
  }
  return url.href.replace(/\/$/, "");
}

function modelId(value: string): string {
  const ids = parseModelIds(value);
  if (ids.length !== 1) throw new Error("--model must specify one model ID.");
  return ids[0]!;
}

export function parseLocalArgs(argv: string[]): LocalArgs {
  const result: LocalArgs = { project: "", auth: "byok", help: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === "--help" || flag === "-h") { result.help = true; continue; }
    if (!flag.startsWith("-")) {
      if (result.project) throw new Error("Provide exactly one project directory.");
      if (/[\x00-\x1f\x7f]/.test(flag)) throw new Error("Project path cannot contain control characters.");
      result.project = resolve(flag); continue;
    }
    if (!["--base-url", "--model", "--models", "--key-env", "--auth"].includes(flag)) throw new Error("Unknown local option; use --help. Credentials must not appear in command arguments.");
    if (seen.has(flag)) throw new Error(`Duplicate option ${flag}.`);
    seen.add(flag);
    const value = argv[++index];
    if (!value || value.startsWith("-")) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--base-url") result.baseUrl = endpoint(value);
    else if (flag === "--model") result.model = modelId(value);
    else if (flag === "--models") result.models = parseModelIds(value);
    else if (flag === "--auth") {
      if (!(LOCAL_AUTH as readonly string[]).includes(value)) throw new Error("--auth must be byok, subscription or anthropic-api.");
      result.auth = value as LocalAuth;
    } else {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || ["HOME", "PATH", "SHELL", "PWD", "USER", "LOGNAME", "CODEX_HOME"].includes(value)) throw new Error("--key-env must name a dedicated key environment variable.");
      result.keyEnv = value;
    }
  }
  if (!result.help && !result.project) throw new Error("Provide the project directory: npm run local -- /path/to/project");
  if (result.models && result.model && !result.models.includes(result.model)) throw new Error("The default --model must be included in --models.");
  return result;
}

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
export function localStateDirectory(project: string): string {
  return join(repository, "tmp", "local", createHash("sha256").update(realpathSync(project)).digest("hex").slice(0, 24));
}

/** Never follow configuration symlinks, including existing parent directories. */
function directory(path: string, create = false, privateMode = false): void {
  const parent = dirname(path);
  if (parent !== path) directory(parent, create);
  try {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Refusing a symlink or non-directory in local state/configuration.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return;
    mkdirSync(path, { mode: 0o700 });
  }
  if (privateMode) chmodSync(path, 0o700);
}

function regularFile(path: string): void {
  try { const entry = lstatSync(path); if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Refusing a symlink or non-file in local configuration."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function privateWrite(path: string, contents: string): void {
  regularFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

export interface LauncherLock { pid: number; startedAt?: string }

/** Accepts the current JSON record and the older bare "<pid>" lock. */
export function parseLauncherLock(text: string): LauncherLock | undefined {
  const trimmed = text.trim();
  if (/^\d+$/.test(trimmed)) { const pid = Number(trimmed); return Number.isSafeInteger(pid) && pid > 0 ? { pid } : undefined; }
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    if (!value || typeof value !== "object" || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1
      || (value.startedAt !== undefined && typeof value.startedAt !== "string")) return undefined;
    return { pid: value.pid as number, ...(value.startedAt === undefined ? {} : { startedAt: value.startedAt }) };
  } catch { return undefined; }
}

/** Process start time as reported by ps (1 s resolution); undefined where ps is unavailable. */
export function processStartTime(pid: number): string | undefined {
  if (process.platform === "win32") return undefined;
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }).trim() || undefined;
  } catch { return undefined; }
}

/** A recorded start time that no longer matches means the PID was reused by an unrelated process.
 * A bare-PID lock (older launcher) or a missing ps cannot rule reuse out, so the owner is assumed alive. */
export function launcherLockOwnerAlive(lock: LauncherLock, startTime: (pid: number) => string | undefined = processStartTime): boolean {
  try { process.kill(lock.pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  if (lock.startedAt === undefined) return true;
  const current = startTime(lock.pid);
  return current === undefined || current === lock.startedAt;
}

/** True when the lock is gone afterwards: absent, or left by a dead launcher whose leftovers `cleanup` removed. */
function clearStaleLock(lockPath: string, cleanup: (lock: LauncherLock) => void): boolean {
  let before: ReturnType<typeof lstatSync>, lock: LauncherLock | undefined;
  try {
    before = lstatSync(lockPath);
    if (!before.isFile()) return false;
    lock = parseLauncherLock(readFileSync(lockPath, "utf8"));
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  if (!lock || launcherLockOwnerAlive(lock)) return false;
  cleanup(lock);
  try {
    const now = lstatSync(lockPath);
    if (now.dev !== before.dev || now.ino !== before.ino) return false; // replaced by a new launcher meanwhile
    rmSync(lockPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return true;
}

function removeInstalledHooks(project: string, hooksPath: string, hookConfig: string): void {
  directory(join(project, ".factory")); regularFile(hooksPath); regularFile(hookConfig);
  removeFactoryHooks({ hooksPath, configPath: hookConfig });
}

function removeAdminToken(adminPath: string): void { regularFile(adminPath); rmSync(adminPath, { force: true }); }

function preferences(path: string): { baseUrl?: string; model?: string; models?: string[] } {
  regularFile(path);
  if (!existsSync(path)) return {};
  if (lstatSync(path).size > 4096) throw new Error("Local provider preferences are invalid.");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Local provider preferences are invalid."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local provider preferences are invalid.");
  const saved = value as Record<string, unknown>;
  if (Object.keys(saved).some((key) => !["baseUrl", "model", "models"].includes(key)) || typeof saved.baseUrl !== "string" || typeof saved.model !== "string"
    || (saved.models !== undefined && (!Array.isArray(saved.models) || saved.models.some((id) => typeof id !== "string")))) throw new Error("Local provider preferences are invalid.");
  const model = modelId(saved.model), models = saved.models === undefined ? [model] : parseModelIds((saved.models as string[]).join(","));
  if (!models.includes(model)) throw new Error("Local default model must be included in its saved model choices.");
  return { baseUrl: endpoint(saved.baseUrl), model, models };
}

async function question(label: string, signal: AbortSignal, hidden = false): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive setup needs a terminal; otherwise provide --base-url, --model and --key-env.");
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: hidden ? muted : process.stdout, terminal: true });
  if (hidden) process.stdout.write(label);
  const interrupt = () => process.emit("SIGINT");
  input.once("SIGINT", interrupt);
  try { return await input.question(hidden ? "" : label, { signal }); }
  finally { input.off("SIGINT", interrupt); input.close(); if (hidden) process.stdout.write("\n"); }
}

function safeDroidEnv(source: NodeJS.ProcessEnv, key: string, keyEnv?: string): NodeJS.ProcessEnv {
  const result = { ...source };
  for (const [name, value] of Object.entries(result)) {
    if (name === keyEnv || name.startsWith("RELAY_LOCAL_PROVIDER_KEY_") || value?.includes(key)
      || name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_") || name.startsWith("BRIDGE_UPSTREAM_")
      || ["FACTORY_API_KEY", "BRIDGE_FACTORY_BINDING", "BRIDGE_FACTORY_LAUNCH_ID", "BRIDGE_LAUNCH_ID", "AGENT_PROXY_AUTH_TOKEN", "CCR_AGENT_PROXY_TOKEN_FILE_DESCRIPTOR"].includes(name)) delete result[name];
  }
  return result;
}

export async function runLocal(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = parseLocalArgs(argv);
  if (args.help) { process.stdout.write(`${help}\n`); return 0; }
  if (env.BRIDGE_AUTH && env.BRIDGE_AUTH !== args.auth) {
    throw new Error(`BRIDGE_AUTH=${env.BRIDGE_AUTH} does not match --auth ${args.auth}. Refusing to start; this launcher will not silently use a different auth mode. Pass --auth ${env.BRIDGE_AUTH} or unset BRIDGE_AUTH.`);
  }
  const project = realpathSync(args.project);
  if (!lstatSync(project).isDirectory()) throw new Error("Project path must be an existing directory.");
  const state = localStateDirectory(project);
  directory(state); directory(join(project, ".factory"));
  const preferencesPath = join(state, "provider.json"), saved = preferences(preferencesPath);
  const abort = new AbortController();
  let interrupted = false;
  const interrupt = () => { interrupted = true; abort.abort(); };
  // Closing the terminal sends SIGHUP; treat it like SIGTERM so hooks, token files and the lock are removed.
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt); process.on("SIGHUP", interrupt);
  let key = "", app: BridgeApp | undefined, releaseLock: (() => void) | undefined;
  const runtimeKey = `RELAY_LOCAL_PROVIDER_KEY_${randomBytes(8).toString("hex").toUpperCase()}`;
  const previous = new Map<string, string | undefined>();
  const setEnv = (name: string, value: string | undefined) => { previous.set(name, process.env[name]); if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  const home = join(state, "factory-home"), settingsPath = join(home, ".factory/settings.json");
  const hooksPath = join(project, ".factory/hooks.json"), hookConfig = join(state, "factory-hooks.json"), adminPath = join(state, "admin-token");
  let hookAttempted = false, adminWritten = false;
  try {
    const baseDefault = saved.baseUrl ?? "https://api.z.ai/api/anthropic", modelDefault = saved.model ?? "glm-5.2";
    let baseUrl: string | undefined;
    let model: string;
    let ids: string[];
    let catalog;
    if (args.auth === "byok") {
      baseUrl = args.baseUrl ?? saved.baseUrl ?? endpoint((await question(`BYOK endpoint [${baseDefault}]: `, abort.signal)).trim() || baseDefault);
      const available = args.models ?? (args.model && !saved.models?.includes(args.model) ? [args.model] : saved.models);
      model = args.model ?? (available ? (saved.model && available.includes(saved.model) ? saved.model : available[0]!) : saved.model)
        ?? modelId((await question(`BYOK model [${modelDefault}]: `, abort.signal)).trim() || modelDefault);
      ids = available ?? [model];
      catalog = modelsFromIds(ids);
      key = (args.keyEnv ? env[args.keyEnv] ?? "" : await question("BYOK API key (hidden; never saved): ", abort.signal, true)).trim();
      if (!key || /[\x00-\x20\x7f]/.test(key) || key.length > 16384) throw new Error("Provide a nonempty BYOK API key without whitespace; no other credentials will be tried.");
      if (key.startsWith("sk-ant-") && !isAnthropicHost(new URL(baseUrl).hostname)) {
        throw new Error("Refusing to send an Anthropic API key (sk-ant-) to a host outside anthropic.com. Use --auth anthropic-api, or point --base-url at https://api.anthropic.com.");
      }
    } else {
      if (args.baseUrl || args.keyEnv) throw new Error("--base-url and --key-env are only used with --auth byok.");
      ids = args.models ?? (args.model ? [args.model] : ["sonnet", "opus", "haiku"]);
      if (args.model && !ids.includes(args.model)) throw new Error("The default --model must be included in --models.");
      model = args.model ?? ids[0]!;
      catalog = modelsFromIds(ids, args.auth);
      preflightAuth(args.auth, env);
    }
    if (abort.signal.aborted) return 130;
    directory(join(repository, "tmp/local"), true, true); directory(state, true, true);
    const lockPath = join(state, "launcher.lock");
    const openLock = () => openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let lock: number;
    try { lock = openLock(); }
    catch (error) {
      // A launcher that was killed (or lost its terminal before cleanup) leaves its lock, hooks and tokens behind.
      const recovered = (error as NodeJS.ErrnoException).code === "EEXIST" && clearStaleLock(lockPath, (stale) => {
        removeInstalledHooks(project, hooksPath, hookConfig); removeAdminToken(adminPath);
        process.stderr.write(`Recovered from a previous launcher (PID ${stale.pid}) that exited without cleanup: removed its hooks, token files and lock.\n`);
      });
      try { if (!recovered) throw error; lock = openLock(); }
      catch { throw new Error(`This project already has a local launcher lock: ${lockPath}. Close the existing launcher first. The lock is cleared automatically only when the PID recorded in it is no longer running; if it is unreadable, confirm the owner is gone and delete it.`); }
    }
    const identity = fstatSync(lock);
    releaseLock = () => { try { const current = lstatSync(lockPath); if (current.dev === identity.dev && current.ino === identity.ino) rmSync(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
    // The start time lets a later launcher tell this process from an unrelated one that reuses the PID.
    try { writeFileSync(lock, `${JSON.stringify({ pid: process.pid, startedAt: processStartTime(process.pid) })}\n`); } finally { closeSync(lock); }
    directory(join(home, ".factory"), true, true);
    directory(join(state, "bridge-data"), true, true);
    for (const path of [settingsPath, `${settingsPath}.relay-bridge.bak`, `${settingsPath}.relay-bridge.bak.absent`, `${settingsPath}.relay-bridge.models.json`, hooksPath, hookConfig, adminPath, join(state, "manifest.env")]) regularFile(path);
    installDroidCommand(project);
    if (args.auth === "byok") setEnv(runtimeKey, key);
    setEnv("BRIDGE_DROID_HOME", home); setEnv("BRIDGE_SDK_CWD", project); setEnv("BRIDGE_WAIT_FOR_MISSION_DIR", undefined);
    const clientToken = randomBytes(24).toString("hex"), adminToken = randomBytes(24).toString("hex"), hookToken = randomBytes(24).toString("hex");
    const config = loadConfig({ mode: "sdk", authMode: args.auth, permissionMode: "ask", host: "127.0.0.1", port: 0,
      clientToken, adminToken, hookToken, dataDir: join(state, "bridge-data"), sdkCwd: project, persistSessions: true,
      maxBodyBytes: 8 * 1024 * 1024, maxSessions: 32, maxTurns: 160, toolWaitMs: 8 * 60 * 60 * 1000, requestTimeoutMs: 10 * 60 * 1000,
      claudeExecutable: env.BRIDGE_CLAUDE_EXECUTABLE ?? "claude", models: catalog,
      ...(args.auth === "byok" ? { upstreamBaseUrl: baseUrl, upstreamModel: model, upstreamTokenEnv: runtimeKey } : {}) });
    app = createBridgeApp(config, createLogger(config.logDir), join(config.sandboxDir, "CANARY.txt"));
    await listen(app, config);
    configureDroid(["--settings", settingsPath, "--base-url", app.url, "--manifest", join(state, "manifest.env"), "--models", ids.join(","),
      ...(args.model ? ["--model", model] : [])], { BRIDGE_CLIENT_TOKEN: clientToken, ...(args.auth === "byok" ? { BRIDGE_UPSTREAM_MODEL: model } : {}), BRIDGE_AUTH: args.auth }, catalog);
    hookAttempted = true;
    installFactoryHooks({ hooksPath, configPath: hookConfig, url: app.url, hookToken });
    privateWrite(adminPath, `${adminToken}\n`); adminWritten = true;
    if (args.auth === "byok" && baseUrl) privateWrite(preferencesPath, `${JSON.stringify({ baseUrl, model, models: ids }, null, 2)}\n`);
    const childEnv: NodeJS.ProcessEnv = { ...safeDroidEnv(env, key, args.keyEnv), BRIDGE_CLIENT_TOKEN: clientToken, BRIDGE_ADMIN_TOKEN: adminToken,
      BRIDGE_CONTROL_URL: app.url, BRIDGE_DROID_HOME: home, BRIDGE_SDK_CWD: project, BRIDGE_MODEL_ID: model, FACTORY_HOME_OVERRIDE: home, FACTORY_AIRGAP_ENABLED: "1",
      ...(args.auth === "byok" ? { CLAUDE_CONFIG_DIR: join(config.dataDir, "claude-config") } : {}) };
    process.stdout.write(`Droid ready for ${project}\nModels: ${catalog.map((item) => item.displayName).join(", ")}\nControl: ${app.url}/control\nAdmin token file: ${adminPath}\nNative tool permissions: ask. Open Control for approval requests.\n`);
    return await runDroid(["--home", home, "--cwd", project, "--airgap", "1", "--", "--settings", settingsPath], { env: childEnv, signal: abort.signal, handleProcessSignals: false });
  } catch (error) {
    if (interrupted) return 130;
    const message = error instanceof Error ? error.message : "Local launcher failed.";
    throw new Error(key ? message.replaceAll(key, "[REDACTED]") : message);
  } finally {
    const failures: unknown[] = [];
    if (app) {
      const timer = setTimeout(() => app!.server.closeAllConnections(), 5_000);
      try { await app.close(); } catch (error) { failures.push(error); } finally { clearTimeout(timer); }
    }
    if (hookAttempted) { try { removeInstalledHooks(project, hooksPath, hookConfig); } catch (error) { failures.push(error); } }
    if (adminWritten) { try { removeAdminToken(adminPath); } catch (error) { failures.push(error); } }
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    key = "";
    try { releaseLock?.(); } catch (error) { failures.push(error); }
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); process.off("SIGHUP", interrupt);
    if (failures.length) throw new Error("Local cleanup failed; check the project's local state and hooks before restarting.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLocal(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Local launcher failed."); process.exitCode = 1;
  });
}
