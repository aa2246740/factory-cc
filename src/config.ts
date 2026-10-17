import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { isIPv6 } from "node:net";
import { resolve } from "node:path";
import type { BridgeMode } from "./types.js";
import { parseAuthMode, type AuthMode } from "./upstream/auth-env.js";
import { canonicalWorkspacePath } from "./workspace.js";
import { modelsFromIds, parseModelIds, validateModels, type BridgeModel } from "./models.js";

export interface BridgeConfig {
  host: string;
  port: number;
  mode: BridgeMode;
  clientToken: string;
  adminToken: string;
  hookToken: string;
  /** Operator opted in to a non-loopback bind. Never true for subscription. */
  allowRemote: boolean;
  /** Names or IPs remote clients use to reach the bridge. Honored only with allowRemote. */
  allowedHosts: string[];
  dataDir: string;
  logDir: string;
  sandboxDir: string;
  maxBodyBytes: number;
  maxSessions: number;
  maxTurns: number;
  toolWaitMs: number;
  /** Idle expiry for a session parked on a Droid tool result. */
  toolWaitTimeoutMs: number;
  /** Idle limit for one native turn. Any SDK message, delta or tool event restarts it; approvals pause it. */
  requestTimeoutMs: number;
  /** How long a human has to answer an approval on the Control page. */
  approvalTimeoutMs: number;
  /** Absolute cap for one native turn, whatever progress it reports. */
  turnMaxMs: number;
  claudeExecutable?: string;
  sdkCwd: string;
  persistSessions: boolean;
  /** Write full request bodies to the request log. Off by default: only a hash, size and tool names. */
  logBodies: boolean;
  authMode: AuthMode;
  permissionMode: "bypass" | "ask";
  upstreamBaseUrl?: string;
  upstreamModel?: string;
  upstreamTokenEnv?: string;
  models?: BridgeModel[];
}

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** `127.0.0.1`, any other `127.x.x.x`, `localhost`, or `::1`. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare === "::1") return true;
  const parts = bare.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** `0.0.0.0` or `::`: listens everywhere, so the address says nothing about what clients will call it. */
export function isWildcardHost(host: string): boolean {
  const bare = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "0.0.0.0" || bare === "::" || bare === "0:0:0:0:0:0:0:0";
}

/** Bare host names and IPs only, lowercased; IPv6 comes back bracketed as it appears in a Host header. */
export function parseAllowedHosts(raw: string | string[] | undefined): string[] {
  const entries = Array.isArray(raw) ? raw : (raw ?? "").split(",");
  const names = new Set<string>();
  for (const entry of entries) {
    const bare = entry.trim().replace(/^\[|\]$/g, "").toLowerCase();
    if (!bare) continue;
    const ipv6 = isIPv6(bare);
    if (!ipv6 && !/^[a-z0-9._-]+$/.test(bare)) {
      throw new Error(`BRIDGE_ALLOWED_HOSTS entries must be bare host names or IP addresses without a port or scheme; got "${entry.trim()}".`);
    }
    names.add(ipv6 ? `[${bare}]` : bare);
  }
  return [...names];
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // mkdir mode is filtered by umask. chmod makes the directory actually 0700.
  chmodSync(path, 0o700);
}

