import { afterEach, describe, expect, it, vi } from "vitest";
import { modelSlots, sdkEnv, selectionFromConfig } from "../../src/upstream/providers.js";

// These fixtures are synthetic. sdkEnv only returns strings; no CLI, file, FD or network is opened.
const competingSelectors = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "CCR_AGENT_PROXY_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
  "CLAUDE_CODE_GATEWAY_TOKEN",
  "CLAUDE_CODE_HOST_GATEWAY_LINEAGE",
  "AGENT_PROXY_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "ANTHROPIC_UNIX_SOCKET",
  "_CLAUDE_CODE_AGENT_PROXY_HTTP_SOCKET",
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
  "FALLBACK_FOR_ALL_PRIMARY_MODELS"
] as const;
const selectedModelSlots = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL"
] as const;
const preserved = {
  HTTPS_PROXY: "http://proxy.invalid:3128", ALL_PROXY: "socks5://proxy.invalid:1080",
  NODE_EXTRA_CA_CERTS: "/nonexistent/byok-audit-ca.pem",
  CLAUDE_CODE_USE_POWERSHELL_TOOL: "1", CLAUDE_CODE_USE_NATIVE_FILE_SEARCH: "1",
  AWS_PROFILE: "project-tools-profile", GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/project-tools.json",
};

function installCompetingEnvironment() {
  for (const key of competingSelectors) vi.stubEnv(key, key.endsWith("FILE_DESCRIPTOR") ? "900001" : "offline-ambient-placeholder");
  vi.stubEnv("CLAUDE_CODE_HOST_CREDS_FILE", "/nonexistent/byok-audit-creds.json");
  vi.stubEnv("CLAUDE_CODE_HOST_AUTH_ENV_VAR", "BYOK_AUDIT_OTHER_KEY");
  vi.stubEnv("BYOK_AUDIT_OTHER_KEY", "offline-other-key");
  for (const key of selectedModelSlots) vi.stubEnv(key, "offline-ambient-model");
  for (const [key, value] of Object.entries(preserved)) vi.stubEnv(key, value);
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://ambient.invalid/anthropic");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "offline-ambient-token");
  vi.stubEnv("ANTHROPIC_API_KEY", "offline-ambient-api-key");
}

describe("explicit BYOK environment isolation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("removes every competing backend, credential and transport selector before the official CLI starts", () => {
    installCompetingEnvironment();
    vi.stubEnv("BYOK_AUDIT_SELECTED_KEY", "offline-selected-key");
    const selection = selectionFromConfig({ baseUrl: "https://selected.invalid/anthropic", model: "offline-selected-model", tokenEnv: "BYOK_AUDIT_SELECTED_KEY" });
    const env = sdkEnv(selection, "127.0.0.1:18787", "byok");
    for (const key of competingSelectors) expect(env, key).not.toHaveProperty(key);
    for (const key of selectedModelSlots) expect(env[key], key).toBe("offline-selected-model");
    expect(env).toMatchObject({ ...preserved, ANTHROPIC_BASE_URL: "https://selected.invalid/anthropic", ANTHROPIC_AUTH_TOKEN: "offline-selected-key", ANTHROPIC_API_KEY: "" });
  });

  it("pins fast, default, Fable and workflow subagent routes along with the existing aliases", () => {
    expect(Object.keys(modelSlots("offline-selected-model")).sort()).toEqual([...selectedModelSlots].sort());
    expect(new Set(Object.values(modelSlots("offline-selected-model")))).toEqual(new Set(["offline-selected-model"]));
  });

  it("preserves subscription auth, routing, model and unrelated project-tool settings", () => {
    installCompetingEnvironment();
    const env = sdkEnv(undefined, "127.0.0.1:18787", "subscription");
    for (const key of [...competingSelectors, ...selectedModelSlots, "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]) expect(env[key], key).toBe(process.env[key]);
    expect(env).toMatchObject(preserved);
  });
});
