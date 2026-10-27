import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config.js";
import { buildChildEnv, MODEL_SLOT_NAMES, parseAuthMode } from "../../src/upstream/auth-env.js";
import { assertClaudeCredential, claudeConfigModels, claudeConfigNeedsLogin, claudeConfigSummary, needsClaudeCredential, readClaudeConfig, supplyClaudeCredential } from "../../src/upstream/claude-config.js";

const owned: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(settings?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "relay-claude-config-")); owned.push(root);
  const dir = join(root, ".claude"); mkdirSync(dir);
  const path = join(dir, "settings.json");
  if (settings !== undefined) writeFileSync(path, JSON.stringify(settings));
  return { root, dir, path, env: { HOME: root, PATH: "/usr/bin" } };
}
const literal = "offline-literal-must-never-be-carried";

describe("Claude Code settings auth resolution", () => {
  it("carries only allowlisted fields and lists ignored names without their values", () => {
    const routing = Object.fromEntries(MODEL_SLOT_NAMES.map((name) => [name, "offline-model"]));
    const f = fixture({ apiKeyHelper: "relative-helper --private-argument", hooks: { secret: literal }, permissions: {}, enabledPlugins: {}, mcpServers: {}, statusLine: literal,
      env: { ...routing, ANTHROPIC_BASE_URL: "https://gateway.invalid:8443/private?key=hidden", HTTPS_PROXY: "http://proxy.invalid", NODE_EXTRA_CA_CERTS: "/offline/ca", UNKNOWN_ENV: literal } });
    const config = readClaudeConfig({ ...f.env, CLAUDE_CONFIG_DIR: f.dir, CLAUDE_CODE_OAUTH_TOKEN: "offline-oauth", UNRELATED_SECRET: literal });
    expect(config.ignored).toEqual(["enabledPlugins", "env.UNKNOWN_ENV", "hooks", "mcpServers", "permissions", "statusLine"]);
    const env = buildChildEnv("claude-config", f.env, undefined, { claudeConfig: config });
    expect(env).toMatchObject({ ...routing, HTTPS_PROXY: "http://proxy.invalid", NODE_EXTRA_CA_CERTS: "/offline/ca", CLAUDE_CONFIG_DIR: f.dir, CLAUDE_CODE_OAUTH_TOKEN: "offline-oauth" });
    expect(env.UNKNOWN_ENV).toBeUndefined(); expect(env.UNRELATED_SECRET).toBeUndefined();
    const catalog = claudeConfigModels(config), summary = claudeConfigSummary(config, catalog.models, catalog.defaultModel);
    expect(summary).toContain("https://gateway.invalid:8443"); expect(summary).not.toMatch(/private|hidden|relative-helper/);
    expect(JSON.stringify(config)).not.toContain(literal);
  });

  it.each(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"])("discards literal %s and requires a replacement without retaining it", (name) => {
    const f = fixture({ env: { [name]: literal } });
    const config = readClaudeConfig(f.env);
    expect(config.literalNames).toEqual([name]); expect(config.env[name]).toBeUndefined();
    expect(needsClaudeCredential(config)).toBe(true);
    expect(() => assertClaudeCredential(config)).toThrow(/Literal settings credentials are not used/);
    expect(() => buildChildEnv("claude-config", f.env, undefined, { claudeConfig: config })).toThrow(/credential/);
    supplyClaudeCredential(config, "offline-replacement", "--key-env OFFLINE_KEY");
    expect(config.env[name]).toBe("offline-replacement");
    expect(JSON.stringify(config)).not.toContain(literal);
  });

  it("uses a helper instead of a literal credential and prints a non-secret notice", () => {
    const f = fixture({ apiKeyHelper: "helper --secret", env: { ANTHROPIC_API_KEY: literal } });
    const config = readClaudeConfig(f.env);
    expect(config.helper).toBe("helper --secret"); expect(needsClaudeCredential(config)).toBe(false);
    const summary = claudeConfigSummary(config, claudeConfigModels(config).models, "sonnet");
    expect(summary).toContain("Literal settings credential values are not used.");
    expect(summary).not.toMatch(/helper --secret|offline-literal/);
    expect(buildChildEnv("claude-config", f.env, undefined, { claudeConfig: config }).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("refuses differing shell and settings values by name and accepts identical values", () => {
    const f = fixture({ env: { ANTHROPIC_BASE_URL: "https://one.invalid" } });
    expect(() => readClaudeConfig({ ...f.env, ANTHROPIC_BASE_URL: "https://two.invalid" })).toThrow("shell/settings conflict: ANTHROPIC_BASE_URL");
    expect(readClaudeConfig({ ...f.env, ANTHROPIC_BASE_URL: "https://one.invalid" }).env.ANTHROPIC_BASE_URL).toBe("https://one.invalid");
  });

  it("lets settings proxy and CA names win over the shell, as Claude Code does", () => {
    const f = fixture({ env: { NO_PROXY: "127.0.0.1,localhost", https_proxy: "http://settings-proxy.invalid" } });
    const config = readClaudeConfig({ ...f.env, NO_PROXY: "localhost", https_proxy: "http://shell-proxy.invalid", HTTP_PROXY: "http://shell-only.invalid" });
    const env = buildChildEnv("claude-config", { ...f.env, NO_PROXY: "localhost", https_proxy: "http://shell-proxy.invalid", HTTP_PROXY: "http://shell-only.invalid" }, undefined, { claudeConfig: config });
    expect(env).toMatchObject({ NO_PROXY: "127.0.0.1,localhost", https_proxy: "http://settings-proxy.invalid", HTTP_PROXY: "http://shell-only.invalid" });
  });

  it("refuses overlapping shell and literal credential names without inspecting the stored token", () => {
    const f = fixture({ env: { ANTHROPIC_API_KEY: literal } });
    expect(() => readClaudeConfig({ ...f.env, ANTHROPIC_API_KEY: "other-offline-key" })).toThrow("credential conflict: ANTHROPIC_API_KEY");
  });

  it.each(["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE"])("refuses cloud switch %s in either source", (name) => {
    const f = fixture({ env: { [name]: "0" } });
    expect(() => readClaudeConfig(f.env)).toThrow("use --auth cloud");
    writeFileSync(f.path, "{}");
    expect(() => readClaudeConfig({ ...f.env, [name]: "1" })).toThrow("use --auth cloud");
  });

  it("fails closed for malformed, unreadable and invalid settings without echoing contents", () => {
    const f = fixture(); writeFileSync(f.path, `{malformed ${literal}`);
    expect(() => readClaudeConfig(f.env)).toThrow("unreadable or invalid JSON");
    rmSync(f.path); mkdirSync(f.path);
    expect(() => readClaudeConfig(f.env)).toThrow("unreadable or invalid JSON");
    rmSync(f.path, { recursive: true }); writeFileSync(f.path, '{"env":[]}');
    expect(() => readClaudeConfig(f.env)).toThrow("env must be an object");
  });

  it("uses only settings.json at the selected root and treats missing settings as login", () => {
    const f = fixture();
    writeFileSync(join(f.dir, "settings.local.json"), "not JSON"); writeFileSync(join(f.root, ".claude.json"), "not JSON");
    expect(claudeConfigNeedsLogin(readClaudeConfig(f.env))).toBe(true);
    const selected = join(f.root, "selected"); mkdirSync(selected); writeFileSync(join(selected, "settings.json"), '{"env":{"ANTHROPIC_MODEL":"fable"}}');
    expect(readClaudeConfig({ ...f.env, CLAUDE_CONFIG_DIR: selected }).env.ANTHROPIC_MODEL).toBe("fable");
    expect(parseAuthMode(undefined)).toBe("byok");
  });

  it.each(["file:///tmp/gateway", "https://user:secret@gateway.invalid", "invalid", "http://127.0.0.1:18787/v1", "http://localhost:19999/api"])("refuses invalid or bridge-loop URL %s", (url) => {
    const f = fixture({ env: { ANTHROPIC_BASE_URL: url } });
    expect(() => readClaudeConfig(f.env, "localhost:19999")).toThrow();
  });

  it("guards replacement and shell sk-ant keys for third-party hosts", () => {
    const f = fixture({ env: { ANTHROPIC_BASE_URL: "https://gateway.invalid", ANTHROPIC_AUTH_TOKEN: literal } });
    expect(() => supplyClaudeCredential(readClaudeConfig(f.env), "sk-ant-offline", "typed at launch")).toThrow(/outside anthropic.com/);
    expect(() => readClaudeConfig({ ...f.env, ANTHROPIC_API_KEY: "sk-ant-offline" })).toThrow(/outside anthropic.com/);
  });

  it("builds mapped alias entries including fable and selects a mapped ID or adds an exact ID", () => {
    const f = fixture({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5", ANTHROPIC_DEFAULT_SONNET_MODEL: "mapped-sonnet", ANTHROPIC_DEFAULT_HAIKU_MODEL: "mapped-haiku", ANTHROPIC_DEFAULT_FABLE_MODEL: "mapped-fable", ANTHROPIC_MODEL: "mapped-fable" } });
    const config = readClaudeConfig(f.env), catalog = claudeConfigModels(config);
    expect(catalog.defaultModel).toBe("fable");
    expect(catalog.models).toEqual([
      { id: "opus", model: "opus", displayName: "Claude Opus (claude-opus-5-5)" },
      { id: "sonnet", model: "sonnet", displayName: "Claude Sonnet (mapped-sonnet)" },
      { id: "haiku", model: "haiku", displayName: "Claude Haiku (mapped-haiku)" },
      { id: "fable", model: "fable", displayName: "Claude Fable (mapped-fable)" },
    ]);
    config.env.ANTHROPIC_MODEL = "exact-id";
    expect(claudeConfigModels(config)).toMatchObject({ defaultModel: "exact-id", models: [...catalog.models, { id: "exact-id", model: "exact-id", displayName: "exact-id" }] });
  });

  it("keeps default aliases without slots and does not reread settings after startup", () => {
    const f = fixture(); const config = readClaudeConfig(f.env);
    const bridge = loadConfig({ authMode: "claude-config", claudeConfig: config, dataDir: join(f.root, "data") });
    writeFileSync(f.path, "malformed");
    expect(bridge.models?.map((item) => item.id)).toEqual(["sonnet", "opus", "haiku"]);
    expect(JSON.stringify(bridge)).not.toContain('"claudeConfig"');
    expect(buildChildEnv("claude-config", f.env, undefined, { claudeConfig: bridge.claudeConfig }).ANTHROPIC_BASE_URL).toBeUndefined();
  });
  it("resolves BRIDGE_AUTH=claude-config once for server startup and keeps the server default byok", () => {
    const f = fixture({ apiKeyHelper: "relative-helper --secret", env: { ANTHROPIC_MODEL: "exact-model" } });
    // loadConfig reads process.env; clear names a developer's own Claude Code session may export.
    for (const name of Object.keys(process.env)) if (name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_")) vi.stubEnv(name, undefined);
    vi.stubEnv("BRIDGE_AUTH", "claude-config"); vi.stubEnv("CLAUDE_CONFIG_DIR", f.dir);
    const config = loadConfig({ dataDir: join(f.root, "data") });
    expect(config.authMode).toBe("claude-config");
    expect(config.models?.map((item) => item.id)).toEqual(["sonnet", "opus", "haiku", "exact-model"]);
    writeFileSync(f.path, "malformed");
    expect(buildChildEnv(config.authMode, {}, undefined, { claudeConfig: config.claudeConfig }).ANTHROPIC_MODEL).toBe("exact-model");
    vi.stubEnv("BRIDGE_AUTH", "");
    expect(loadConfig({ dataDir: join(f.root, "default-data") }).authMode).toBe("byok");
  });

});

it("refuses missing settings in an explicitly required profile instead of selecting default login", () => {
  const f = fixture();
  expect(claudeConfigNeedsLogin(readClaudeConfig(f.env))).toBe(true);
  expect(() => readClaudeConfig({ ...f.env, CLAUDE_CONFIG_DIR: f.dir }, "127.0.0.1:18787", { requireSettings: true })).toThrow("settings are unreadable");
});

it("fails desktop startup when its selected profile settings are missing", () => {
  const f = fixture();
  vi.stubEnv("HOME", f.root);
  vi.stubEnv("CLAUDE_CONFIG_DIR", f.dir);
  expect(() => loadConfig({ authMode: "claude-config", desktopProfile: true, dataDir: join(f.root, "bridge-data") })).toThrow("settings are unreadable");
});
