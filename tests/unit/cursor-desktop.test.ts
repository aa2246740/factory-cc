import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { cursorCatalogFixture } from "../../src/runtime/cursor/fixture.js";
import { writeCursorCredential } from "../../src/runtime/cursor/credentials.js";
import type { CursorPlatformModule } from "../../src/runtime/cursor/sdk-load.js";
import { desktop, desktopPaths, isDesktopHealthPayload, type DesktopDependencies } from "../../scripts/desktop.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cursor-desktop-"));
  roots.push(root);
  const home = join(root, "home"), repo = join(root, "repo"), node = join(root, "node");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(repo, "dist"), { recursive: true });
  writeFileSync(join(repo, "dist/index.js"), "");
  writeFileSync(node, "");
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "fixture-sonnet" } }));
  const run = vi.fn<DesktopDependencies["run"]>(() => ({ status: 0 }));
  const deps: DesktopDependencies = {
    home, repo, node, path: "/usr/bin", uid: 501, platform: "darwin", run,
    assertPortFree: vi.fn(async () => {}), health: vi.fn(async () => true), sleep: vi.fn(async () => {}),
    env: { CURSOR_API_KEY: "super-secret-cursor-key" }, cursorCatalog: cursorCatalogFixture,
  };
  return { deps, paths: desktopPaths(home), run, root };
}

it("installs Claude and the two default Cursor labels without putting a key in the plist", async () => {
  const { deps, paths } = fixture();
  await desktop(["install", "--cursor-models", "default"], deps);
  const plist = readFileSync(paths.plist, "utf8");
  expect(plist).toContain("BRIDGE_AUTH");
  expect(plist).toContain("claude-config");
  expect(plist).toContain("BRIDGE_CURSOR_MODELS_FILE");
  expect(plist).toContain(paths.cursorMenu);
  expect(plist).not.toContain("super-secret-cursor-key");
  expect(plist).not.toContain("CURSOR_API_KEY");
  const settings = JSON.parse(readFileSync(paths.settings, "utf8"));
  const labels = settings.customModels.map((model: { displayName: string }) => model.displayName);
  expect(labels.some((label: string) => label.startsWith("Claude Code ·"))).toBe(true);
  expect(labels).toEqual(expect.arrayContaining(["Cursor · Composer 2.5", "Cursor · Grok 4.7"]));
  expect(isDesktopHealthPayload({ ok: true, mode: "sdk" })).toBe(true);
  expect(isDesktopHealthPayload({ ok: true, mode: "cursor" })).toBe(false);
  const menu = JSON.parse(readFileSync(paths.cursorMenu, "utf8"));
  expect(menu.map((model: { id: string }) => model.id)).toEqual(["cursor:composer-2.5", "cursor:grok-4.7"]);
  vi.stubEnv("BRIDGE_CURSOR_MODELS_FILE", paths.cursorMenu);
  vi.stubEnv("BRIDGE_MODELS", "");
  vi.stubEnv("BRIDGE_AUTH", "subscription");
  const loaded = loadConfig({ dataDir: join(deps.home, "bridge-load"), authMode: "subscription", mode: "mock" });
  expect(loaded.models?.map((model) => model.displayName)).toEqual(["Cursor · Composer 2.5", "Cursor · Grok 4.7"]);
});

it("refuses an unknown Cursor id before bootout", async () => {
  const { deps, run } = fixture();
  await desktop(["install"], deps);
  run.mockClear();
  await expect(desktop(["restart", "--cursor-models", "no-such-model"], deps)).rejects.toThrow(/no model/);
  expect(run.mock.calls.some((call) => call[0] === "launchctl" && call[1][0] === "bootout")).toBe(false);
});

it("refuses --cursor-models before bootout when Cursor is not logged in", async () => {
  const { deps, paths, run } = fixture();
  deps.env = {};
  delete deps.cursorCatalog;
  await desktop(["install"], deps);
  run.mockClear();
  await expect(desktop(["restart", "--cursor-models", "default"], deps)).rejects.toThrow(/npm run desktop -- cursor login/);
  expect(run.mock.calls.some((call) => call[0] === "launchctl" && call[1][0] === "bootout")).toBe(false);
  expect(existsSync(paths.plist)).toBe(true);
  expect(readFileSync(paths.plist, "utf8")).not.toContain("BRIDGE_CURSOR_MODELS_FILE");
});

