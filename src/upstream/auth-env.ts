import { isAbsolute } from "node:path";
import { BridgeError } from "../types.js";
import type { UpstreamSelection } from "./providers.js";

/**
 * The operator declares one auth mode. The bridge then builds the Claude Code
 * environment so that declaration is what actually runs.
 *
 * `inherit` is the legacy full-environment escape hatch. Every other mode
 * starts from a name allowlist. A variable that would select a different
 * credential or host is refused before a process starts. Error text lists
 * variable names only.
 *
 * Live `accountInfo()` strings are not yet confirmed against a real Claude
 * account. `classifyAuth` therefore stays narrow and fails closed: an
 * unrecognized combination is `unknown`, never a guessed success.
 */
export const AUTH_MODES = ["byok", "subscription", "anthropic-api", "cloud", "inherit"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const API_KEY_SOURCES = [
  "ANTHROPIC_API_KEY",
  "apiKeyHelper",
  "/login managed key",
  "user",
  "project",
  "org",
  "temporary",
] as const;

/** Model-routing variables. BYOK overwrites them; subscription refuses leftovers. */
export const MODEL_SLOT_NAMES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL",
] as const;

const CLOUD_SWITCHES = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] as const;
const BRIDGE_UPSTREAM_NAMES = ["BRIDGE_UPSTREAM_BASE_URL", "BRIDGE_UPSTREAM_MODEL", "BRIDGE_UPSTREAM_TOKEN_ENV"] as const;
const BRIDGE_INTERNAL_NAMES = ["BRIDGE_ADMIN_TOKEN", "BRIDGE_FACTORY_BINDING", "BRIDGE_FACTORY_LAUNCH_ID", "BRIDGE_LAUNCH_ID"] as const;
const CLOUD_PASSTHROUGH = [
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_VERTEX_BASE_URL",
] as const;

const BASE_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "TZ", "LANG",
  "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "all_proxy", "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // Skills and the bridge agree on the workspace through this name. It is a path, not a credential.
  "BRIDGE_SDK_CWD",
]);

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FD_PATTERN = /^(?:CLAUDE_CODE_|CCR_).+_FILE_DESCRIPTOR$/;

export interface BuildChildEnvOptions {
  bridgeListen?: string;
  /** Overrides `sourceEnv.BRIDGE_ENV_PASSTHROUGH` when provided, including an empty string. */
  passthrough?: string;
}

export interface AuthObservation {
  subscriptionType?: string;
  apiKeySource?: string;
  tokenSource?: string;
}

export interface AuthClassification {
  kind: "subscription" | "anthropic-api" | "cloud" | "unknown";
  reason: string;
}

export function parseAuthMode(value: string | undefined): AuthMode {
  if (value === undefined || value === "") return "byok";
  if ((AUTH_MODES as readonly string[]).includes(value)) return value as AuthMode;
  throw new Error(`Invalid BRIDGE_AUTH=${value}. Use ${AUTH_MODES.join(" | ")}.`);
}

export function isAnthropicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "anthropic.com" || host.endsWith(".anthropic.com");
}

/** `https://api.anthropic.com` with or without one trailing slash. Anything else is a different host. */
export function isOfficialAnthropicApiBase(value: string): boolean {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    return url.protocol === "https:" && url.hostname.toLowerCase() === "api.anthropic.com" && url.port === ""
      && path === "" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function maskEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "***";
  return `${email[0]}***@${email.slice(at + 1)}`;
}

/**
 * Map SDK account metadata to a mode.
 *
 * `apiKeySource` / the system-init source wins when it is one of the known API
 * origins. A non-empty `subscriptionType` is subscription only when neither
 * source says the session is on an API key. `tokenSource` is ignored on
 * purpose: its live values are not verified, and treating it as proof would
 * accept the wrong billing path. Cloud backends are not classified here; cloud
 * mode is checked from `CLAUDE_CODE_USE_*` before the process starts.
 * `apiKeySource: "none"` and the legacy `"oauth"` value are not API origins.
 * They stay `unknown` unless `subscriptionType` is set.
 */
export function classifyAuth(info: AuthObservation, initApiKeySource?: string): AuthClassification {
  const sources = [info.apiKeySource, initApiKeySource].filter((value): value is string => Boolean(value && value.trim()));
  const apiSource = sources.find((value) => (API_KEY_SOURCES as readonly string[]).includes(value));
  if (apiSource) return { kind: "anthropic-api", reason: `api key source ${apiSource}` };
  if (info.subscriptionType && info.subscriptionType.trim()) {
    return { kind: "subscription", reason: "non-empty subscriptionType without an API key source" };
  }
  return { kind: "unknown", reason: "no recognized subscriptionType or API key source; cloud cannot be inferred from account info" };
}

