import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { modelSlots, sdkEnv } from "../../src/upstream/providers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("BRIDGE_AUTH", () => {
  it("BYOK authentication never implicitly grants bypass permissions", () => {
    vi.stubEnv("BRIDGE_PERMISSION", "");
    try {
      const dataDir = mkdtempSync(join(tmpdir(), "relay-auth-permissions-"));
      expect(loadConfig({ dataDir, authMode: "byok" }).permissionMode).toBe("ask");
      expect(loadConfig({ dataDir, authMode: "byok", permissionMode: "bypass" }).permissionMode).toBe("bypass");
    } finally { vi.unstubAllEnvs(); }
  });
  it("subscription does not override ANTHROPIC_BASE_URL / AUTH_TOKEN / API_KEY", () => {
    const previous = {
      base: process.env.ANTHROPIC_BASE_URL,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
      key: process.env.ANTHROPIC_API_KEY,
      minimax: process.env.MINIMAXCN_API_KEY,
    };
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
    process.env.ANTHROPIC_AUTH_TOKEN = "local-subscription-token-placeholder";
    process.env.ANTHROPIC_API_KEY = "local-api-key-placeholder";
    process.env.MINIMAXCN_API_KEY = "minimax-should-not-be-copied";

    const env = sdkEnv(undefined, "127.0.0.1:18787", "subscription");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("local-subscription-token-placeholder");
    expect(env.ANTHROPIC_API_KEY).toBe("local-api-key-placeholder");
    expect(env.ANTHROPIC_MODEL).toBe(process.env.ANTHROPIC_MODEL);

    restore(previous);
  });

  it("byok still injects the MiniMax slot and empties API_KEY", () => {
    const previous = process.env.MINIMAXCN_API_KEY;
    process.env.MINIMAXCN_API_KEY = "test-minimax-token-not-real";
    const selection = {
      provider: {
        id: "minimax" as const,
        label: "test",
        baseUrl: "https://api.minimaxi.com/anthropic",
        model: "MiniMax-M2.5",
        tokenEnv: "MINIMAXCN_API_KEY",
        authHeader: "authorization" as const,
      },
      modelSlots: modelSlots("MiniMax-M2.5"),
    };
    const env = sdkEnv(selection, "127.0.0.1:18787", "byok");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimaxi.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-minimax-token-not-real");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    if (previous === undefined) delete process.env.MINIMAXCN_API_KEY;
    else process.env.MINIMAXCN_API_KEY = previous;
  });

  it("loadConfig maps BRIDGE_AUTH=subscription to ask permissions by default", () => {
    const previous = process.env.BRIDGE_AUTH;
    process.env.BRIDGE_AUTH = "subscription";
    const config = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "relay-auth-")) });
    expect(config.authMode).toBe("subscription");
    expect(config.permissionMode).toBe("ask");
    if (previous === undefined) delete process.env.BRIDGE_AUTH;
    else process.env.BRIDGE_AUTH = previous;
  });
});

function restore(previous: { base?: string; token?: string; key?: string; minimax?: string }): void {
  setOrDelete("ANTHROPIC_BASE_URL", previous.base);
  setOrDelete("ANTHROPIC_AUTH_TOKEN", previous.token);
  setOrDelete("ANTHROPIC_API_KEY", previous.key);
  setOrDelete("MINIMAXCN_API_KEY", previous.minimax);
}

function setOrDelete(name: string, value?: string): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
