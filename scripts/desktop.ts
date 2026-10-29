import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { modelsFromIds, parseModelIds, type BridgeModel } from "../src/models.js";
import { coerceCursorCatalog, cursorMenuFromCatalog, formatCursorCatalog, type CursorCatalogItem } from "../src/runtime/cursor/catalog.js";
import { CURSOR_LOGIN_COMMAND, cursorApiKey, cursorCredentialStatus, cursorExpiryWarning, formatCursorStatus, loginCursor, type CursorLogin } from "../src/runtime/cursor/credentials.js";
import { cursorLoginFromSdk, loadCursorSdk, type CursorPlatformModule } from "../src/runtime/cursor/sdk-load.js";
import { assertClaudeCredential, claudeConfigModels, readClaudeConfig } from "../src/upstream/claude-config.js";
import { configureDroid, DROID_BASE_MODEL } from "./configure-droid.js";

const LABEL = "ai.factory-cc.bridge";
const installationSchema = z.object({ version: z.literal(1), port: z.number().int().min(1).max(65535), repo: z.string(), node: z.string(), path: z.string(),
  // Explicit Droid menu models; absent means follow the Claude Code settings aliases.
  models: z.array(z.string()).optional(),
  claudeConfigDir: z.string().refine(isAbsolute, "Claude profile directory must be absolute").optional(),
  // Cursor menu selector (`default`, `first-party`, or an explicit list). The key stays out of this file.
  cursorModels: z.string().min(1).max(4000).optional() });