/** Names currently set to a non-empty value that this mode refuses. Useful for tests; does not throw. */
export function forbiddenNamesIn(mode: AuthMode, sourceEnv: NodeJS.ProcessEnv): string[] {
  return Object.keys(sourceEnv).filter((key) => isForbiddenValue(mode, key, sourceEnv[key])).sort();
}

export function preflightAuth(
  mode: AuthMode,
  sourceEnv: NodeJS.ProcessEnv,
  selection?: UpstreamSelection,
  opts?: BuildChildEnvOptions,
): void {
  buildChildEnv(mode, sourceEnv, selection, opts);
}

export function buildChildEnv(
  mode: AuthMode,
  sourceEnv: NodeJS.ProcessEnv,
  selection?: UpstreamSelection,
  opts: BuildChildEnvOptions = {},
): Record<string, string> {
  const bridgeListen = opts.bridgeListen ?? "";
  if (mode === "inherit") return inheritEnv(sourceEnv, bridgeListen);

  const passthrough = parsePassthrough(opts.passthrough !== undefined ? opts.passthrough : sourceEnv.BRIDGE_ENV_PASSTHROUGH);
  const passthroughHits = passthrough.filter((key) => isForbiddenName(mode, key, sourceEnv[key]));
  if (passthroughHits.length) throw authEnvError(mode, passthroughHits, "BRIDGE_ENV_PASSTHROUGH includes");
  const present = forbiddenNamesIn(mode, sourceEnv);
  if (present.length) throw authEnvError(mode, present, "these environment variables are set");
  assertRequirements(mode, sourceEnv, selection);

  const env = baseEnv(sourceEnv);
  for (const key of extraNames(mode, sourceEnv)) copyIfSet(env, sourceEnv, key);
  for (const key of passthrough) copyIfSet(env, sourceEnv, key);
  if (mode === "byok") applyByokSelection(env, sourceEnv, selection!);
  refuseBridgeLoop(env.ANTHROPIC_BASE_URL, bridgeListen);
  return env;
}

function inheritEnv(sourceEnv: NodeJS.ProcessEnv, bridgeListen: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  for (const key of BRIDGE_INTERNAL_NAMES) delete env[key];
  refuseBridgeLoop(env.ANTHROPIC_BASE_URL, bridgeListen);
  return env;
}

