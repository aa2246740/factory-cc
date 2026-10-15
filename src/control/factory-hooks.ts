import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FACTORY_HOOK_EVENTS = ["SessionStart", "PostToolUse", "SessionEnd", "Notification", "Stop", "SubagentStop"] as const;
const MAX_HOOK_BYTES = 4 * 1024 * 1024;
const CONFIG_FLAG = "--factory-cc-hook-config";

type JsonObject = Record<string, unknown>;
interface HookConfig { url: string; adminToken: string; command?: string }
export interface FactoryHookInstallOptions {
  hooksPath: string;
  configPath: string;
  url: string;
  adminToken: string;
  /** Override only for packaged installations with their own executable. No credentials belong here. */
  command?: string;
}

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function factoryHookEndpoint(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("Factory hooks require a loopback HTTP bridge URL"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Factory hooks require a loopback HTTP bridge URL");
  }
  return new URL("/internal/host-events", url).href;
}

function privateWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function defaultCommand(configPath: string): string {
  const current = fileURLToPath(import.meta.url);
  // A built distribution runs this module directly; source checkout commands
  // use the installed TS loader and the small documented script entrypoint.
  const invocation = current.endsWith(".ts")
    ? [process.execPath, "--import", createRequire(import.meta.url).resolve("tsx"), resolve(dirname(current), "../../scripts/factory-hook.ts")]
    : [process.execPath, current];
  return [...invocation, CONFIG_FLAG, configPath].map(quote).join(" ");
}

function readHooks(path: string): JsonObject {
  try {
    let value: unknown;
    if (existsSync(path)) value = JSON.parse(readFileSync(path, "utf8"));
    else {
      const settingsPath = join(dirname(path), "settings.json");
      if (!existsSync(settingsPath)) return {};
      const settings: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (!object(settings)) throw new Error();
      value = settings.hooks ?? {};
    }
    if (!object(value) || Object.values(value).some((groups) => !Array.isArray(groups))) throw new Error();
    return value;
  } catch { throw new Error("Invalid Factory hooks JSON; hooks were not changed"); }
}

function withoutCommand(groups: unknown[], command: string): unknown[] {
  return groups.flatMap((group) => {
    if (!object(group) || !Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter((hook) => !object(hook) || hook.type !== "command" || hook.command !== command);
    if (hooks.length === group.hooks.length) return [group];
    return hooks.length ? [{ ...group, hooks }] : [];
  });
}

/** Merge the adapter into official hook configuration without replacing user hooks. */
export function installFactoryHooks(options: FactoryHookInstallOptions): { hooksPath: string; configPath: string; events: readonly string[] } {
  factoryHookEndpoint(options.url);
  if (!options.adminToken.trim()) throw new Error("Factory hooks require a nonempty admin token");
  if (!isAbsolute(options.hooksPath) || !isAbsolute(options.configPath)) throw new Error("Factory hook paths must be absolute");
  if (resolve(options.hooksPath) === resolve(options.configPath)) throw new Error("Factory hooks and private configuration require separate paths");
  const hooks = readHooks(options.hooksPath);
  const command = options.command ?? defaultCommand(options.configPath);
  let previousCommand: string | undefined;
  if (existsSync(options.configPath)) {
    const previous = readConfig(options.configPath);
    previousCommand = previous.command;
  }
  for (const event of FACTORY_HOOK_EVENTS) {
    let groups = (hooks[event] ?? []) as unknown[];
    if (previousCommand) groups = withoutCommand(groups, previousCommand);
    groups = withoutCommand(groups, command);
    hooks[event] = [...groups, { hooks: [{ type: "command", command, timeout: 15 }] }];
  }
  // Credentials never occur in hooks.json, process argv, or the return value.
  privateWrite(options.configPath, `${JSON.stringify({ url: options.url, adminToken: options.adminToken, command })}\n`);
  privateWrite(options.hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  return { hooksPath: options.hooksPath, configPath: options.configPath, events: FACTORY_HOOK_EVENTS };
}

/** Remove only this installation, retaining hooks added by users after installation. */
export function removeFactoryHooks(options: { hooksPath: string; configPath: string }): { removed: boolean } {
  if (!existsSync(options.configPath)) return { removed: false };
  const config = readConfig(options.configPath);
  if (!config.command) throw new Error("Factory hook configuration has no installation command");
  const hooks = readHooks(options.hooksPath);
  for (const event of FACTORY_HOOK_EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = withoutCommand(hooks[event] as unknown[], config.command);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (existsSync(options.hooksPath)) privateWrite(options.hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);
  rmSync(options.configPath, { force: true });
  return { removed: true };
}

function readConfig(path: string): HookConfig {
  let config: unknown;
  try { config = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("Cannot read private Factory hook configuration"); }
  if (!object(config) || typeof config.url !== "string" || typeof config.adminToken !== "string" || !config.adminToken.trim()
      || (config.command !== undefined && typeof config.command !== "string")) throw new Error("Invalid private Factory hook configuration");
  factoryHookEndpoint(config.url);
  // Keep existing installations private even if an external editor broadened permissions.
  chmodSync(path, 0o600);
  return config as unknown as HookConfig;
}

export async function forwardFactoryHook(
  config: { url: string; adminToken: string }, event: unknown,
  options: { fetch?: typeof fetch; eventId?: string; timeoutMs?: number; bindingToken?: string; launchId?: string } = {},
): Promise<{ additionalContext?: string; bindingToken?: string }> {
  if (!object(event) || typeof event.hook_event_name !== "string" || typeof event.session_id !== "string" || !event.session_id
      || !FACTORY_HOOK_EVENTS.includes(event.hook_event_name as typeof FACTORY_HOOK_EVENTS[number])) throw new Error("Invalid Factory lifecycle hook event");
  if (!config.adminToken.trim()) throw new Error("Factory hooks require a nonempty admin token");
  const url = factoryHookEndpoint(config.url);
  const body = JSON.stringify({ eventId: options.eventId ?? randomUUID(), event, ...(options.bindingToken ? { bindingToken: options.bindingToken } : {}),
    ...(event.hook_event_name === "SessionStart" && options.launchId ? { launchId: options.launchId } : {}) });
  if (Buffer.byteLength(body) > MAX_HOOK_BYTES) throw new Error("Factory lifecycle hook event exceeds size limit");
  const send = options.fetch ?? fetch;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await send(url, { method: "POST", headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 3_000), redirect: "error" });
      if (!response.ok) {
        if (response.status >= 500 && attempt < 2) { await response.body?.cancel(); continue; }
        await response.body?.cancel();
        throw new HookRejectedError();
      }
      const result: unknown = await response.json();
      if (!object(result) || result.ok !== true || (result.additionalContext !== undefined && typeof result.additionalContext !== "string")) throw new HookRejectedError();
      if (result.bindingToken !== undefined && (typeof result.bindingToken !== "string" || !/^[a-f0-9]{64}$/.test(result.bindingToken))) throw new HookRejectedError();
      return event.hook_event_name === "SessionStart"
        ? { ...(typeof result.additionalContext === "string" ? { additionalContext: result.additionalContext } : {}), ...(typeof result.bindingToken === "string" ? { bindingToken: result.bindingToken } : {}) } : {};
    } catch (error) {
      if (error instanceof HookRejectedError || attempt === 2) throw new Error("Factory lifecycle event was not accepted by the bridge");
    }
  }
  throw new Error("Factory lifecycle event was not accepted by the bridge");
}
class HookRejectedError extends Error {}

