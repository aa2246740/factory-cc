import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { modelsFromIds, validateModels, type BridgeModel } from "../models.js";
import { isAnthropicHost, MODEL_SLOT_NAMES, refuseBridgeLoop } from "./auth-env.js";

const NETWORK_NAMES = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "all_proxy", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
const CREDENTIAL_NAMES = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
export function claudeConfigEnvNames(): string[] { return ["ANTHROPIC_BASE_URL", ...CREDENTIAL_NAMES, ...MODEL_SLOT_NAMES, ...NETWORK_NAMES]; }
const record = z.record(z.string(), z.unknown());
const slots = ["opus", "sonnet", "haiku", "fable"];

export interface ClaudeConfig {
  path: string;
  env: Record<string, string>;
  helper?: string;
  literalNames: string[];
  ignored: string[];
  credentialSource: string;
}

export function readClaudeConfig(source: NodeJS.ProcessEnv, bridgeListen = ""): ClaudeConfig {
  const path = join(source.CLAUDE_CONFIG_DIR ?? join(source.HOME ?? homedir(), ".claude"), "settings.json");
  let settings: z.infer<typeof record> = {};
  try {
    settings = record.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error("Claude Code settings are unreadable or invalid JSON.");
  }
  const parsed = record.safeParse(settings.env === undefined ? {} : settings.env);
  if (!parsed.success) throw new Error("Claude Code settings env must be an object.");
  const configured = parsed.data;
  const ignored = Object.keys(settings).filter((name) => name !== "env" && name !== "apiKeyHelper");
  const literalNames = CREDENTIAL_NAMES.filter((name) => Object.hasOwn(configured, name));
  const overlap = literalNames.filter((name) => source[name] !== undefined);
  if (overlap.length) throw new Error(`Claude Code shell/settings credential conflict: ${overlap.join(", ")}. Stored credentials are not inspected; unset the shell names and use --key-env NAME.`);
  // Remove literal credentials without inspecting their values.
  for (const name of literalNames) delete configured[name];
  const cloud = [...new Set([...Object.keys(configured), ...Object.keys(source)])].filter((name) => name.startsWith("CLAUDE_CODE_USE_") && (Object.hasOwn(configured, name) || source[name] !== undefined));
  if (cloud.length) throw new Error(`Claude Code cloud switches ${cloud.join(", ")}: use --auth cloud.`);
  for (const name of Object.keys(configured)) if (!claudeConfigEnvNames().includes(name)) ignored.push(`env.${name}`);
  let helper: string | undefined;
  if (settings.apiKeyHelper !== undefined) {
    if (typeof settings.apiKeyHelper !== "string" || !settings.apiKeyHelper.trim()) throw new Error("Claude Code apiKeyHelper must be a nonempty string.");
    helper = settings.apiKeyHelper;
  }
  const env: Record<string, string> = {};
  for (const name of claudeConfigEnvNames()) {
    const value = configured[name];
    if (value !== undefined && typeof value !== "string") throw new Error(`Claude Code settings env.${name} must be a string.`);
    if (typeof value === "string" && source[name] !== undefined && source[name] !== value) throw new Error(`Claude Code shell/settings conflict: ${name}. Values are not shown.`);
    const resolved = source[name] ?? value;
    if (typeof resolved === "string") env[name] = resolved;
  }
  for (const name of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]) if (source[name] !== undefined) env[name] = source[name]!;
  if (env.ANTHROPIC_BASE_URL) {
    let url: URL;
    try { url = new URL(env.ANTHROPIC_BASE_URL); } catch { throw new Error("ANTHROPIC_BASE_URL must be an HTTP(S) URL without credentials."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /[\s\x00-\x1f\x7f]/.test(env.ANTHROPIC_BASE_URL)) throw new Error("ANTHROPIC_BASE_URL must be an HTTP(S) URL without credentials.");
  }
  refuseBridgeLoop(env.ANTHROPIC_BASE_URL, bridgeListen);
  const credentialSource = helper ? "apiKeyHelper from settings (run by Claude Code)" : CREDENTIAL_NAMES.find((name) => env[name]) ? `shell ${CREDENTIAL_NAMES.find((name) => env[name])}` : "Claude login";
  const result = { path, env, helper, literalNames, ignored: ignored.sort(), credentialSource };
  guardClaudeKey(result);
  return result;
}