export function loadConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const dataDir = resolve(overrides.dataDir ?? env("BRIDGE_DATA_DIR", resolve(process.cwd(), "tmp/bridge-data"))!);
  ensurePrivateDir(dataDir);
  const logDir = resolve(dataDir, "logs");
  ensurePrivateDir(logDir);
  mkdirSync(resolve(dataDir, "sessions"), { recursive: true });
  mkdirSync(resolve(dataDir, "sandbox"), { recursive: true });

  const mode = (overrides.mode ?? env("BRIDGE_MODE", "mock")) as BridgeMode;
  if (!["mock", "fake", "sdk"].includes(mode)) {
    throw new Error(`Invalid BRIDGE_MODE=${mode}. Use mock | fake | sdk.`);
  }
  const authMode = parseAuthMode(overrides.authMode ?? env("BRIDGE_AUTH", "byok"));
  const host = overrides.host ?? env("BRIDGE_HOST", "127.0.0.1")!;
  const allowRemote = overrides.allowRemote ?? env("BRIDGE_ALLOW_REMOTE") === "1";
  const allowedHosts = parseAllowedHosts(overrides.allowedHosts ?? env("BRIDGE_ALLOWED_HOSTS"));
  if (!isLoopbackHost(host)) {
    if (authMode === "subscription") {
      throw new Error("exposing a Claude subscription to other machines/people is not permitted");
    }
    if (!allowRemote) {
      throw new Error(`Refusing to listen on ${host} without BRIDGE_ALLOW_REMOTE=1.`);
    }
    // Remote clients send the LAN IP or name they dialed, never the wildcard
    // address, so without their names every request would fail the Host check.
    if (isWildcardHost(host) && allowedHosts.length === 0) {
      throw new Error(`BRIDGE_HOST=${host} listens on every interface, so the Host header remote clients send is not known. Set BRIDGE_ALLOWED_HOSTS to the comma-separated names or IPs they will use, for example 192.168.1.20,devbox.local.`);
    }
  }
  const clientToken = overrides.clientToken ?? env("BRIDGE_CLIENT_TOKEN", randomBytes(24).toString("hex"))!;
  const adminToken = overrides.adminToken ?? env("BRIDGE_ADMIN_TOKEN", randomBytes(24).toString("hex"))!;
  const hookToken = overrides.hookToken ?? env("BRIDGE_HOOK_TOKEN", randomBytes(24).toString("hex"))!;
  if (adminToken === clientToken || hookToken === adminToken || hookToken === clientToken) {
    throw new Error("BRIDGE_CLIENT_TOKEN, BRIDGE_ADMIN_TOKEN and BRIDGE_HOOK_TOKEN must be different.");
  }
  const permissionRaw = overrides.permissionMode ?? env("BRIDGE_PERMISSION");
  const permissionMode = (permissionRaw === "ask" || permissionRaw === "bypass"
    ? permissionRaw
    : "ask") as "bypass" | "ask";

  return {
    host,
    port: overrides.port ?? intEnv("BRIDGE_PORT", 18787),
    mode,
    clientToken,
    adminToken,
    hookToken,
    allowRemote,
    allowedHosts,
    dataDir,
    logDir,
    sandboxDir: resolve(dataDir, "sandbox"),
    maxBodyBytes: overrides.maxBodyBytes ?? intEnv("BRIDGE_MAX_BODY_BYTES", 8 * 1024 * 1024),
    maxSessions: overrides.maxSessions ?? intEnv("BRIDGE_MAX_SESSIONS", 16),
    maxTurns: overrides.maxTurns ?? intEnv("BRIDGE_MAX_TURNS", 64),
    toolWaitMs: overrides.toolWaitMs ?? intEnv("BRIDGE_TOOL_WAIT_MS", 8 * 60 * 60 * 1000),
    toolWaitTimeoutMs: overrides.toolWaitTimeoutMs ?? intEnv("BRIDGE_TOOL_WAIT_TIMEOUT_MS", 30 * 60 * 1000),
    requestTimeoutMs: overrides.requestTimeoutMs ?? intEnv("BRIDGE_REQUEST_TIMEOUT_MS", 10 * 60 * 1000),
    approvalTimeoutMs: overrides.approvalTimeoutMs ?? intEnv("BRIDGE_APPROVAL_TIMEOUT_MS", 30 * 60 * 1000),
    turnMaxMs: overrides.turnMaxMs ?? intEnv("BRIDGE_TURN_MAX_MS", 2 * 60 * 60 * 1000),
    claudeExecutable: overrides.claudeExecutable ?? env("BRIDGE_CLAUDE_EXECUTABLE"),
    sdkCwd: canonicalWorkspacePath(overrides.sdkCwd ?? env("BRIDGE_SDK_CWD", resolve(dataDir, "sandbox"))!),
    persistSessions: overrides.persistSessions ?? env("BRIDGE_PERSIST", "1") !== "0",
    logBodies: overrides.logBodies ?? env("BRIDGE_LOG_BODIES") === "1",
    authMode,
    permissionMode,
    upstreamBaseUrl: overrides.upstreamBaseUrl ?? env("BRIDGE_UPSTREAM_BASE_URL"),
    upstreamModel: overrides.upstreamModel ?? env("BRIDGE_UPSTREAM_MODEL"),
    upstreamTokenEnv: overrides.upstreamTokenEnv ?? env("BRIDGE_UPSTREAM_TOKEN_ENV"),
    models: overrides.models !== undefined ? validateModels(overrides.models)
      : env("BRIDGE_MODELS") ? modelsFromIds(parseModelIds(env("BRIDGE_MODELS")!), authMode) : undefined,
  };
}
