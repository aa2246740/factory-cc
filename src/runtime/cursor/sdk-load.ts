import { createRequire } from "node:module";
import { hostname } from "node:os";
import { join } from "node:path";
import type { CursorAgentApi } from "./agent-api.js";
import { cursorCredentialPath, type CursorLogin } from "./credentials.js";

export interface CursorCredentialStore {
  load(): Promise<unknown>;
  save(credentials: unknown): Promise<void>;
  clear(): Promise<void>;
}

/** The slice of `@cursor/sdk` the desktop CLI calls. Tests inject this instead of loading the package. */
export interface CursorPlatformModule {
  Cursor: {
    auth: {
      login(options?: {
        openBrowser?: boolean | ((url: string) => void | Promise<void>);
        onLoginUrl?: (url: string) => void;
        store?: CursorCredentialStore | null;
        apiKeyName?: string;
        apiKeyTtlMs?: number;
      }): Promise<{ apiKey: string; email?: string; apiKeyExpiresAtMs?: number }>;
    };
    models: {
      list(options?: { apiKey?: string }): Promise<unknown>;
    };
  };
  FileCredentialStore: new (filePath?: string) => CursorCredentialStore;
  DEFAULT_LOGIN_API_KEY_TTL_MS: number;
}

const guarded = new WeakSet<object>();

/**
 * One process-wide listener. Sandbox helper spawn failures are ignored.
 * Any other rejection is rethrown so this listener does not swallow it.
 */
export function installCursorRejectionGuard(target: { on(event: string, listener: (reason: unknown) => void): void } = process): void {
  if (guarded.has(target)) return;
  guarded.add(target);
  target.on("unhandledRejection", (reason) => {
    const text = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
    if (/dump_zsh_state|dump_bash_state|__CURSOR_SANDBOX_ENV_RESTORE/.test(text)) return;
    throw reason instanceof Error ? reason : new Error(text);
  });
}

/** Opened only for a real SDK agent. Rooted in the bridge data dir, not the project cwd. */
export interface CursorAgentStore {
  dispose?: () => Promise<void>;
  agents?: { delete(input: { filter: { agentIds: [string] } }): Promise<void> };
}

export async function openCursorAgentStore(dataDir: string, workspaceRef: string): Promise<CursorAgentStore> {
  const require = createRequire(import.meta.url);
  const sqlite = require("@cursor/sdk/sqlite") as { SqliteLocalAgentStore: { open(options: { workspaceRef: string; stateRoot?: string }): Promise<CursorAgentStore> } };
  return sqlite.SqliteLocalAgentStore.open({ workspaceRef, stateRoot: join(dataDir, "cursor-agent-store") });
}

/** Lazy require so unit tests never load `@cursor/sdk`. */
export function loadCursorSdk(): { Agent: CursorAgentApi } & CursorPlatformModule {
  installCursorRejectionGuard();
  const require = createRequire(import.meta.url);
  return require("@cursor/sdk") as { Agent: CursorAgentApi } & CursorPlatformModule;
}

/**
 * Mint a key with `Cursor.auth.login` and persist it under the bridge data dir.
 * The store path is `cursor-auth.json` there, never `~/.cursor/sdk/auth.json`.
 * `apiKeyTtlMs` is the SDK default (90 days). The SDK opens the browser when that is likely to work
 * (not over SSH or with NO_OPEN_BROWSER); the caller also prints the URL.
 */
export function cursorLoginFromSdk(dataDir: string, sdk: CursorPlatformModule, host = hostname()): CursorLogin {
  return async ({ onLoginUrl }) => {
    const store = new sdk.FileCredentialStore(cursorCredentialPath(dataDir));
    const result = await sdk.Cursor.auth.login({
      openBrowser: true,
      onLoginUrl,
      store,
      apiKeyName: `factory-cc (${host})`,
      apiKeyTtlMs: sdk.DEFAULT_LOGIN_API_KEY_TTL_MS,
    });
    return { apiKey: result.apiKey, email: result.email, apiKeyExpiresAtMs: result.apiKeyExpiresAtMs };
  };
}
