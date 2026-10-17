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
  it("defaults to a 10 minute idle limit, a 30 minute approval limit and a 2 hour turn cap", () => {
    expect(load()).toMatchObject({ requestTimeoutMs: 10 * 60 * 1000, approvalTimeoutMs: 30 * 60 * 1000, turnMaxMs: 2 * 60 * 60 * 1000 });
  });

  it("reads them from the environment, keeping BRIDGE_REQUEST_TIMEOUT_MS as the idle limit", () => {
    vi.stubEnv("BRIDGE_REQUEST_TIMEOUT_MS", "120000");
    vi.stubEnv("BRIDGE_APPROVAL_TIMEOUT_MS", "900000");
    vi.stubEnv("BRIDGE_TURN_MAX_MS", "5400000");
    expect(load()).toMatchObject({ requestTimeoutMs: 120_000, approvalTimeoutMs: 900_000, turnMaxMs: 5_400_000 });
    expect(load({ requestTimeoutMs: 1, approvalTimeoutMs: 2, turnMaxMs: 3 })).toMatchObject({ requestTimeoutMs: 1, approvalTimeoutMs: 2, turnMaxMs: 3 });
  });

  it("lets a parked session be reclaimed after 30 idle minutes unless configured", () => {
    expect(load().toolWaitTimeoutMs).toBe(30 * 60 * 1000);
    vi.stubEnv("BRIDGE_TOOL_WAIT_TIMEOUT_MS", "90000");
    expect(load().toolWaitTimeoutMs).toBe(90_000);
    expect(load({ toolWaitTimeoutMs: 5 }).toolWaitTimeoutMs).toBe(5);
    vi.stubEnv("BRIDGE_TOOL_WAIT_TIMEOUT_MS", "soon");
    expect(load().toolWaitTimeoutMs).toBe(30 * 60 * 1000);
  });
});