it("prints Cursor status and login without the key, and lists a cached catalog", async () => {
  const { deps, paths } = fixture();
  const lines: string[] = [];
  deps.stdout = (text) => lines.push(text);
  const fromEnv = await desktop(["cursor", "status"], deps);
  expect(fromEnv.text).toContain("logged_in: true");
  expect(fromEnv.text).toContain("account:");
  expect(JSON.stringify(fromEnv)).not.toContain("super-secret-cursor-key");
  const loggedIn = await desktop(["cursor", "login"], { ...deps, cursorLogin: async ({ onLoginUrl }) => { onLoginUrl("https://cursor.test/login"); return { apiKey: "super-secret-cursor-key", email: "person@example.com", apiKeyExpiresAtMs: 5_000 }; }, now: () => 1_000 });
  expect(loggedIn.loginUrl).toBe("https://cursor.test/login");
  expect(JSON.stringify(loggedIn)).not.toContain("super-secret-cursor-key");
  expect(statSync(join(paths.data, "cursor-auth.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(paths.data, "cursor-auth.json"), "utf8")).toContain("super-secret-cursor-key");
  const listed = await desktop(["cursor", "models", "grok-4.7"], deps);
  expect(listed.text).toContain("grok-4.7");
  expect(listed.text).not.toContain("composer-2.5");
  expect(JSON.stringify(listed)).not.toMatch(/prompt|send\(/);
});

function platform(login: CursorPlatformModule["Cursor"]["auth"]["login"], list: CursorPlatformModule["Cursor"]["models"]["list"], store?: CursorPlatformModule["FileCredentialStore"]): CursorPlatformModule {
  class MemoryStore { async load() { return undefined; } async save() {} async clear() {} }
  return {
    Cursor: { auth: { login }, models: { list } },
    FileCredentialStore: store ?? MemoryStore,
    DEFAULT_LOGIN_API_KEY_TTL_MS: 7_776_000_000,
  };
}

it("wires cursor login through an injected SDK store in the bridge data dir", async () => {
  const { deps, paths } = fixture();
  deps.env = {};
  const constructed: Array<string | undefined> = [];
  const seen: Array<{ openBrowser?: unknown; apiKeyName?: string; apiKeyTtlMs?: number; store?: { save(value: unknown): Promise<void> } | null; onLoginUrl?: (url: string) => void }> = [];
  class Store {
    constructor(path?: string) { constructed.push(path); }
    async load() { return undefined; }
    async save() {}
    async clear() {}
  }
  deps.cursorSdk = platform(async (options) => {
    seen.push(options ?? {});
    options?.onLoginUrl?.("https://cursor.test/device");
    await options?.store?.save({ version: 1, apiKey: "minted-cursor-key" });
    return { apiKey: "minted-cursor-key", email: "person@example.com", apiKeyExpiresAtMs: 5_000 };
  }, async () => { throw new Error("catalog is not part of login"); }, Store);
  deps.now = () => 1_000;
  const lines: string[] = [];
  deps.stdout = (text) => lines.push(text);
  const loggedIn = await desktop(["cursor", "login"], deps);
  expect(seen[0]).toMatchObject({ openBrowser: false, apiKeyName: `factory-cc (${hostname()})`, apiKeyTtlMs: 7_776_000_000 });
  expect(constructed).toEqual([join(paths.data, "cursor-auth.json")]);
  expect(constructed[0]).not.toContain(".cursor/sdk");
  expect(lines.join("")).toContain("https://cursor.test/device");
  expect(lines.join("")).not.toContain("minted-cursor-key");
  expect(JSON.stringify(loggedIn)).not.toContain("minted-cursor-key");
  expect(statSync(join(paths.data, "cursor-auth.json")).mode & 0o777).toBe(0o600);
  const installed = await desktop(["install", "--cursor-models", "default"], deps);
  expect(installed.installed).toBe(true);
  expect(readFileSync(paths.plist, "utf8")).not.toContain("minted-cursor-key");
});

it("fetches the catalog into a private cache and builds the default menu", async () => {
  const { deps, paths } = fixture();
  delete deps.cursorCatalog;
  const listed: Array<string | undefined> = [];
  deps.cursorSdk = platform(async () => { throw new Error("no login"); }, async (options) => {
    listed.push(options?.apiKey);
    return cursorCatalogFixture;
  });
  const installed = await desktop(["install", "--cursor-models", "default"], deps);
  expect(listed).toEqual(["super-secret-cursor-key"]);
  expect(installed.warning).toBeUndefined();
  expect(statSync(paths.cursorCatalog).mode & 0o777).toBe(0o600);
  expect(readFileSync(paths.cursorCatalog, "utf8")).not.toContain("super-secret-cursor-key");
  expect(JSON.parse(readFileSync(paths.cursorMenu, "utf8")).map((model: { id: string }) => model.id)).toEqual(["cursor:composer-2.5", "cursor:grok-4.7"]);
  const lines: string[] = [];
  deps.stdout = (text) => lines.push(text);
  const models = await desktop(["cursor", "models", "composer"], deps);
  expect(models.text).toContain("composer-2.5");
  expect(models.text).not.toContain("grok-4.7");
  expect(lines.join("")).not.toContain("super-secret-cursor-key");
  expect(statSync(paths.cursorCatalog).mode & 0o777).toBe(0o600);
});

it("keeps the Claude menu when Cursor is not logged in", async () => {
  const { deps, paths } = fixture();
  deps.env = {};
  delete deps.cursorCatalog;
  const installed = await desktop(["install"], deps);
  expect(installed.warning).toMatch(/no Cursor entries/);
  expect(installed.warning).toMatch(/npm run desktop -- cursor login/);
  const labels = JSON.parse(readFileSync(paths.settings, "utf8")).customModels.map((model: { displayName: string }) => model.displayName);
  expect(labels.some((label: string) => label.startsWith("Claude Code ·"))).toBe(true);
  expect(labels.some((label: string) => label.startsWith("Cursor ·"))).toBe(false);
  expect(readFileSync(paths.plist, "utf8")).not.toContain("BRIDGE_CURSOR_MODELS_FILE");
  const restarted = await desktop(["restart"], deps);
  expect(restarted.warning).toMatch(/no Cursor entries/);
  const again = JSON.parse(readFileSync(paths.settings, "utf8")).customModels.map((model: { displayName: string }) => model.displayName);
  expect(again.some((label: string) => label.startsWith("Claude Code ·"))).toBe(true);
  expect(again.some((label: string) => label.startsWith("Cursor ·"))).toBe(false);
  await expect(desktop(["cursor", "models"], deps)).rejects.toThrow(/npm run desktop -- cursor login first/);
});

it("warns on status and cursor status when the key expires within 7 days", async () => {
  const { deps, paths } = fixture();
  deps.env = {};
  delete deps.cursorCatalog;
  await desktop(["install"], deps);
  const now = Date.parse("2026-10-20T00:00:00.000Z");
  writeCursorCredential(paths.data, { version: 1, apiKey: "status-only-key", createdAtMs: now, apiKeyExpiresAtMs: now + 3 * 24 * 60 * 60 * 1000, email: "person@example.com" });
  deps.now = () => now;
  const status = await desktop(["status"], deps);
  expect(status.cursor).toMatchObject({ loggedIn: true, expired: false, expires: "2026-10-23T00:00:00.000Z", account: "present" });
  expect(status.cursorWarning).toMatch(/7 days/);
  expect(status.cursorWarning).toMatch(/npm run desktop -- cursor login/);
  expect(JSON.stringify(status)).not.toContain("status-only-key");
  const lines: string[] = [];
  deps.stdout = (text) => lines.push(text);
  const cursor = await desktop(["cursor", "status"], deps);
  expect(cursor.text).toContain("expires: 2026-10-23T00:00:00.000Z");
  expect(cursor.text).toContain("warning: Cursor key expires within 7 days.");
  expect(lines.join("")).not.toContain("status-only-key");
});
