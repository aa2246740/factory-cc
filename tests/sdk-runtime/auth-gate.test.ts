import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { SdkRuntime, type SdkHandle, type SdkUserInput } from "../../src/runtime/sdk-runtime.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import { readClaudeConfig } from "../../src/upstream/claude-config.js";
import { forbiddenNamesIn, type AuthMode } from "../../src/upstream/auth-env.js";
import { startTestBridge } from "../helpers/server.js";

const runtimeState = vi.hoisted(() => ({
  describe: () => ({ kind: "sdk", authMode: "subscription", authVerification: { email: "a***@example.com", mode: "subscription" }, fatalErrors: [{ message: "hidden" }] }),
}));
vi.mock("../../src/runtime/factory.js", () => ({ createRuntime: () => runtimeState }));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const runtimes: SdkRuntime[] = [];

class FakeSdk implements SdkHandle {
  readonly calls: Array<{ prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }> = [];
  readonly inputs: SdkUserInput[] = [];
  constructor(private readonly accountInfo?: () => Promise<Record<string, unknown>>) {}
  tool(): unknown { return {}; }
  createSdkMcpServer(options: Record<string, unknown>): unknown {
    return { ...options, instance: {
      isConnected: () => false,
      sendToolListChanged: async () => undefined,
      server: { sendToolListChanged: async () => undefined, setRequestHandler: () => undefined },
      registerTool: () => ({ update() {}, remove() {} }),
    } };
  }
  query(args: { prompt: AsyncIterable<SdkUserInput>; options: Record<string, unknown> }) {
    this.calls.push(args);
    const self = this;
    const query: ReturnType<SdkHandle["query"]> = {
      accountInfo: this.accountInfo,
      close() {},
      async *[Symbol.asyncIterator]() {
        for await (const input of args.prompt) {
          self.inputs.push(input);
          yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "native-sdk-session" };
        }
      },
    };
    return query;
  }
}

