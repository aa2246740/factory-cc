import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { modelsFromIds, parseModelIds, type BridgeModel } from "../src/models.js";
import { assertClaudeCredential, claudeConfigModels, readClaudeConfig } from "../src/upstream/claude-config.js";
import { configureDroid } from "./configure-droid.js";

const LABEL = "ai.factory-cc.bridge";
const installationSchema = z.object({ version: z.literal(1), port: z.number().int().min(1).max(65535), repo: z.string(), node: z.string(), path: z.string(),
  // Explicit Droid menu models; absent means follow the Claude Code settings aliases.
  models: z.array(z.string()).optional() });
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
}
export function desktopPaths(home: string) {
  const state = join(home, "Library/Application Support/factory-cc");
  return { state, data: join(state, "bridge-data"), token: join(state, "client-token"),
    admin: join(state, "admin-token"), hook: join(state, "hook-token"),
    manifest: join(state, "installation.json"), models: join(state, "models.env"),
    plist: join(home, `Library/LaunchAgents/${LABEL}.plist`), settings: join(home, ".factory/settings.json") };
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
    BRIDGE_ADMIN_TOKEN_FILE: paths.admin, BRIDGE_HOOK_TOKEN_FILE: paths.hook,
    ...(install.models ? { BRIDGE_MODELS: install.models.join(",") } : {}) };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(install.node)}</string><string>${xml(join(install.repo, "dist/index.js"))}</string></array>