/** Factory loads this official SessionStart environment file for later hooks. */
export function persistFactoryBinding(event: unknown, bindingToken: string): void {
  if (!object(event) || event.hook_event_name !== "SessionStart" || typeof event.CLAUDE_ENV_FILE !== "string"
      || !isAbsolute(event.CLAUDE_ENV_FILE) || !/^[a-f0-9]{64}$/.test(bindingToken)) {
    throw new Error("Factory SessionStart requires its official environment file and generation binding");
  }
  const fd = openSync(event.CLAUDE_ENV_FILE, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `\nexport BRIDGE_FACTORY_BINDING='${bindingToken}'\n`); }
  finally { closeSync(fd); }
}

export async function factoryHookMain(argv = process.argv.slice(2)): Promise<void> {
  const index = argv.indexOf(CONFIG_FLAG);
  const path = index < 0 ? undefined : argv[index + 1];
  if (!path || !isAbsolute(path)) throw new Error("Factory hook requires an absolute private configuration path");
  const config = readConfig(path);
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_HOOK_BYTES) throw new Error("Factory lifecycle hook event exceeds size limit");
    chunks.push(buffer);
  }
  let event: unknown;
  try { event = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Invalid Factory lifecycle hook JSON"); }
  const bindingToken = process.env.BRIDGE_FACTORY_BINDING;
  if (object(event) && event.hook_event_name !== "SessionStart" && (!bindingToken || !/^[a-f0-9]{64}$/.test(bindingToken))) {
    throw new Error("Factory lifecycle event has no SessionStart generation binding");
  }
  const result = await forwardFactoryHook(config, event, { bindingToken, launchId: process.env.BRIDGE_FACTORY_LAUNCH_ID });
  if (object(event) && event.hook_event_name === "SessionStart") {
    if (!result.bindingToken || !result.additionalContext) throw new Error("Factory SessionStart received no generation binding");
    persistFactoryBinding(event, result.bindingToken);
  }
  if (result.additionalContext) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: result.additionalContext }, suppressOutput: true })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  factoryHookMain().catch(() => {
    process.stderr.write("Factory lifecycle bridge unavailable; event delivery failed.\n");
    process.exitCode = 1;
  });
}