function baseEnv(sourceEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (BASE_NAMES.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = sourceEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1";
  env.API_TIMEOUT_MS = sourceEnv.API_TIMEOUT_MS ?? "600000";
  env.CLAUDE_AGENT_SDK_CLIENT_APP = sourceEnv.CLAUDE_AGENT_SDK_CLIENT_APP ?? "relay-bridge/0.1.0";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

function extraNames(mode: AuthMode, sourceEnv: NodeJS.ProcessEnv): string[] {
  if (mode === "subscription") return ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"];
  if (mode === "anthropic-api") {
    const names = ["ANTHROPIC_API_KEY", ...MODEL_SLOT_NAMES];
    if (sourceEnv.ANTHROPIC_BASE_URL && isOfficialAnthropicApiBase(sourceEnv.ANTHROPIC_BASE_URL)) names.push("ANTHROPIC_BASE_URL");
    return names;
  }
  if (mode === "cloud") {
    const selected = CLOUD_SWITCHES.filter((key) => truthy(sourceEnv[key]));
    return [
      ...selected,
      ...CLOUD_PASSTHROUGH,
      ...MODEL_SLOT_NAMES,
      ...Object.keys(sourceEnv).filter((key) => key.startsWith("ANTHROPIC_FOUNDRY_") || key.startsWith("VERTEX_REGION_")),
    ];
  }
  return [];
}

function applyByokSelection(env: Record<string, string>, sourceEnv: NodeJS.ProcessEnv, selection: UpstreamSelection): void {
  const token = sourceEnv[selection.provider.tokenEnv] ?? "";
  env.ANTHROPIC_BASE_URL = selection.provider.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = token;
  env.ANTHROPIC_API_KEY = "";
  Object.assign(env, selection.modelSlots);
}

function assertRequirements(mode: AuthMode, sourceEnv: NodeJS.ProcessEnv, selection?: UpstreamSelection): void {
  if (mode === "byok") {
    if (!selection) throw new Error("BYOK sdkEnv requires an upstream selection");
    const token = sourceEnv[selection.provider.tokenEnv] ?? "";
    if (!token.trim()) {
      throw new BridgeError(401, "blocked_auth", "The selected BYOK key is no longer available; refusing to start Claude Code with ambient credentials.");
    }
  }
  if (mode === "anthropic-api") {
    const helper = sourceEnv.BRIDGE_API_KEY_HELPER?.trim() ?? "";
    if (helper && !isAbsolute(helper)) {
      throw new BridgeError(400, "invalid_api_key_helper", "BRIDGE_API_KEY_HELPER must be an absolute path. The SDK settings option receives that path; relative paths are refused.");
    }
    if (!sourceEnv.ANTHROPIC_API_KEY?.trim() && !helper) {
      throw new BridgeError(401, "auth_env_rejected", "BRIDGE_AUTH=anthropic-api requires ANTHROPIC_API_KEY, or an absolute BRIDGE_API_KEY_HELPER. Values are not shown.");
    }
  }
  if (mode === "cloud") {
    const enabled = CLOUD_SWITCHES.filter((key) => truthy(sourceEnv[key]));
    if (enabled.length !== 1) {
      throw new BridgeError(400, "auth_env_rejected", `BRIDGE_AUTH=cloud requires exactly one of ${CLOUD_SWITCHES.join(", ")}. Found ${enabled.length ? enabled.join(", ") : "none"}. Values are not shown.`);
    }
  }
}

function parsePassthrough(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const names = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const invalid = names.filter((name) => !NAME_PATTERN.test(name));
  if (invalid.length) {
    throw new BridgeError(400, "invalid_env_passthrough", `BRIDGE_ENV_PASSTHROUGH has invalid names: ${invalid.join(", ")}. Use comma-separated environment variable names.`);
  }
  return [...new Set(names)];
}

function isForbiddenValue(mode: AuthMode, key: string, value: string | undefined): boolean {
  return Boolean(value) && isForbiddenName(mode, key, value);
}

/** A passthrough request for one of these names is refused even when the value is empty. */
function isForbiddenName(mode: AuthMode, key: string, value: string | undefined): boolean {
  if (mode === "byok" || mode === "inherit") return false;
  if (mode === "anthropic-api" && key === "ANTHROPIC_BASE_URL") return typeof value === "string" && value.length > 0 && !isOfficialAnthropicApiBase(value);
  if ((BRIDGE_UPSTREAM_NAMES as readonly string[]).includes(key)) return mode === "subscription" || mode === "anthropic-api" || mode === "cloud";
  if (mode === "subscription") return subscriptionForbidden(key);
  if (mode === "anthropic-api") return anthropicApiForbidden(key);
  if (mode === "cloud") return ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"].includes(key);
  return false;
}

function subscriptionForbidden(key: string): boolean {
  if ([
    "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_UNIX_SOCKET",
    "CLAUDE_CODE_API_BASE_URL", "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL", "CLAUDE_CODE_GATEWAY_TOKEN", "AGENT_PROXY_AUTH_TOKEN",
  ].includes(key)) return true;
  if ((MODEL_SLOT_NAMES as readonly string[]).includes(key)) return true;
  return key.startsWith("CLAUDE_CODE_USE_") || FD_PATTERN.test(key);
}

function anthropicApiForbidden(key: string): boolean {
  if ([
    "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_UNIX_SOCKET",
    "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_GATEWAY_TOKEN", "AGENT_PROXY_AUTH_TOKEN",
  ].includes(key)) return true;
  return key.startsWith("CLAUDE_CODE_USE_") || FD_PATTERN.test(key);
}

function authEnvError(mode: AuthMode, names: string[], because: string): BridgeError {
  const listed = [...new Set(names)].sort();
  const hints: string[] = [];
  if (listed.includes("ANTHROPIC_API_KEY")) hints.push("use BRIDGE_AUTH=anthropic-api for ANTHROPIC_API_KEY");
  if (listed.some((name) => name.startsWith("CLAUDE_CODE_USE_"))) hints.push("use BRIDGE_AUTH=cloud for CLAUDE_CODE_USE_*");
  const hint = hints.length ? ` ${hints.join("; ")}.` : "";
  return new BridgeError(400, "auth_env_rejected", `BRIDGE_AUTH=${mode} refuses to start because ${because}: ${listed.join(", ")}.${hint} Values are not shown.`);
}

function copyIfSet(env: Record<string, string>, sourceEnv: NodeJS.ProcessEnv, key: string): void {
  const value = sourceEnv[key];
  if (value !== undefined) env[key] = value;
}

function truthy(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function refuseBridgeLoop(baseUrl: string | undefined, bridgeListen: string): void {
  if (!baseUrl) return;
  if ((bridgeListen && baseUrl.includes(bridgeListen)) || /127\.0\.0\.1:1878/.test(baseUrl)) {
    throw new Error("refusing to point Claude Code ANTHROPIC_BASE_URL at Relay Bridge");
  }
}
