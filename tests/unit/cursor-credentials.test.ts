import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialFileMode, cursorApiKey, cursorCredentialPath, cursorCredentialStatus, cursorExpiryWarning, formatCursorStatus, loginCursor, readCursorCredential, type CursorCredentialStatus } from "../../src/runtime/cursor/credentials.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "cursor-auth-")); dirs.push(dir); return dir; };

describe("Cursor credentials", () => {
  it("writes a private file, treats expiry as logged out, and accepts CURSOR_API_KEY", async () => {
    const dir = directory();
    const key = "cursor-test-key-not-for-status";
    const urls: string[] = [];
    const status = await loginCursor(dir, async ({ onLoginUrl }) => {
      onLoginUrl("https://cursor.test/login/one");
      return { apiKey: key, email: "person@example.com", apiKeyExpiresAtMs: 2_000 };
    }, (url) => urls.push(url), 1_000);
    expect(urls).toEqual(["https://cursor.test/login/one"]);
    expect(credentialFileMode(dir)).toBe(0o600);
    expect(readCursorCredential(dir)?.apiKey).toBe(key);
    expect(formatCursorStatus(status, 1_000)).toBe("logged_in: true\nexpired: false\nexpires: 1970-01-01T00:00:02.000Z\naccount: present\nwarning: Cursor key expires within 7 days. Run npm run desktop -- cursor login.\n");
    expect(formatCursorStatus(status, 1_000)).not.toContain(key);
    expect(cursorApiKey(dir, {}, 1_500)).toBe(key);
    expect(cursorCredentialStatus(dir, {}, 2_000)).toMatchObject({ loggedIn: false, expired: true, source: "none" });
    expect(cursorApiKey(dir, {}, 2_000)).toBeUndefined();
    const fromEnv = cursorCredentialStatus(dir, { CURSOR_API_KEY: key }, 2_000);
    expect(fromEnv).toMatchObject({ source: "env", loggedIn: true });
    expect(formatCursorStatus(fromEnv)).not.toContain(key);
    expect(cursorApiKey(dir, { CURSOR_API_KEY: "env-key" }, 2_000)).toBe("env-key");
    expect(readFileSync(cursorCredentialPath(dir), "utf8")).toContain(key);
  });

  it("warns at seven days and stays quiet one millisecond later", () => {
    const now = 1_000_000;
    const week = 7 * 24 * 60 * 60 * 1000;
    const status = (expiresAt: number): CursorCredentialStatus => ({ source: "file", loggedIn: true, expired: expiresAt <= now, accountPresent: true, expiresAt: new Date(expiresAt).toISOString() });
    expect(cursorExpiryWarning(status(now + week), now)).toMatch(/npm run desktop -- cursor login/);
    expect(formatCursorStatus(status(now + week), now)).toContain("warning: Cursor key expires within 7 days.");
    expect(cursorExpiryWarning(status(now + week + 1), now)).toBeUndefined();
    expect(formatCursorStatus(status(now + week + 1), now)).not.toContain("warning:");
    expect(formatCursorStatus(status(now - 1), now)).toContain("warning: Cursor key expires within 7 days.");
  });
});
