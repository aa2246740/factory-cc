import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "relay-token-")); roots.push(root); return root; }
it("loads client/admin/hook token files and never enables bypass in desktop profile", () => {
  const root = fixture();
  for (const name of ["CLIENT", "ADMIN", "HOOK"]) {
    vi.stubEnv(`BRIDGE_${name}_TOKEN`, "");
    const file = join(root, name); writeFileSync(file, `fixture-${name}\n`);
    vi.stubEnv(`BRIDGE_${name}_TOKEN_FILE`, file);
  }
  const config = loadConfig({ dataDir: join(root, "data"), authMode: "byok", desktopProfile: true });
  expect(config).toMatchObject({ clientToken: "fixture-CLIENT", adminToken: "fixture-ADMIN", hookToken: "fixture-HOOK", permissionMode: "ask", desktopProfile: true });
  expect(() => loadConfig({ dataDir: join(root, "data"), authMode: "byok", desktopProfile: true, permissionMode: "bypass" })).toThrow("requires ask");
});
it("rejects ambiguous token/file credentials and empty files", () => {
  const root = fixture(), file = join(root, "token"); writeFileSync(file, "\n");
  vi.stubEnv("BRIDGE_CLIENT_TOKEN", ""); vi.stubEnv("BRIDGE_CLIENT_TOKEN_FILE", file);
  expect(() => loadConfig({ dataDir: join(root, "data"), authMode: "byok" })).toThrow("nonempty token");
  vi.stubEnv("BRIDGE_CLIENT_TOKEN", "fixture");
  expect(() => loadConfig({ dataDir: join(root, "data"), authMode: "byok" })).toThrow("cannot both be set");
});
