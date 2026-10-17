import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";

const directories: string[] = [];
const tokens = { clientToken: "client-token", adminToken: "admin-token", hookToken: "hook-token" };
function load(overrides: Parameters<typeof loadConfig>[0] = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-timeouts-"));
  directories.push(dataDir);
  return loadConfig({ dataDir, ...tokens, ...overrides });
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("timeout settings", () => {
  it("expires an abandoned Droid tool wait after 30 minutes unless configured", () => {
    expect(load().toolWaitTimeoutMs).toBe(30 * 60 * 1000);
    vi.stubEnv("BRIDGE_TOOL_WAIT_TIMEOUT_MS", "90000");
    expect(load().toolWaitTimeoutMs).toBe(90_000);
    expect(load({ toolWaitTimeoutMs: 5 }).toolWaitTimeoutMs).toBe(5);
    vi.stubEnv("BRIDGE_TOOL_WAIT_TIMEOUT_MS", "soon");
    expect(load().toolWaitTimeoutMs).toBe(30 * 60 * 1000);
  });
});
