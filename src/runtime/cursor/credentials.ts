import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Bridge-owned Cursor credential. Never `~/.cursor` and never a LaunchAgent value. */
export interface CursorCredential {
  version: 1;
  apiKey: string;
  createdAtMs: number;
  apiKeyExpiresAtMs?: number;
  email?: string;
}

export interface CursorCredentialStatus {
  source: "env" | "file" | "none";
  loggedIn: boolean;
  expired: boolean;
  expiresAt?: string;
  accountPresent: boolean;
}

export interface CursorLoginResult {
  apiKey: string;
  email?: string;
  apiKeyExpiresAtMs?: number;
}

/** Injectable login. Tests pass this or a fake SDK module; production calls `Cursor.auth.login()`. */
export type CursorLogin = (options: { onLoginUrl: (url: string) => void }) => Promise<CursorLoginResult>;

export const CURSOR_LOGIN_COMMAND = "npm run desktop -- cursor login";
const CURSOR_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/** Droid-visible and CLI text. The key itself is never included. */
export function cursorReauthMessage(reason: string): string {
  const text = reason.trim();
  if (text.includes(CURSOR_LOGIN_COMMAND)) return text;
  return `${text} Run ${CURSOR_LOGIN_COMMAND}.`;
}

export function cursorCredentialPath(dataDir: string): string {
  return join(dataDir, "cursor-auth.json");
}

export function readCursorCredential(dataDir: string, readOnlyFile = cursorCredentialPath(dataDir)): CursorCredential | undefined {
  try {
    const parsed = JSON.parse(readFileSync(readOnlyFile, "utf8")) as Partial<CursorCredential>;
    if (parsed?.version !== 1 || typeof parsed.apiKey !== "string" || !parsed.apiKey || typeof parsed.createdAtMs !== "number") return undefined;
    return {
      version: 1,
      apiKey: parsed.apiKey,
      createdAtMs: parsed.createdAtMs,
      ...(typeof parsed.apiKeyExpiresAtMs === "number" ? { apiKeyExpiresAtMs: parsed.apiKeyExpiresAtMs } : {}),
      ...(typeof parsed.email === "string" && parsed.email ? { email: parsed.email } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeCursorCredential(dataDir: string, credential: CursorCredential): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const path = cursorCredentialPath(dataDir);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(credential)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function expired(credential: CursorCredential | undefined, now: number): boolean {
  return Boolean(credential?.apiKeyExpiresAtMs !== undefined && credential.apiKeyExpiresAtMs <= now);
}

/** An env key is used as-is. Only a stored file can be known expired before the request. */
export function cursorStoredKeyExpired(dataDir: string, env: NodeJS.ProcessEnv, now = Date.now()): boolean {
  if (env.CURSOR_API_KEY?.trim()) return false;
  return expired(readCursorCredential(dataDir, env.BRIDGE_CURSOR_AUTH_FILE), now);
}

export function cursorExpiryWarning(status: CursorCredentialStatus, now = Date.now()): string | undefined {
  if (!status.expiresAt) return undefined;
  const remaining = Date.parse(status.expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining > CURSOR_EXPIRY_WARNING_MS) return undefined;
  return cursorReauthMessage("Cursor key expires within 7 days.");
}

/** Env wins. An expired file is not a login. The returned key is for the SDK, never for status text. */
export function cursorApiKey(dataDir: string, env: NodeJS.ProcessEnv, now = Date.now()): string | undefined {
  const fromEnv = env.CURSOR_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const stored = readCursorCredential(dataDir, env.BRIDGE_CURSOR_AUTH_FILE);
  if (!stored || expired(stored, now)) return undefined;
  return stored.apiKey;
}

export function cursorCredentialStatus(dataDir: string, env: NodeJS.ProcessEnv, now = Date.now()): CursorCredentialStatus {
  const stored = readCursorCredential(dataDir, env.BRIDGE_CURSOR_AUTH_FILE);
  const fileExpired = expired(stored, now);
  if (env.CURSOR_API_KEY?.trim()) {
    return { source: "env", loggedIn: true, expired: false, accountPresent: Boolean(stored?.email) && !fileExpired, ...(stored?.apiKeyExpiresAtMs && !fileExpired ? { expiresAt: new Date(stored.apiKeyExpiresAtMs).toISOString() } : {}) };
  }
  if (stored && !fileExpired) {
    return { source: "file", loggedIn: true, expired: false, accountPresent: Boolean(stored.email), ...(stored.apiKeyExpiresAtMs ? { expiresAt: new Date(stored.apiKeyExpiresAtMs).toISOString() } : {}) };
  }
  return { source: "none", loggedIn: false, expired: fileExpired, accountPresent: Boolean(stored?.email), ...(stored?.apiKeyExpiresAtMs ? { expiresAt: new Date(stored.apiKeyExpiresAtMs).toISOString() } : {}) };
}

/** Expiry and whether an account is present. The key is never included. */
export function formatCursorStatus(status: CursorCredentialStatus, now = Date.now()): string {
  const expires = status.expiresAt ?? (status.source === "env" ? "unknown" : "none");
  const warning = cursorExpiryWarning(status, now);
  return `logged_in: ${status.loggedIn}\nexpired: ${status.expired}\nexpires: ${expires}\naccount: ${status.accountPresent ? "present" : "absent"}\n${warning ? `warning: ${warning}\n` : ""}`;
}

export async function loginCursor(dataDir: string, login: CursorLogin, onLoginUrl: (url: string) => void, now = Date.now()): Promise<CursorCredentialStatus> {
  const result = await login({ onLoginUrl });
  if (!result.apiKey || /\s/.test(result.apiKey)) throw new Error("Cursor login did not return a key.");
  writeCursorCredential(dataDir, {
    version: 1,
    apiKey: result.apiKey,
    createdAtMs: now,
    ...(result.apiKeyExpiresAtMs !== undefined ? { apiKeyExpiresAtMs: result.apiKeyExpiresAtMs } : {}),
    ...(result.email ? { email: result.email } : {}),
  });
  return cursorCredentialStatus(dataDir, {}, now);
}

export function credentialFileMode(dataDir: string): number | undefined {
  try {
    return statSync(cursorCredentialPath(dataDir)).mode & 0o777;
  } catch {
    return undefined;
  }
}