function create(sdk: FakeSdk, authMode: AuthMode, extra: Record<string, unknown> = {}) {
  const config = loadConfig({
    mode: "sdk", dataDir: mkdtempSync(join(tmpdir(), "relay-auth-gate-")), authMode, permissionMode: "bypass",
    upstreamBaseUrl: "https://offline.invalid/anthropic", upstreamModel: "offline-test-model", upstreamTokenEnv: "BRIDGE_TEST_FAKE_KEY",
    requestTimeoutMs: 300, toolWaitMs: 300, ...(authMode === "claude-config" ? { models: [{ id: "relay", model: "sonnet", displayName: "Claude Sonnet" }] } : {}), ...extra,
  });
  const runtime = new SdkRuntime(config, logger, sdk);
  runtimes.push(runtime);
  return runtime;
}
function session(): SessionRecord {
  return { bridgeSessionId: "session-a", role: "chat", state: "NEW", model: "relay", toolNames: [], createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [], usage: { input_tokens: 0, output_tokens: 0, estimated: true } };
}
function request(): RuntimeRequest {
  return { request: { model: "relay", max_tokens: 16, messages: [{ role: "user", content: "hello" }] }, session: session(), role: "chat", headers: {} };
}
function isolate(mode: AuthMode, extra: Record<string, string> = {}): () => void {
  const saved = new Map<string, string | undefined>();
  for (const name of forbiddenNamesIn(mode, process.env)) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("auth verification gate", () => {
  it("rejects subscription when accountInfo reports an API key and sends no user message", async () => {
    const restore = isolate("subscription");
    try {
      const sdk = new FakeSdk(async () => ({ apiKeySource: "ANTHROPIC_API_KEY", email: "ada@example.com" }));
      const runtime = create(sdk, "subscription");
      await expect(runtime.handle(request())).rejects.toMatchObject({
        code: "auth_mode_mismatch",
        message: expect.not.stringMatching(/ada@|example\.com|email=/),
      });
      expect(sdk.inputs).toHaveLength(0);
      expect(JSON.stringify(runtime.describe().authVerification)).not.toContain("ada@");
      expect(runtime.describe().authVerification).toMatchObject({ email: "a***@example.com" });
      expect(logger.info).toHaveBeenCalledWith("auth_verified", expect.objectContaining({ mode: "subscription", kind: "anthropic-api", ok: false }));
    } finally { restore(); }
  });

  it.each(["max", "pro"])("accepts subscriptionType %s without an apiKeySource", async (subscriptionType) => {
    const restore = isolate("subscription");
    try {
      const sdk = new FakeSdk(async () => ({ subscriptionType }));
      const runtime = create(sdk, "subscription");
      await expect(runtime.handle(request())).resolves.toMatchObject({ response: { stop_reason: "end_turn" } });
      expect(sdk.inputs).toHaveLength(1);
      expect(runtime.describe().authVerification).toMatchObject({ kind: "subscription" });
    } finally { restore(); }
  });

  it.each([
    { name: "API key source despite a Max subscription", accountInfo: async () => ({ apiKeySource: "ANTHROPIC_API_KEY", subscriptionType: "max" }) },
    { name: "empty account info", accountInfo: async () => ({}) },
    { name: "account info failure", accountInfo: async (): Promise<Record<string, unknown>> => { throw new Error("offline account lookup failure"); } },
  ])("rejects $name without sending the prompt", async ({ accountInfo }) => {
    const restore = isolate("subscription");
    try {
      const sdk = new FakeSdk(accountInfo);
      await expect(create(sdk, "subscription").handle(request())).rejects.toMatchObject({ code: "auth_mode_mismatch" });
      expect(sdk.calls).toHaveLength(1);
      expect(sdk.inputs).toHaveLength(0);
    } finally { restore(); }
  });

  it("rejects anthropic-api when accountInfo reports a subscription", async () => {
    const restore = isolate("anthropic-api", { ANTHROPIC_API_KEY: "offline-anthropic-key" });
    try {
      const sdk = new FakeSdk(async () => ({ subscriptionType: "max", apiKeySource: "none" }));
      await expect(create(sdk, "anthropic-api").handle(request())).rejects.toMatchObject({ code: "auth_mode_mismatch" });
      expect(sdk.inputs).toHaveLength(0);
    } finally { restore(); }
  });

  it("accepts a matching subscription account and a matching API-key account", async () => {
    const restoreSubscription = isolate("subscription");
    try {
      const sdk = new FakeSdk(async () => ({ subscriptionType: "pro", apiKeySource: "none", email: "ada@example.com" }));
      const runtime = create(sdk, "subscription");
      await expect(runtime.handle(request())).resolves.toMatchObject({ response: { stop_reason: "end_turn" } });
      expect(sdk.inputs).toHaveLength(1);
      expect(runtime.describe().authVerification).toMatchObject({ mode: "subscription", kind: "subscription", email: "a***@example.com" });
    } finally { restoreSubscription(); }
    const restoreApi = isolate("anthropic-api", { ANTHROPIC_API_KEY: "offline-anthropic-key" });
    try {
      const sdk = new FakeSdk(async () => ({ apiKeySource: "ANTHROPIC_API_KEY" }));
      const runtime = create(sdk, "anthropic-api");
      await expect(runtime.handle(request())).resolves.toMatchObject({ response: { stop_reason: "end_turn" } });
      expect(sdk.calls[0]!.options.settings).toBeUndefined();
    } finally { restoreApi(); }
  });

  it("rejects a missing accountInfo method and a timed-out accountInfo", async () => {
    const restore = isolate("subscription");
    try {
      const missing = new FakeSdk();
      await expect(create(missing, "subscription").handle(request())).rejects.toMatchObject({ code: "auth_mode_mismatch" });
      expect(missing.inputs).toHaveLength(0);
      const hung = new FakeSdk(() => new Promise(() => undefined));
      await expect(create(hung, "subscription", { requestTimeoutMs: 30 }).handle(request())).rejects.toMatchObject({ code: "auth_mode_mismatch" });
      expect(hung.inputs).toHaveLength(0);
    } finally { restore(); }
  });

  it("passes apiKeyHelper through SDK flag settings", async () => {
    const restore = isolate("anthropic-api", { BRIDGE_API_KEY_HELPER: "/tmp/relay-auth-helper" });
    try {
      const sdk = new FakeSdk(async () => ({ apiKeySource: "apiKeyHelper" }));
      const runtime = create(sdk, "anthropic-api");
      await runtime.handle(request());
      expect(sdk.calls[0]!.options.settings).toEqual({ apiKeyHelper: "/tmp/relay-auth-helper" });
      expect(sdk.calls[0]!.options.settingSources).toEqual([]);
    } finally { restore(); }
  });

  it("sets settingSources only for isolated modes", async () => {
    vi.stubEnv("BRIDGE_TEST_FAKE_KEY", "offline-placeholder-never-sent");
    const byok = new FakeSdk();
    await create(byok, "byok").handle(request());
    expect(byok.calls[0]!.options).toMatchObject({ settingSources: [], strictMcpConfig: true });

    const restoreCloud = isolate("cloud", { CLAUDE_CODE_USE_BEDROCK: "1" });
    try {
      const cloud = new FakeSdk();
      await create(cloud, "cloud").handle(request());
      expect(cloud.calls[0]!.options).toMatchObject({ settingSources: [], strictMcpConfig: true });
    } finally { restoreCloud(); }

    const snapshot = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, { PATH: "/usr/bin", HOME: "/tmp/relay-auth-home", GLM_CN_API_KEY: "offline-unrelated-secret", BRIDGE_ADMIN_TOKEN: "offline-admin" });
      const inherited = new FakeSdk();
      await create(inherited, "inherit").handle(request());
      expect(inherited.calls[0]!.options.settingSources).toBeUndefined();
      expect(inherited.calls[0]!.options.strictMcpConfig).toBeUndefined();
      const env = inherited.calls[0]!.options.env as Record<string, string>;
      expect(env.GLM_CN_API_KEY).toBe("offline-unrelated-secret");
      expect(env.BRIDGE_ADMIN_TOKEN).toBeUndefined();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, snapshot);
    }
  });

  describe("claude-config first-prompt gate", () => {
    function configured(settings: unknown = {}) {
      const root = mkdtempSync(join(tmpdir(), "relay-config-gate-"));
      writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
      const config = readClaudeConfig({ HOME: root, CLAUDE_CONFIG_DIR: root });
      rmSync(root, { recursive: true, force: true });
      return config;
    }

    it.each([{}, { subscriptionType: "max" }, { apiKeySource: "ANTHROPIC_API_KEY" }])("accepts helper routing with classification %j and preserves isolation", async (info) => {
      const helper = "relative-helper --offline-secret";
      const sdk = new FakeSdk(async () => info);
      const runtime = create(sdk, "claude-config", { claudeConfig: configured({ apiKeyHelper: helper, env: { ANTHROPIC_API_KEY: "literal-never-used" } }) });
      await runtime.handle(request());
      expect(sdk.inputs).toHaveLength(1);
      expect(sdk.calls[0]!.options).toMatchObject({ settings: { apiKeyHelper: helper }, settingSources: [], strictMcpConfig: true });
      expect(JSON.stringify(sdk.calls[0]!.options)).not.toContain("literal-never-used");
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain(helper);
    });

    it.each([{}, { subscriptionType: "max" }, { apiKeySource: "ANTHROPIC_API_KEY" }])("requires a recognized login only for pure login: %j", async (info) => {
      const sdk = new FakeSdk(async () => info), runtime = create(sdk, "claude-config", { claudeConfig: configured() });
      if (Object.keys(info).length) {
        await runtime.handle(request()); expect(sdk.inputs).toHaveLength(1);
      } else {
        await expect(runtime.handle(request())).rejects.toThrow("Claude Code is not logged in. Run claude and log in, then retry.");
        expect(sdk.inputs).toHaveLength(0);
      }
    });

    it.each(["gateway", "credential"])("accepts unknown classification with resolved %s", async (source) => {
      const root = mkdtempSync(join(tmpdir(), "relay-config-gate-"));
      const config = readClaudeConfig({ HOME: root, CLAUDE_CONFIG_DIR: root, ...(source === "gateway" ? { ANTHROPIC_BASE_URL: "https://offline.invalid" } : { ANTHROPIC_AUTH_TOKEN: "offline-shell-key" }) });
      rmSync(root, { recursive: true, force: true });
      const sdk = new FakeSdk(async () => ({}));
      await create(sdk, "claude-config", { claudeConfig: config }).handle(request());
      expect(sdk.inputs).toHaveLength(1);
      expect(logger.info).toHaveBeenCalledWith("auth_verified", expect.objectContaining({ mode: "claude-config", kind: "unknown", ok: true }));
    });

    it("redacts helper and replacement credentials from SDK startup errors", async () => {
      const config = configured({ apiKeyHelper: "helper --secret-value" });
      config.env.ANTHROPIC_AUTH_TOKEN = "offline-replacement-key";
      const sdk = new FakeSdk(async () => ({}));
      vi.spyOn(sdk, "query").mockImplementation(() => { throw new Error("helper --secret-value offline-replacement-key"); });
      const runtime = create(sdk, "claude-config", { claudeConfig: config });
      await expect(runtime.handle(request())).rejects.toThrow("[REDACTED] [REDACTED]");
      expect(JSON.stringify(runtime.describe())).not.toMatch(/helper --secret-value|offline-replacement-key/);
    });

    it.each(["throw", "timeout", "missing"])("refuses accountInfo %s even with a helper before sending a prompt", async (kind) => {
      const sdk = new FakeSdk(kind === "missing" ? undefined : kind === "throw" ? async () => { throw new Error("helper --secret-value"); } : () => new Promise(() => undefined));
      const runtime = create(sdk, "claude-config", { claudeConfig: configured({ apiKeyHelper: "helper --secret-value" }), requestTimeoutMs: 20 });
      await expect(runtime.handle(request())).rejects.toMatchObject({ code: "auth_mode_mismatch" });
      expect(sdk.inputs).toHaveLength(0);
      expect(JSON.stringify(runtime.describe())).not.toContain("helper --secret-value");
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain("helper --secret-value");
    });
  });

  it("omits auth verification from /healthz and keeps the masked email on the admin runtime route", async () => {
    const { app, config } = await startTestBridge({ mode: "sdk", authMode: "subscription" });
    try {
      const health = await fetch(`${app.url}/healthz`).then((response) => response.json()) as { ok: boolean; mode: string };
      expect(health).toEqual({ ok: true, mode: "sdk" });
      expect(JSON.stringify(health)).not.toContain("example.com");
      expect(JSON.stringify(health)).not.toContain("fatalErrors");
      const admin = await fetch(`${app.url}/internal/runtime`, { headers: { "x-bridge-admin-token": config.adminToken } }).then((response) => response.json()) as { authVerification: { email: string } };
      expect(admin.authVerification.email).toBe("a***@example.com");
    } finally { await app.close(); }
  });
});
