import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasByokSecrets, listUsableProviders, modelSlots, publicSelection, sdkEnv, selectionFromConfig, selectUpstream } from "../../src/upstream/providers.js";

describe("upstream selection helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("preserves proxy routing and CA trust for both auth modes", () => {
    const routing = {
      HTTP_PROXY: "http://proxy.test:3128",
      HTTPS_PROXY: "http://proxy.test:3128",
      ALL_PROXY: "socks5://proxy.test:1080",
      http_proxy: "http://lower.test:3128",
      https_proxy: "http://lower.test:3128",
      all_proxy: "socks5://lower.test:1080",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      NODE_EXTRA_CA_CERTS: "/tmp/test-ca.pem",
      SSL_CERT_FILE: "/tmp/test-ca.pem",
      REQUESTS_CA_BUNDLE: "/tmp/test-ca.pem",
    };
    for (const [key, value] of Object.entries(routing)) vi.stubEnv(key, value);
    vi.stubEnv("TEST_UPSTREAM_KEY", "test-token");
    const selection = {
      provider: {
        id: "glm" as const, label: "test", baseUrl: "https://provider.test/anthropic",
        model: "test-model", tokenEnv: "TEST_UPSTREAM_KEY", authHeader: "authorization" as const,
      },
      modelSlots: modelSlots("test-model"),
    };
    expect(sdkEnv(selection, "127.0.0.1:18787", "byok")).toMatchObject(routing);
    expect(sdkEnv(undefined, "127.0.0.1:18787", "subscription")).toMatchObject(routing);
  });

  it("fills every Claude Code model slot with the same BYOK model", () => {
    const slots = modelSlots("MiniMax-M2.5");
    expect(slots.ANTHROPIC_MODEL).toBe("MiniMax-M2.5");
    expect(slots.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("MiniMax-M2.5");
    expect(slots.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("MiniMax-M2.5");
    expect(slots.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("MiniMax-M2.5");
    expect(slots.CLAUDE_CODE_SUBAGENT_MODEL).toBe("MiniMax-M2.5");
  });

  it("injects AUTH_TOKEN, empties API_KEY, and refuses a Bridge loop", () => {
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
    const env = sdkEnv(selection, "127.0.0.1:18787");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimaxi.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-minimax-token-not-real");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M2.5");
    expect(publicSelection(selection).tokenEnv).toBe("MINIMAXCN_API_KEY");
    expect(() => sdkEnv({
      ...selection,
      provider: { ...selection.provider, baseUrl: "http://127.0.0.1:18787" },
    }, "127.0.0.1:18787")).toThrow(/refusing/);
    if (previous === undefined) delete process.env.MINIMAXCN_API_KEY;
    else process.env.MINIMAXCN_API_KEY = previous;
  });
});


describe("region-specific upstream routing", () => {
  const routes = [
    ["GLM_CN_API_KEY", "https://open.bigmodel.cn/api/anthropic"],
    ["ZAI_CODING_PLAN_KEY", "https://api.z.ai/api/anthropic"],
    ["MINIMAXCN_API_KEY", "https://api.minimax.cn/anthropic"],
    ["MINIMAX_INTL_API_KEY", "https://api.minimax.io/anthropic"],
  ] as const;

  beforeEach(() => {
    for (const [name] of routes) vi.stubEnv(name, "");
    vi.stubEnv("OPENROUTER_ONLYUSE_FREEMODEL_API_KEY", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it.each(routes)("discovers %s only on its own official regional endpoint", (name, url) => {
    expect(hasByokSecrets()).toBe(false);
    vi.stubEnv(name, "offline-placeholder-not-a-real-key");
    expect(hasByokSecrets()).toBe(true);
    const providers = listUsableProviders();
    expect(providers.length).toBeGreaterThan(0);
    expect([...new Set(providers.map((provider) => provider.baseUrl))]).toEqual([url]);
    expect(providers.every((provider) => provider.tokenEnv === name)).toBe(true);
  });

  it("keeps simultaneous regional credentials paired with their own hosts", () => {
    for (const [name] of routes) vi.stubEnv(name, `offline-${name}`);
    const providers = listUsableProviders();
    for (const [name, url] of routes) {
      expect(providers.some((provider) => provider.tokenEnv === name)).toBe(true);
      expect(providers.filter((provider) => provider.tokenEnv === name).every((provider) => provider.baseUrl === url)).toBe(true);
    }
  });

  it.each(routes)("does not retry %s in another region after authentication rejection", async (name, url) => {
    vi.stubEnv(name, "offline-placeholder-not-a-real-key");
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ error: { message: "offline rejection" } }), { status: 401 }));
    vi.stubGlobal("fetch", send);
    const result = await selectUpstream();
    expect(result.selection).toBeUndefined();
    expect(send).toHaveBeenCalled();
    expect(send.mock.calls.every(([destination, options]) => destination === `${url}/v1/messages` && options?.redirect === "error")).toBe(true);
    expect(result.attempts.every((attempt) => attempt.tokenEnv === name && attempt.baseUrl === url)).toBe(true);
  });

  it("recognizes explicit Z.AI as GLM with bearer authentication", () => {
    vi.stubEnv("TEST_EXPLICIT_UPSTREAM_KEY", "offline-zai-key");
    const selection = selectionFromConfig({ baseUrl: "https://api.z.ai/api/anthropic", model: "glm-5.2", tokenEnv: "TEST_EXPLICIT_UPSTREAM_KEY" });
    expect(selection?.provider).toMatchObject({ id: "glm", baseUrl: "https://api.z.ai/api/anthropic", authHeader: "authorization", tokenEnv: "TEST_EXPLICIT_UPSTREAM_KEY" });
    expect(selection?.modelSlots.ANTHROPIC_MODEL).toBe("glm-5.2");
  });

  it("uses the URL hostname, not its path, to select the authentication header", () => {
    vi.stubEnv("TEST_EXPLICIT_UPSTREAM_KEY", "offline-configured-key");
    const cn = selectionFromConfig({ baseUrl: "https://open.bigmodel.cn/api/anthropic", model: "glm-5.2", tokenEnv: "TEST_EXPLICIT_UPSTREAM_KEY" });
    const international = selectionFromConfig({ baseUrl: "https://api.minimax.io/anthropic/bigmodel", model: "MiniMax-M2.5", tokenEnv: "TEST_EXPLICIT_UPSTREAM_KEY" });
    expect(cn?.provider).toMatchObject({ id: "glm", authHeader: "x-api-key" });
    expect(international?.provider).toMatchObject({ id: "minimax", authHeader: "authorization" });
  });
});
