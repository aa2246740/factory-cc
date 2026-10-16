import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { SdkRuntime } from "../../src/runtime/sdk-runtime.js";
import { sdkEnv, selectionFromConfig } from "../../src/upstream/providers.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const configured = { baseUrl: "https://provider.invalid/anthropic", model: "selected-model", tokenEnv: "TEST_SELECTED_BYOK_KEY" };
const selectors = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_HOST_SESSION_ID", "ANTHROPIC_CUSTOM_HEADERS"];

describe("explicit BYOK authorization boundary", () => {
  it.each(["absent", "partial", "missing-key"])("never probes ambient provider keys for %s configuration", async (kind) => {
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    vi.stubEnv("MINIMAXCN_API_KEY", "offline-ambient-key-must-not-be-used");
    vi.stubEnv("GLM_CN_API_KEY", "offline-other-key-must-not-be-used");
    vi.stubEnv("TEST_SELECTED_BYOK_KEY", "");
    const directory = mkdtempSync(join(tmpdir(), "relay-byok-boundary-"));
    directories.push(directory);
    const runtime = new SdkRuntime(loadConfig({ dataDir: directory, authMode: "byok",
      upstreamBaseUrl: kind === "absent" ? "" : configured.baseUrl,
      upstreamModel: kind === "missing-key" ? configured.model : "",
      upstreamTokenEnv: kind === "missing-key" ? configured.tokenEnv : "",
    }), { info() {}, warn() {}, error() {} });
    await expect(runtime.ensureSelection()).rejects.toMatchObject({ code: "blocked_auth" });
    expect(send).not.toHaveBeenCalled();
  });

  it("removes competing backend/auth selectors only in BYOK child environment", () => {
    vi.stubEnv("TEST_SELECTED_BYOK_KEY", "offline-explicit-key");
    for (const name of selectors) vi.stubEnv(name, "ambient-selector");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.invalid:8080");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/tmp/ca.pem");
    const selection = selectionFromConfig(configured)!;
    const byok = sdkEnv(selection, "127.0.0.1:18787", "byok");
    const subscription = sdkEnv(undefined, "127.0.0.1:18787", "subscription");
    for (const name of selectors) {
      expect(byok[name]).toBeUndefined();
      expect(subscription[name]).toBe("ambient-selector");
      expect(process.env[name]).toBe("ambient-selector");
    }
    expect(byok).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "offline-explicit-key", ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: configured.baseUrl, HTTPS_PROXY: "http://proxy.invalid:8080", NODE_EXTRA_CA_CERTS: "/tmp/ca.pem" });
  });

  it("fails closed when a cached selection loses its credential before process startup", () => {
    vi.stubEnv("TEST_SELECTED_BYOK_KEY", "offline-explicit-key");
    const selection = selectionFromConfig(configured)!;
    vi.stubEnv("TEST_SELECTED_BYOK_KEY", " ");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "offline-ambient-token");
    expect(() => sdkEnv(selection, "127.0.0.1:18787")).toThrow(/no longer available/);
  });

  it.each(["https://name:secret@provider.invalid/anthropic", "https://provider.invalid/?key=secret", "file:///tmp/provider", "invalid-secret-url"])("rejects malformed or credential-bearing endpoint without echoing it: %s", (baseUrl) => {
    vi.stubEnv("TEST_SELECTED_BYOK_KEY", "offline-explicit-key");
    let error: unknown;
    try { selectionFromConfig({ ...configured, baseUrl }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "invalid_upstream" });
    expect(String(error)).not.toContain("secret");
  });
});
