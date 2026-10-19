import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { buildChildEnv } from "../../src/upstream/auth-env.js";
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
  it("subscription refuses API credentials instead of copying them", () => {
    const source = {
      PATH: "/usr/bin", HOME: "/tmp/home",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_AUTH_TOKEN: "local-subscription-token-placeholder",
      ANTHROPIC_API_KEY: "local-api-key-placeholder",
      MINIMAXCN_API_KEY: "minimax-should-not-be-copied",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-may-pass",
    };
    let error: unknown;
    try { buildChildEnv("subscription", source, undefined, { bridgeListen: "127.0.0.1:18787" }); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "auth_env_rejected" });
    const message = String(error);
    expect(message).toContain("ANTHROPIC_API_KEY");
    expect(message).toContain("anthropic-api");
    expect(message).not.toContain("local-api-key-placeholder");
    expect(message).not.toContain("local-subscription-token-placeholder");
    expect(message).not.toContain("minimax-should-not-be-copied");
    const clean = buildChildEnv("subscription", { PATH: "/usr/bin", HOME: "/tmp/home", CLAUDE_CODE_OAUTH_TOKEN: "oauth-may-pass", MINIMAXCN_API_KEY: "minimax-should-not-be-copied" });
    expect(clean.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-may-pass");
    expect(clean.MINIMAXCN_API_KEY).toBeUndefined();
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
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
