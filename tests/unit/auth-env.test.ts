import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { buildChildEnv, classifyAuth, preflightAuth } from "../../src/upstream/auth-env.js";
import { modelSlots, selectionFromConfig, type UpstreamSelection } from "../../src/upstream/providers.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const secret = "secret-value-must-not-leak";
const base = { PATH: "/usr/bin", HOME: "/tmp/relay-auth-home" };
const selection = (): UpstreamSelection => ({
  provider: {
    id: "glm", label: "test", baseUrl: "https://provider.invalid/anthropic", model: "offline-model",
    tokenEnv: "TEST_AUTH_ENV_KEY", authHeader: "authorization",
  },
  modelSlots: modelSlots("offline-model"),
});

const families: Array<{ name: string; keys: string[]; hint?: string }> = [
  {
    name: "endpoint and credential selectors",
    keys: ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_API_BASE_URL", "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"],
    hint: "anthropic-api",
  },
  { name: "cloud routers", keys: ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_MANTLE"], hint: "cloud" },
  { name: "file descriptors", keys: ["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CCR_AGENT_PROXY_TOKEN_FILE_DESCRIPTOR"] },
  { name: "gateway tokens", keys: ["CLAUDE_CODE_GATEWAY_TOKEN", "AGENT_PROXY_AUTH_TOKEN"] },
  { name: "model slots", keys: ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL"] },
  { name: "bridge upstream leftovers", keys: ["BRIDGE_UPSTREAM_BASE_URL", "BRIDGE_UPSTREAM_MODEL", "BRIDGE_UPSTREAM_TOKEN_ENV"] },
];

describe("auth environment", () => {
  it("loadConfig rejects an unknown BRIDGE_AUTH value", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "relay-auth-config-"));
    directories.push(dataDir);
    vi.stubEnv("BRIDGE_AUTH", "nope");
    expect(() => loadConfig({ dataDir })).toThrow(/Invalid BRIDGE_AUTH=nope/);
    expect(loadConfig({ dataDir, authMode: "inherit" }).authMode).toBe("inherit");
  });

  it.each(families)("subscription preflight rejects $name", ({ keys, hint }) => {
    const source: NodeJS.ProcessEnv = { ...base };
    for (const key of keys) source[key] = secret;
    let error: unknown;
    try { preflightAuth("subscription", source); } catch (caught) { error = caught; }
    const message = String(error);
    expect(error).toMatchObject({ code: "auth_env_rejected" });
    expect(message).not.toContain(secret);
    for (const key of keys) expect(message).toContain(key);
    if (hint) expect(message).toContain(hint);
  });

  it("anthropic-api requires a key, allows only the official base URL, and rejects oauth", () => {
    expect(() => buildChildEnv("anthropic-api", { ...base })).toThrow(expect.objectContaining({ code: "auth_env_rejected" }));
    const official = buildChildEnv("anthropic-api", { ...base, ANTHROPIC_API_KEY: "offline-key", ANTHROPIC_BASE_URL: "https://api.anthropic.com/" });
    expect(official.ANTHROPIC_API_KEY).toBe("offline-key");
    expect(official.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com/");
    expect(() => buildChildEnv("anthropic-api", { ...base, ANTHROPIC_API_KEY: "offline-key", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" })).toThrow(/ANTHROPIC_BASE_URL/);
    let oauth: unknown;
    try { buildChildEnv("anthropic-api", { ...base, ANTHROPIC_API_KEY: "offline-key", CLAUDE_CODE_OAUTH_TOKEN: secret }); }
    catch (caught) { oauth = caught; }
    expect(String(oauth)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(String(oauth)).not.toContain(secret);
    const helper = buildChildEnv("anthropic-api", { ...base, BRIDGE_API_KEY_HELPER: "/tmp/relay-auth-helper" });
    expect(helper.ANTHROPIC_API_KEY).toBeUndefined();
    expect(() => buildChildEnv("anthropic-api", { ...base, BRIDGE_API_KEY_HELPER: "relative-helper" })).toThrow(/absolute path/);
  });

  it("cloud requires exactly one CLAUDE_CODE_USE_* backend", () => {
    expect(() => buildChildEnv("cloud", { ...base })).toThrow(/exactly one/);
    expect(() => buildChildEnv("cloud", { ...base, CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1" })).toThrow(/exactly one/);
    const env = buildChildEnv("cloud", { ...base, CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "offline-profile", ANTHROPIC_MODEL: "offline-model" });
    expect(env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "offline-profile", ANTHROPIC_MODEL: "offline-model" });
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    let blocked: unknown;
    try { buildChildEnv("cloud", { ...base, CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_API_KEY: secret }); }
    catch (caught) { blocked = caught; }
    expect(String(blocked)).toContain("ANTHROPIC_API_KEY");
    expect(String(blocked)).not.toContain(secret);
  });

  const passthroughDenied = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_HOST_API",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_CODE_SDK_HAS_API",
    "_CLAUDE_CODE_AGENT_PROXY_HTTP_SOCKET",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
    "CCR_AGENT_PROXY_BASE_URL",
    "AGENT_PROXY_AUTH_TOKEN",
    "FALLBACK_FOR_ALL_PRIMARY_MODELS",
    "BRIDGE_ADMIN_TOKEN",
    "BRIDGE_FACTORY_BINDING",
    "BRIDGE_FACTORY_LAUNCH_ID",
    "BRIDGE_LAUNCH_ID",
    "BRIDGE_UPSTREAM_BASE_URL",
    "BRIDGE_UPSTREAM_MODEL",
    "BRIDGE_UPSTREAM_TOKEN_ENV",
  ] as const;

  it.each(passthroughDenied)("byok passthrough cannot reintroduce %s", (name) => {
    let error: unknown;
    try {
      buildChildEnv("byok", { ...base, TEST_AUTH_ENV_KEY: "offline-byok", BRIDGE_ENV_PASSTHROUGH: name, [name]: secret }, selection());
    } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "auth_env_rejected" });
    expect(String(error)).toContain(name);
    expect(String(error)).not.toContain(secret);
  });

  it.each(passthroughDenied)("subscription passthrough cannot reintroduce %s", (name) => {
    let error: unknown;
    try {
      buildChildEnv("subscription", { ...base, BRIDGE_ENV_PASSTHROUGH: name, [name]: secret });
    } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "auth_env_rejected" });
    expect(String(error)).toContain(name);
    expect(String(error)).not.toContain(secret);
  });

  it("refuses CLAUDE_CONFIG_DIR via byok passthrough and still copies the subscription extras", () => {
    expect(() => buildChildEnv("byok", {
      ...base, TEST_AUTH_ENV_KEY: "offline-byok", BRIDGE_ENV_PASSTHROUGH: "CLAUDE_CONFIG_DIR", CLAUDE_CONFIG_DIR: secret,
    }, selection())).toThrow(/CLAUDE_CONFIG_DIR/);
    const copied = buildChildEnv("subscription", {
      ...base,
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-offline",
      CLAUDE_CONFIG_DIR: "/tmp/claude-home",
      GLM_CN_API_KEY: secret,
      BRIDGE_ENV_PASSTHROUGH: "CLAUDE_CODE_OAUTH_TOKEN,CLAUDE_CONFIG_DIR,GLM_CN_API_KEY",
    });
    expect(copied.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-offline");
    expect(copied.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-home");
    expect(copied.GLM_CN_API_KEY).toBe(secret);
  });

  it("keeps unrelated secrets out unless BRIDGE_ENV_PASSTHROUGH names them", () => {
    const source = { ...base, GLM_CN_API_KEY: secret, HTTPS_PROXY: "http://proxy.invalid:3128" };
    const byok = buildChildEnv("byok", { ...source, TEST_AUTH_ENV_KEY: "offline-byok" }, selection());
    const subscription = buildChildEnv("subscription", source);
    const anthropic = buildChildEnv("anthropic-api", { ...source, ANTHROPIC_API_KEY: "offline-key" });
    const cloud = buildChildEnv("cloud", { ...source, CLAUDE_CODE_USE_VERTEX: "1" });
    for (const env of [byok, subscription, anthropic, cloud]) {
      expect(env.GLM_CN_API_KEY).toBeUndefined();
      expect(env.HTTPS_PROXY).toBe("http://proxy.invalid:3128");
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    }
    const passed = buildChildEnv("subscription", { ...source, BRIDGE_ENV_PASSTHROUGH: "GLM_CN_API_KEY" });
    expect(passed.GLM_CN_API_KEY).toBe(secret);
    expect(() => buildChildEnv("subscription", { ...source, BRIDGE_ENV_PASSTHROUGH: "ANTHROPIC_API_KEY", ANTHROPIC_API_KEY: secret })).toThrow(/ANTHROPIC_API_KEY/);
    const inherited = buildChildEnv("inherit", { ...source, BRIDGE_ADMIN_TOKEN: "admin-token", BRIDGE_FACTORY_BINDING: "binding" });
    expect(inherited.GLM_CN_API_KEY).toBe(secret);
    expect(inherited.BRIDGE_ADMIN_TOKEN).toBeUndefined();
    expect(inherited.BRIDGE_FACTORY_BINDING).toBeUndefined();
  });

  it("rejects an sk-ant- token for a third-party host and allows api.anthropic.com", () => {
    vi.stubEnv("TEST_AUTH_ENV_KEY", "sk-ant-offline-example");
    let error: unknown;
    try { selectionFromConfig({ baseUrl: "https://api.z.ai/api/anthropic", model: "glm-5.2", tokenEnv: "TEST_AUTH_ENV_KEY" }); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "anthropic_credential_to_third_party" });
    expect(String(error)).not.toContain("sk-ant-offline-example");
    expect(selectionFromConfig({ baseUrl: "https://api.anthropic.com/v1", model: "sonnet", tokenEnv: "TEST_AUTH_ENV_KEY" })?.provider.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(() => selectionFromConfig({ baseUrl: "https://anthropic.com.evil.test/anthropic", model: "sonnet", tokenEnv: "TEST_AUTH_ENV_KEY" })).toThrow(expect.objectContaining({ code: "anthropic_credential_to_third_party" }));
  });
});

describe("classifyAuth", () => {
  it.each([
    [{ apiKeySource: "ANTHROPIC_API_KEY" }, undefined, "anthropic-api"],
    [{ apiKeySource: "none" }, "apiKeyHelper", "anthropic-api"],
    [{ subscriptionType: "max", apiKeySource: "none" }, undefined, "subscription"],
    [{ subscriptionType: "pro", apiKeySource: "ANTHROPIC_API_KEY" }, undefined, "anthropic-api"],
    [{ tokenSource: "oauth" }, undefined, "unknown"],
    [{ apiKeySource: "none" }, "oauth", "unknown"],
    [{}, undefined, "unknown"],
  ] as const)("classifies %j / %s as %s", (info, init, kind) => {
    expect(classifyAuth({ ...info }, init).kind).toBe(kind);
  });
});