type Installation = z.infer<typeof installationSchema>;
export type Runner = (command: string, args: string[]) => { status: number; stdout?: string };
export interface DesktopDependencies {
  home: string;
  repo: string;
  node: string;
  path: string;
  uid: number;
  platform: string;
  run: Runner;
  assertPortFree: (port: number) => Promise<void>;
  health: (port: number) => Promise<boolean>;
  runtime?: (port: number, adminFile: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  /** Isolated from the developer shell. Cursor status/login read this, never `process.env`, when set. */
  env?: NodeJS.ProcessEnv;
  cursorCatalog?: readonly CursorCatalogItem[];
  cursorLogin?: CursorLogin;
  /** Injected `@cursor/sdk` boundary. Production loads the real module when this is absent. */
  cursorSdk?: CursorPlatformModule;
  stdout?: (text: string) => void;
  now?: () => number;
}
export function desktopPaths(home: string) {
  const state = join(home, "Library/Application Support/factory-cc");
  return { state, data: join(state, "bridge-data"), token: join(state, "client-token"),
    admin: join(state, "admin-token"), hook: join(state, "hook-token"),
    manifest: join(state, "installation.json"), models: join(state, "models.env"),
    cursorCatalog: join(state, "cursor-catalog.json"), cursorMenu: join(state, "cursor-menu.json"),
    plist: join(home, `Library/LaunchAgents/${LABEL}.plist`), settings: join(home, ".factory/settings.json") };
}
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Stored on the home volume, so launchd does not need the external cwd to exist. */
export function desktopLauncher(install: Installation, state: string): string {
  return `#!/bin/sh
umask 077
repo=${shellQuote(install.repo)}
node=${shellQuote(install.node)}
state=${shellQuote(state)}
delay=5
while :; do
  if [ -x "$node" ] && [ -r "$repo/dist/index.js" ] && [ -r "$repo/dist/desktop-supervisor.js" ] && [ -s "$state/client-token" ] && [ -s "$state/admin-token" ] && [ -s "$state/hook-token" ]; then
    exec "$node" "$repo/dist/desktop-supervisor.js" "$repo" "$state"
  fi
  # Reopen the file per write, rather than keeping launchd's old rotated fd.
  bytes=$(/usr/bin/wc -c < "$state/stderr.log" 2>/dev/null) || bytes=0
  if [ "$bytes" -gt 2097000 ]; then /usr/bin/tail -c 2097152 "$state/stderr.log" > "$state/stderr.log.1"; : > "$state/stderr.log"; fi
  printf 'desktop_waiting_for_files retry_seconds=%s\\n' "$delay" >> "$state/stderr.log"
  /bin/sleep "$delay"
  delay=$((delay * 2))
  if [ "$delay" -gt 60 ]; then delay=60; fi
done
`;
}
function privateFile(path: string, value: string) {
  writeFileSync(path, value, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}
function replacePrivateFile(path: string, value: string) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try { privateFile(temporary, value); renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
}
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
export function desktopPlist(deps: DesktopDependencies, install: Installation): string {
  const paths = desktopPaths(deps.home);
  const env = { HOME: deps.home, PATH: install.path, BRIDGE_MODE: "sdk", BRIDGE_AUTH: "claude-config",
    BRIDGE_PERMISSION: "ask", BRIDGE_DESKTOP: "1", BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: String(install.port),
    BRIDGE_DATA_DIR: paths.data, BRIDGE_CLIENT_TOKEN_FILE: paths.token,
    ...(install.claudeConfigDir ? { CLAUDE_CONFIG_DIR: install.claudeConfigDir } : {}),
    BRIDGE_ADMIN_TOKEN_FILE: paths.admin, BRIDGE_HOOK_TOKEN_FILE: paths.hook,
    ...(install.models ? { BRIDGE_MODELS: install.models.join(",") } : {}),
    ...(install.cursorModels ? { BRIDGE_CURSOR_MODELS_FILE: paths.cursorMenu } : {}) };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(join(paths.state, "bridge-launcher.sh"))}</string></array>
<key>WorkingDirectory</key><string>${xml(paths.state)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("\n")}</dict>
<key>ProcessType</key><string>Interactive</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
}
function readInstallation(deps: DesktopDependencies): Installation {
  const paths = desktopPaths(deps.home);
  try {
    if (lstatSync(paths.state).isSymbolicLink() || lstatSync(paths.manifest).isSymbolicLink()) throw new Error("Refusing a linked desktop installation.");
    return installationSchema.parse(JSON.parse(readFileSync(paths.manifest, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new Error("Bridge desktop is not installed; run npm run desktop -- install.");
    throw error;
  }
}
function checkedRun(deps: DesktopDependencies, command: string, args: string[]) {
  const result = deps.run(command, args);
  if (result.status !== 0) throw new Error(`${command === "launchctl" ? "launchctl " + args[0] : "Build"} failed (exit ${result.status}).`);
  return result;
}
function bootout(deps: DesktopDependencies) {
  const result = deps.run("launchctl", ["bootout", `gui/${deps.uid}/${LABEL}`]);
  // launchctl reports ESRCH (3) when the service is already absent.
  if (result.status !== 0 && result.status !== 3) throw new Error(`launchctl bootout failed (exit ${result.status}); installation was preserved.`);
}
async function bootstrap(deps: DesktopDependencies, plist: string) {
  // bootout returns before launchd has removed the old job, and bootstrap fails until it is gone.
  for (let attempt = 1; ; attempt++) {
    const result = deps.run("launchctl", ["bootstrap", `gui/${deps.uid}`, plist]);
    if (result.status === 0) return;
    if (attempt >= 10) throw new Error(`launchctl bootstrap failed (exit ${result.status}).`);
    await (deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(1000);
  }
}
function readDesktopClaudeConfig(deps: DesktopDependencies, install: Installation) {
  return readClaudeConfig({ HOME: deps.home, PATH: install.path,
    ...(install.claudeConfigDir ? { CLAUDE_CONFIG_DIR: install.claudeConfigDir } : {}),
  }, `127.0.0.1:${install.port}`, { requireSettings: Boolean(install.claudeConfigDir) });
}

function syncModels(deps: DesktopDependencies, install: Installation, cursorMenu?: BridgeModel[]) {
  const paths = desktopPaths(deps.home);
  // Deliberately use exactly the environment launchd will receive. Never inherit shell credentials.
  const config = readDesktopClaudeConfig(deps, install);
  assertClaudeCredential(config);
  const claude = install.models ? modelsFromIds(install.models, "claude-config").map(explicitLabel)
    : claudeConfigModels(config).models.map((model) => ({ ...model, displayName: `Claude Code · ${model.displayName.replace(/^Claude /, "")}` }));
  const models = [...claude, ...(cursorMenu ?? [])];
  // A literal key, not an apiKeyHelper: Droid strips executable credential
  // commands from the runtime settings that Mission workers and validators load.
  // The token only admits requests to this loopback Bridge.
  return configureDroid(["--settings", paths.settings, "--base-url", `http://127.0.0.1:${install.port}`, "--auth", "claude-config",
    "--manifest", paths.models, "--preserve-selections"], { HOME: deps.home, BRIDGE_CLIENT_TOKEN: readFileSync(paths.token, "utf8").trim() }, models);
}
/** Droid's cached remote list of models it runs in Script mode; empty when unavailable. */
function scriptToolModels(home: string): string[] {
  try {
    const flags = JSON.parse(readFileSync(join(home, ".factory/cache/feature-flags.json"), "utf8")) as { configs?: { script_tool_models?: { models?: unknown } } };
    const models = flags.configs?.script_tool_models?.models;
    return Array.isArray(models) ? models.filter((model): model is string => typeof model === "string") : [];
  } catch { return []; }
}
/** claude-opus-5-5 -> "Claude Code · Opus 5.5 (claude-opus-5-5)"; other IDs are shown as given. */
function explicitLabel(model: BridgeModel): BridgeModel {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/.exec(model.id);
  const name = match ? `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${match[2]}.${match[3]} (${model.id})` : model.id;
  return { ...model, displayName: `Claude Code · ${name}` };
}
type DesktopOptions = Partial<Pick<Installation, "port" | "models" | "cursorModels" | "claudeConfigDir">>;
function parseOptions(action: string, options: string[]): DesktopOptions {
  const parsed: DesktopOptions = {};
  for (let index = 0; index < options.length; index += 2) {
    const [flag, value] = [options[index], options[index + 1]];
    if (flag === "--port" && action === "install" && parsed.port === undefined && /^\d+$/.test(value ?? "")) parsed.port = Number(value);
    else if (flag === "--models" && ["install", "restart"].includes(action) && parsed.models === undefined && value) parsed.models = parseModelIds(value);
    else if (flag === "--cursor-models" && ["install", "restart"].includes(action) && parsed.cursorModels === undefined && value) parsed.cursorModels = value;
    else if (flag === "--claude-config-dir" && ["install", "restart"].includes(action) && parsed.claudeConfigDir === undefined && value) {
      if (!isAbsolute(value)) throw new Error("--claude-config-dir must be an absolute profile directory.");
      parsed.claudeConfigDir = realpathSync(value);
    }
    else throw new Error("Options: install [--port <1..65535>] [--models id,id,...] [--cursor-models default|first-party|id,id,...] [--claude-config-dir /absolute/profile]; restart [--models id,id,...] [--cursor-models ...] [--claude-config-dir /absolute/profile].");
  }
  return parsed;
}

/** `{ ok: true, mode: "sdk" }` is the desktop health contract, including when Cursor is also configured. */
export function isDesktopHealthPayload(body: unknown): boolean {
  return z.object({ ok: z.literal(true), mode: z.literal("sdk") }).safeParse(body).success;
}

function cursorClock(deps: DesktopDependencies): { env: NodeJS.ProcessEnv; now: number } {
  return { env: deps.env ?? {}, now: deps.now?.() ?? Date.now() };
}

function cursorLoggedIn(deps: DesktopDependencies): boolean {
  const { env, now } = cursorClock(deps);
  return cursorCredentialStatus(desktopPaths(deps.home).data, env, now).loggedIn;
}

function cursorAbsentNotice(): string {
  return `Cursor is not logged in, so the menu has no Cursor entries. Run ${CURSOR_LOGIN_COMMAND} to add them.`;
}

/** Login and `cursor models` may create the state dir before install. That is not an installation. */
function cursorPreinstallOnly(state: string): boolean {
  if (!existsSync(state)) return true;
  let names: string[];
  try { names = readdirSync(state); } catch { return false; }
  if (names.some((name) => name !== "cursor-catalog.json" && name !== "bridge-data")) return false;
  if (!names.includes("bridge-data")) return true;
  try { return readdirSync(join(state, "bridge-data")).every((name) => name === "cursor-auth.json"); }
  catch { return false; }
}

async function fetchCursorCatalog(deps: DesktopDependencies): Promise<CursorCatalogItem[]> {
  const { env, now } = cursorClock(deps);
  const key = cursorApiKey(desktopPaths(deps.home).data, env, now);
  if (!key) throw new Error(`No Cursor credential. Run ${CURSOR_LOGIN_COMMAND} first.`);
  const sdk = deps.cursorSdk ?? loadCursorSdk();
  try {
    return coerceCursorCatalog(await sdk.Cursor.models.list({ apiKey: key }));
  } catch (error) {
    if (error instanceof Error && /not a list|catalog row \d+ is invalid/.test(error.message)) throw error;
    const message = error instanceof Error ? error.message : "Cursor catalog request failed.";
    const redacted = message.split(key).join("[redacted]");
    if (/unauthori|unauthenticated|invalid api key|api key|not logged in|authentication/i.test(redacted)) {
      throw new Error(`${redacted} Run ${CURSOR_LOGIN_COMMAND}.`);
    }
    throw new Error(redacted);
  }
}

async function resolveCursorMenu(deps: DesktopDependencies, selector: string): Promise<{ menu: BridgeModel[]; catalog?: readonly CursorCatalogItem[] }> {
  const catalog = deps.cursorCatalog ?? await fetchCursorCatalog(deps);
  let menu: BridgeModel[];
  try { menu = cursorMenuFromCatalog(catalog, selector); }
  catch (error) { throw new Error(error instanceof Error ? error.message : "Cursor catalog rejected the requested models."); }
  return { menu, ...(deps.cursorCatalog ? {} : { catalog }) };
}

function readCursorMenuFile(deps: DesktopDependencies): BridgeModel[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(desktopPaths(deps.home).cursorMenu, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed as BridgeModel[] : undefined;
  } catch { return undefined; }
}

function writeCursorMenu(deps: DesktopDependencies, menu: BridgeModel[], catalog?: readonly CursorCatalogItem[]): void {
  const paths = desktopPaths(deps.home);
  const snapshot = catalog ?? deps.cursorCatalog;
  if (snapshot) replacePrivateFile(paths.cursorCatalog, `${JSON.stringify(snapshot)}\n`);
  replacePrivateFile(paths.cursorMenu, `${JSON.stringify(menu)}\n`);
}

async function cursorDesktop(args: string[], deps: DesktopDependencies): Promise<Record<string, unknown>> {
  const [sub, filter] = args;
  const paths = desktopPaths(deps.home);
  const env = deps.env ?? {};
  const now = deps.now?.() ?? Date.now();
  if (sub === "status") {
    const text = formatCursorStatus(cursorCredentialStatus(paths.data, env, now), now);
    deps.stdout?.(text);
    return { text };
  }
  if (sub === "models") {
    const catalog = deps.cursorCatalog ?? await fetchCursorCatalog(deps);
    if (!deps.cursorCatalog) {
      mkdirSync(paths.state, { recursive: true, mode: 0o700 });
      chmodSync(paths.state, 0o700);
      replacePrivateFile(paths.cursorCatalog, `${JSON.stringify(catalog)}\n`);
    }
    const text = formatCursorCatalog(catalog, filter);
    deps.stdout?.(text);
    return { text };
  }
  if (sub === "login") {
    const login = deps.cursorLogin ?? cursorLoginFromSdk(paths.data, deps.cursorSdk ?? loadCursorSdk());
    mkdirSync(paths.data, { recursive: true, mode: 0o700 });
    const urls: string[] = [];
    const status = await loginCursor(paths.data, login, (url) => { urls.push(url); deps.stdout?.(`${url}\n`); }, now);
    const text = formatCursorStatus(status, now);
    deps.stdout?.(text);
    return { text, loginUrl: urls[0] ?? null };
  }
  throw new Error("Usage: npm run desktop -- cursor login | cursor status | cursor models [filter]");
}
export async function desktop(argv: string[], deps: DesktopDependencies): Promise<Record<string, unknown>> {
  const [action, ...options] = argv;
  if (!["install", "uninstall", "status", "restart", "cursor"].includes(action ?? "")) throw new Error("Usage: npm run desktop -- install [--port 18787] [--models id,id,...] [--cursor-models default|first-party|id,id,...] [--claude-config-dir /absolute/profile] | uninstall | status | restart [--models id,id,...] [--cursor-models ...] [--claude-config-dir /absolute/profile] | cursor login | cursor status | cursor models [filter]");
  if (deps.platform !== "darwin") throw new Error("Desktop LaunchAgent installation requires macOS.");
  if (action === "cursor") return cursorDesktop(options, deps);
  const parsed = parseOptions(action!, options);
  const paths = desktopPaths(deps.home), domain = `gui/${deps.uid}`;
  const caveat = "The service waits with backoff while /Volumes/Workspace is unmounted or required files are unavailable. Node and the repository must return at their installed paths.";
  if (action === "status") {
    const install = readInstallation(deps);
    const loaded = deps.run("launchctl", ["print", `${domain}/${LABEL}`]).status === 0;
    const scriptMode = scriptToolModels(deps.home).includes(DROID_BASE_MODEL);
    const { env, now } = cursorClock(deps);
    const cursorStatus = cursorCredentialStatus(paths.data, env, now);
    const cursorWarning = cursorExpiryWarning(cursorStatus, now);
    return { installed: true, plistPresent: existsSync(paths.plist), loaded, port: install.port, claudeConfigDir: install.claudeConfigDir ?? join(deps.home, ".claude"), models: install.models ?? "follow Claude Code settings",
      repositoryPresent: existsSync(join(install.repo, "dist/index.js")), healthy: await deps.health(install.port),
      runtime: deps.runtime ? await deps.runtime(install.port, paths.admin) : null, caveat,
      cursor: {
        loggedIn: cursorStatus.loggedIn, expired: cursorStatus.expired,
        expires: cursorStatus.expiresAt ?? (cursorStatus.source === "env" ? "unknown" : "none"),
        account: cursorStatus.accountPresent ? "present" : "absent",
      },
      ...(scriptMode ? { warning: `Droid now runs ${DROID_BASE_MODEL} in Script mode, so these models lose direct Read/Execute/Create/Edit tools. Update factory-cc to a base model outside script_tool_models.` } : {}),
      ...(cursorWarning ? { cursorWarning } : {}) };
  }
  if (action === "uninstall") {
    if (!existsSync(paths.manifest)) {
      if (existsSync(paths.state) || existsSync(paths.plist)) throw new Error("Unrecognized installation; refusing to delete files without our installation manifest.");
      return { installed: false, changed: [] };
    }
    readInstallation(deps);
    bootout(deps);
    if (existsSync(`${paths.settings}.relay-bridge.models.json`)) configureDroid(["--settings", paths.settings, "--revert"], { HOME: deps.home });
    rmSync(paths.plist, { force: true });
    rmSync(paths.state, { recursive: true });
    return { installed: false, changed: [paths.settings, `${paths.settings}.relay-bridge.bak`, `${paths.settings}.relay-bridge.bak.absent`, `${paths.settings}.relay-bridge.models.json`, paths.plist, paths.state] };
  }
  if (action === "restart") {
    const previous = readInstallation(deps);
    const explicit = parsed.cursorModels !== undefined;
    let menu: BridgeModel[] | undefined;
    let warning: string | undefined;
    let catalog: readonly CursorCatalogItem[] | undefined;
    let cursorModels = previous.cursorModels;
    if (explicit) {
      // A missing credential or an invalid id throws here, before bootout, so a working service stays up.
      const resolved = await resolveCursorMenu(deps, parsed.cursorModels!);
      menu = resolved.menu;
      catalog = resolved.catalog;
      cursorModels = parsed.cursorModels;
    } else if (!cursorLoggedIn(deps)) {
      warning = cursorAbsentNotice();
      menu = undefined;
      cursorModels = undefined;
    } else if (previous.cursorModels && existsSync(paths.cursorMenu)) {
      menu = readCursorMenuFile(deps);
      cursorModels = menu ? previous.cursorModels : undefined;
    } else cursorModels = undefined;
    const install: Installation = { ...previous, node: realpathSync(deps.node), ...(parsed.models ? { models: parsed.models } : {}),
      ...(parsed.claudeConfigDir ? { claudeConfigDir: parsed.claudeConfigDir } : {}) };
    if (cursorModels) install.cursorModels = cursorModels;
    else delete install.cursorModels;
    // The LaunchAgent runs dist/. Rebuild so the restarted service runs the current source, not a stale build.
    checkedRun(deps, deps.node, [join(install.repo, "node_modules/typescript/bin/tsc"), "-p", join(install.repo, "tsconfig.build.json")]);
    if (!existsSync(join(install.repo, "dist/index.js"))) throw new Error(caveat);
    syncModels(deps, install, menu);
    if (explicit && menu) writeCursorMenu(deps, menu, catalog);
    replacePrivateFile(paths.manifest, JSON.stringify(install, null, 2) + "\n");
    replacePrivateFile(join(paths.state, "bridge-launcher.sh"), desktopLauncher(install, paths.state));
    replacePrivateFile(paths.plist, desktopPlist(deps, install));
    bootout(deps);
    await bootstrap(deps, paths.plist);
    return { restarted: true, changed: [paths.settings, `${paths.settings}.relay-bridge.models.json`, paths.models, paths.manifest, paths.plist], models: install.models ?? "follow Claude Code settings", ...(install.cursorModels ? { cursorModels: install.cursorModels } : {}), ...(warning ? { warning } : {}), caveat };
  }
  const port = parsed.port ?? 18787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535.");
  if (!cursorPreinstallOnly(paths.state) || existsSync(paths.plist) || existsSync(`${paths.settings}.relay-bridge.models.json`) || existsSync(`${paths.settings}.relay-bridge.bak`) || existsSync(`${paths.settings}.relay-bridge.bak.absent`)) throw new Error("Existing desktop or managed-model state found. Use status/restart, or revert the previous configure-droid installation first.");
  const cursor: { menu?: BridgeModel[]; warning?: string; catalog?: readonly CursorCatalogItem[] } = parsed.cursorModels
    ? await resolveCursorMenu(deps, parsed.cursorModels)
    : cursorLoggedIn(deps) ? {} : { warning: cursorAbsentNotice() };
  const install: Installation = { version: 1, port, repo: realpathSync(deps.repo), node: realpathSync(deps.node), path: deps.path, ...(parsed.models ? { models: parsed.models } : {}), ...(cursor.menu ? { cursorModels: parsed.cursorModels } : {}),
    ...(parsed.claudeConfigDir ? { claudeConfigDir: parsed.claudeConfigDir } : {}) };
  assertClaudeCredential(readDesktopClaudeConfig(deps, install));
  checkedRun(deps, deps.node, [join(deps.repo, "node_modules/typescript/bin/tsc"), "-p", join(deps.repo, "tsconfig.build.json")]);
  if (!existsSync(join(install.repo, "dist/index.js"))) throw new Error("Missing built dist/index.js. Run npm run build.");
  await deps.assertPortFree(port);
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  chmodSync(paths.state, 0o700);
  let configured = false;
  try {
    mkdirSync(paths.data, { recursive: true, mode: 0o700 });
    chmodSync(paths.data, 0o700);
    for (const path of [paths.token, paths.admin, paths.hook]) privateFile(path, randomBytes(32).toString("hex") + "\n");
    for (const name of ["stdout.log", "stderr.log"]) privateFile(join(paths.state, name), "");
    const result = syncModels(deps, install, cursor.menu);
    if (cursor.menu) writeCursorMenu(deps, cursor.menu, cursor.catalog);
    configured = true;
    privateFile(paths.manifest, JSON.stringify(install, null, 2) + "\n");
    privateFile(join(paths.state, "bridge-launcher.sh"), desktopLauncher(install, paths.state));
    mkdirSync(dirname(paths.plist), { recursive: true });
    privateFile(paths.plist, desktopPlist(deps, install));
    await bootstrap(deps, paths.plist);
    return { installed: true, port, changed: [paths.state, paths.data, paths.token, paths.admin, paths.hook,
      join(paths.state, "stdout.log"), join(paths.state, "stderr.log"), paths.manifest, paths.models, paths.settings,
      result.backup && existsSync(String(result.backup)) ? result.backup : `${paths.settings}.relay-bridge.bak.absent`, result.metadataPath, paths.plist],
      uninstall: "npm run desktop -- uninstall", ...(cursor.warning ? { warning: cursor.warning } : {}), caveat };
  } catch (error) {
    if (configured || existsSync(`${paths.settings}.relay-bridge.models.json`)) configureDroid(["--settings", paths.settings, "--revert"], { HOME: deps.home });
    rmSync(paths.plist, { force: true });
    rmSync(paths.state, { recursive: true });
    throw error;
  }
}
export async function assertDesktopPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Cannot bind 127.0.0.1:${port}. Choose --port explicitly or stop its owner; no other ports or processes were inspected.`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  desktop(process.argv.slice(2), {
    home: homedir(), repo: resolve(dirname(fileURLToPath(import.meta.url)), ".."), node: process.execPath,
    path: process.env.PATH ?? "/usr/bin:/bin", uid: process.getuid!(), platform: process.platform, env: process.env,
    run: (command, args) => { const result = spawnSync(command, args, { encoding: "utf8", env: { HOME: homedir(), PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] }); return { status: result.status ?? 1, stdout: result.stdout }; },
    assertPortFree: assertDesktopPortFree,
    // Progress such as the Cursor login URL goes to stderr; stdout stays the JSON result.
    stdout: (text) => { process.stderr.write(text); },
    health: async (port) => { try { const result = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000), redirect: "error" }); const body: unknown = await result.json(); return result.ok && isDesktopHealthPayload(body); } catch { return false; } },
    runtime: async (port, adminFile) => {
      try {
        const result = await fetch(`http://127.0.0.1:${port}/internal/runtime`, { headers: { authorization: `Bearer ${readFileSync(adminFile, "utf8").trim()}` }, signal: AbortSignal.timeout(3000), redirect: "error" });
        if (!result.ok) return { available: false, status: result.status };
        const summary = z.object({ activeNativeSessions: z.number().optional(), slotsInUse: z.number().optional(), maxSlots: z.number().optional(), oldestTurnMs: z.number().optional(),
          upstreamBackoffs: z.array(z.object({ sessionId: z.string(), status: z.number(), retryAfter: z.number().optional(), heldForNativeWork: z.boolean(), at: z.string() })).optional(),
          pendingHostCalls: z.number().optional(), pendingApprovals: z.number().optional(), processes: z.record(z.string(), z.unknown()).optional(),
          activeRequests: z.number().optional(), retainedSessions: z.number().optional(), memory: z.record(z.string(), z.number()).optional(),
          cursor: z.object({ agents: z.number().optional(), slotsInUse: z.number().optional(), pendingHostCalls: z.number().optional() }).optional() }).parse(await result.json());
        return summary;
      } catch { return { available: false }; }
    },
  }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Desktop operation failed."); process.exitCode = 1; });
}