<key>WorkingDirectory</key><string>${xml(install.repo)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("\n")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(paths.state, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(paths.state, "stderr.log"))}</string>
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
function syncModels(deps: DesktopDependencies, install: Installation) {
  const paths = desktopPaths(deps.home);
  // Deliberately use exactly the environment launchd will receive. Never inherit shell credentials.
  const config = readClaudeConfig({ HOME: deps.home, PATH: install.path }, `127.0.0.1:${install.port}`);
  assertClaudeCredential(config);
  const models = install.models ? modelsFromIds(install.models, "claude-config").map(explicitLabel)
    : claudeConfigModels(config).models.map((model) => ({ ...model, displayName: `Claude Code · ${model.displayName.replace(/^Claude /, "")}` }));
  return configureDroid(["--settings", paths.settings, "--base-url", `http://127.0.0.1:${install.port}`, "--auth", "claude-config",
    "--manifest", paths.models, "--preserve-selections"], { HOME: deps.home }, models,
  { apiKeyHelper: `/bin/cat '${paths.token.replaceAll("'", "'\\''")}'`, apiKeyHelperTtlMs: 300000 });
}
/** claude-opus-5-5 -> "Claude Code · Opus 5.5 (claude-opus-5-5)"; other IDs are shown as given. */
function explicitLabel(model: BridgeModel): BridgeModel {
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/.exec(model.id);
  const name = match ? `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${match[2]}.${match[3]} (${model.id})` : model.id;
  return { ...model, displayName: `Claude Code · ${name}` };
}
function parseOptions(action: string, options: string[]): { port?: number; models?: string[] } {
  const parsed: { port?: number; models?: string[] } = {};
  for (let index = 0; index < options.length; index += 2) {
    const [flag, value] = [options[index], options[index + 1]];
    if (flag === "--port" && action === "install" && parsed.port === undefined && /^\d+$/.test(value ?? "")) parsed.port = Number(value);
    else if (flag === "--models" && ["install", "restart"].includes(action) && parsed.models === undefined && value) parsed.models = parseModelIds(value);
    else throw new Error("Options: install [--port <1..65535>] [--models id,id,...]; restart [--models id,id,...].");
  }
  return parsed;
}
export async function desktop(argv: string[], deps: DesktopDependencies): Promise<Record<string, unknown>> {
  const [action, ...options] = argv;
  if (!["install", "uninstall", "status", "restart"].includes(action ?? "")) throw new Error("Usage: npm run desktop -- install [--port 18787] [--models id,id,...] | uninstall | status | restart [--models id,id,...]");
  if (deps.platform !== "darwin") throw new Error("Desktop LaunchAgent installation requires macOS.");
  const parsed = parseOptions(action!, options);
  const paths = desktopPaths(deps.home), domain = `gui/${deps.uid}`;
  const caveat = "The repository and Node executable must remain available. If /Volumes/Workspace is unmounted, this service cannot start.";
  if (action === "status") {
    const install = readInstallation(deps);
    const loaded = deps.run("launchctl", ["print", `${domain}/${LABEL}`]).status === 0;
    return { installed: true, plistPresent: existsSync(paths.plist), loaded, port: install.port, models: install.models ?? "follow Claude Code settings",
      repositoryPresent: existsSync(join(install.repo, "dist/index.js")), healthy: await deps.health(install.port), caveat };
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
    const install = { ...readInstallation(deps), ...(parsed.models ? { models: parsed.models } : {}) };
    if (!existsSync(join(install.repo, "dist/index.js"))) throw new Error(caveat);
    syncModels(deps, install); // Validate before stopping a working service.
    replacePrivateFile(paths.manifest, JSON.stringify(install, null, 2) + "\n");
    replacePrivateFile(paths.plist, desktopPlist(deps, install));
    bootout(deps);
    checkedRun(deps, "launchctl", ["bootstrap", domain, paths.plist]);
    return { restarted: true, changed: [paths.settings, `${paths.settings}.relay-bridge.models.json`, paths.models, paths.manifest, paths.plist], models: install.models ?? "follow Claude Code settings", caveat };
  }
  const port = parsed.port ?? 18787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535.");
  if (existsSync(paths.state) || existsSync(paths.plist) || existsSync(`${paths.settings}.relay-bridge.models.json`) || existsSync(`${paths.settings}.relay-bridge.bak`) || existsSync(`${paths.settings}.relay-bridge.bak.absent`)) throw new Error("Existing desktop or managed-model state found. Use status/restart, or revert the previous configure-droid installation first.");
  const install: Installation = { version: 1, port, repo: realpathSync(deps.repo), node: realpathSync(deps.node), path: deps.path, ...(parsed.models ? { models: parsed.models } : {}) };
  assertClaudeCredential(readClaudeConfig({ HOME: deps.home, PATH: deps.path }, `127.0.0.1:${port}`));
  checkedRun(deps, deps.node, [join(deps.repo, "node_modules/typescript/bin/tsc"), "-p", join(deps.repo, "tsconfig.build.json")]);
  if (!existsSync(join(install.repo, "dist/index.js"))) throw new Error("Missing built dist/index.js. Run npm run build.");
  await deps.assertPortFree(port);
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  chmodSync(paths.state, 0o700);
  let configured = false;
  try {
    mkdirSync(paths.data, { mode: 0o700 });
    for (const path of [paths.token, paths.admin, paths.hook]) privateFile(path, randomBytes(32).toString("hex") + "\n");
    for (const name of ["stdout.log", "stderr.log"]) privateFile(join(paths.state, name), "");
    const result = syncModels(deps, install);
    configured = true;
    privateFile(paths.manifest, JSON.stringify(install, null, 2) + "\n");
    mkdirSync(dirname(paths.plist), { recursive: true });
    privateFile(paths.plist, desktopPlist(deps, install));
    checkedRun(deps, "launchctl", ["bootstrap", domain, paths.plist]);
    return { installed: true, port, changed: [paths.state, paths.data, paths.token, paths.admin, paths.hook,
      join(paths.state, "stdout.log"), join(paths.state, "stderr.log"), paths.manifest, paths.models, paths.settings,
      result.backup && existsSync(String(result.backup)) ? result.backup : `${paths.settings}.relay-bridge.bak.absent`, result.metadataPath, paths.plist],
      uninstall: "npm run desktop -- uninstall", caveat };
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
    path: process.env.PATH ?? "/usr/bin:/bin", uid: process.getuid!(), platform: process.platform,
    run: (command, args) => { const result = spawnSync(command, args, { encoding: "utf8", env: { HOME: homedir(), PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] }); return { status: result.status ?? 1, stdout: result.stdout }; },
    assertPortFree: assertDesktopPortFree,
    health: async (port) => { try { const result = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000), redirect: "error" }); const body: unknown = await result.json(); return result.ok && z.object({ ok: z.literal(true), mode: z.literal("sdk") }).safeParse(body).success; } catch { return false; } },
  }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Desktop operation failed."); process.exitCode = 1; });
}