export function needsClaudeCredential(config: ClaudeConfig): boolean {
  return config.literalNames.length > 0 && !config.helper && !CREDENTIAL_NAMES.some((name) => config.env[name]);
}

export function supplyClaudeCredential(config: ClaudeConfig, key: string, source: string): void {
  if (!key || /[\x00-\x20\x7f]/.test(key) || key.length > 16384) throw new Error("Provide a nonempty Claude Code credential without whitespace.");
  for (const name of config.literalNames.length ? config.literalNames : ["ANTHROPIC_API_KEY"]) config.env[name] = key;
  config.credentialSource = source;
  guardClaudeKey(config);
}

function guardClaudeKey(config: ClaudeConfig): void {
  const host = config.env.ANTHROPIC_BASE_URL ? new URL(config.env.ANTHROPIC_BASE_URL).hostname : "api.anthropic.com";
  if (CREDENTIAL_NAMES.some((name) => config.env[name]?.startsWith("sk-ant-")) && !isAnthropicHost(host)) throw new Error("Refusing to send an Anthropic API key (sk-ant-) to a host outside anthropic.com.");
}

export function assertClaudeCredential(config: ClaudeConfig): void {
  if (needsClaudeCredential(config)) throw new Error(`Literal settings credentials are not used (${config.literalNames.join(", ")}). Supply a shell credential, --key-env NAME or type it at launch.`);
}

export function claudeConfigNeedsLogin(config: ClaudeConfig): boolean {
  return !config.env.ANTHROPIC_BASE_URL && !config.helper && !CREDENTIAL_NAMES.some((name) => config.env[name]);
}

export const CLAUDE_LOGIN_REQUIRED = "Claude Code is not logged in. Run claude and log in, then retry.";

export function claudeConfigModels(config: ClaudeConfig): { models: BridgeModel[]; defaultModel: string } {
  let models = slots.flatMap((alias) => {
    const mapped = config.env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`];
    return mapped ? [{ id: alias, model: alias, displayName: `${modelsFromIds([alias], "claude-config")[0]!.displayName} (${mapped})` }] : [];
  });
  if (!models.length) models = modelsFromIds(["sonnet", "opus", "haiku"], "claude-config");
  const selected = config.env.ANTHROPIC_MODEL;
  const match = selected && models.find((item) => item.id === selected || config.env[`ANTHROPIC_DEFAULT_${item.id.toUpperCase()}_MODEL`] === selected);
  if (selected && !match) models.push(...modelsFromIds([selected], "claude-config"));
  return { models: validateModels(models), defaultModel: match ? match.id : selected ?? models[0]!.id };
}

export function claudeConfigSummary(config: ClaudeConfig, models: BridgeModel[], defaultModel: string): string {
  const target = config.env.ANTHROPIC_BASE_URL ? new URL(config.env.ANTHROPIC_BASE_URL).origin : "official Anthropic default";
  return `Claude Code settings: ${config.path}\nRequest target: ${target}\nCredential source: ${config.credentialSource}\n${config.helper && config.literalNames.length ? "Literal settings credential values are not used.\n" : ""}Models: ${models.map((item) => item.displayName).join(", ")}\nDefault model: ${defaultModel}\nNot carried over: ${config.ignored.join(", ") || "none"}\n`;
}

export function redactClaudeConfigText(config: ClaudeConfig | undefined, text: string): string {
  if (!config) return text;
  for (const value of [config.helper, ...CREDENTIAL_NAMES.map((name) => config.env[name]), config.env.CLAUDE_CODE_OAUTH_TOKEN]) {
    if (value) text = text.replaceAll(value, "[REDACTED]");
  }
  return text;
}
