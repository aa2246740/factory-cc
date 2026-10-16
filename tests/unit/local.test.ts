import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "../../src/config.js";
import type { BridgeApp } from "../../src/http/app.js";

const observed = vi.hoisted(() => ({ runDroid: vi.fn(), apps: [] as Array<{ app: BridgeApp; config: BridgeConfig }> }));
vi.mock("../../scripts/run-droid.js", async (original) => ({ ...await original<typeof import("../../scripts/run-droid.js")>(), runDroid: observed.runDroid }));
vi.mock("../../src/http/app.js", async (original) => {
  const actual = await original<typeof import("../../src/http/app.js")>();
  return { ...actual, createBridgeApp: (...args: Parameters<typeof actual.createBridgeApp>) => {
    const app = actual.createBridgeApp(...args); observed.apps.push({ app, config: args[0] }); return app;
  } };
});
import { localStateDirectory, parseLocalArgs, runLocal } from "../../scripts/local.js";

const owned: string[] = [];
const providerKey = "offline-local-provider-key-never-write-or-pass-to-droid";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-local-test-")); owned.push(root);
  const project = join(root, "project"), home = join(root, "user-home");
  mkdirSync(project); mkdirSync(join(home, ".factory"), { recursive: true }); mkdirSync(join(home, ".claude"));
  const userSettings = JSON.stringify({ model: "user-model", apiKey: "unrelated-user-factory-credential" });
  writeFileSync(join(home, ".factory/settings.json"), userSettings);
  writeFileSync(join(home, ".claude/.credentials.json"), "UNRELATED USER LOGIN MUST REMAIN UNTOUCHED");
  const state = localStateDirectory(project); owned.push(state);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: home,
    BRIDGE_UPSTREAM_BASE_URL: "https://provider.invalid/anthropic", BRIDGE_UPSTREAM_MODEL: "offline-selected-model", BRIDGE_UPSTREAM_TOKEN_ENV: "LOCAL_TEST_PROVIDER_KEY",
    LOCAL_TEST_PROVIDER_KEY: providerKey, DUPLICATE_PROVIDER_ALIAS: providerKey,
    ANTHROPIC_API_KEY: "ambient-anthropic-key", ANTHROPIC_AUTH_TOKEN: "ambient-anthropic-token", CLAUDE_CODE_OAUTH_TOKEN: "ambient-subscription-token",
    FACTORY_API_KEY: "ambient-factory-key", BRIDGE_FACTORY_BINDING: "old-parent-generation",
    BRIDGE_MODE: "mock", BRIDGE_PERMISSION: "bypass", BRIDGE_SDK_CWD: root,
    BRIDGE_DROID_EXECUTABLE: process.execPath, BRIDGE_CLAUDE_EXECUTABLE: process.execPath,
  };
  const argv = [project, "--base-url", "https://provider.invalid/anthropic", "--model", "offline-selected-model", "--key-env", "LOCAL_TEST_PROVIDER_KEY"];
  return { root, project, home, state, env, argv, userSettings };
}
function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name), entry = lstatSync(path);
    return entry.isDirectory() && !entry.isSymbolicLink() ? files(path) : entry.isFile() ? [path] : [];
  });
}
function argument(argv: string[], flag: string): string | undefined { const index = argv.indexOf(flag); return index < 0 ? undefined : argv[index + 1]; }

beforeEach(() => { observed.runDroid.mockReset(); observed.runDroid.mockResolvedValue(0); observed.apps.length = 0; vi.spyOn(process.stdout, "write").mockImplementation(() => true); });
afterEach(async () => {
  for (const { app } of observed.apps) if (app.server.listening) await app.close();
  vi.restoreAllMocks();
  for (const directory of owned.splice(0).reverse()) rmSync(directory, { recursive: true, force: true });
});

describe("one-command isolated local launch", () => {
  it("starts an ask-mode BYOK bridge, installs discoverable skills and preserves user hooks without exposing the provider key", async () => {
    const f = fixture(); const hooksPath = join(f.project, ".factory/hooks.json"); mkdirSync(join(f.project, ".factory"));
    const userHook = { hooks: [{ type: "command", command: "user-existing-hook" }] };
    const laterHook = { hooks: [{ type: "command", command: "user-added-while-running" }] };
    writeFileSync(hooksPath, JSON.stringify({ Stop: [userHook] }));
    const originalEnv = { ...f.env }; let url = "";
    observed.runDroid.mockImplementationOnce(async (argv: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(observed.apps).toHaveLength(1);
      const { app, config } = observed.apps[0]!; url = app.url;
      expect(config).toMatchObject({ mode: "sdk", authMode: "byok", permissionMode: "ask", sdkCwd: realpathSync(f.project), upstreamModel: "offline-selected-model" });
      expect(app.server.listening).toBe(true);
      const health = await fetch(`${url}/healthz`).then((response) => response.json()) as { upstream: unknown };
      expect(health.upstream).toMatchObject({ authMode: "byok", permissionMode: "ask" });
      expect(argument(argv, "--cwd")).toBe(realpathSync(f.project));
      expect(argument(argv, "--airgap")).toBe("1");
      expect(JSON.stringify(argv)).not.toContain(providerKey);
      expect(Object.values(options.env)).not.toContain(providerKey);
      for (const name of ["LOCAL_TEST_PROVIDER_KEY", "DUPLICATE_PROVIDER_ALIAS", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "FACTORY_API_KEY"]) expect(options.env[name], name).toBeUndefined();
      expect(options.env.HOME).toBe(f.home);
      const factoryHome = argument(argv, "--home")!;
      expect(factoryHome).not.toBe(f.home);
      const settingsPath = join(factoryHome, ".factory/settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(settings.sessionDefaultSettings.model).toBe("custom:offline-selected-model-0");
      expect(settings.missionOrchestratorModel).toBe(settings.sessionDefaultSettings.model);
      expect(settings.missionModelSettings).toEqual({
        workerModel: settings.sessionDefaultSettings.model, validationWorkerModel: settings.sessionDefaultSettings.model, skipScrutiny: false, skipUserTesting: false,
      });
      expect(settings.customModels).toHaveLength(1);
      expect(settings.customModels[0]).toMatchObject({ model: "offline-selected-model", displayName: "offline-selected-model", baseUrl: url, apiKey: config.clientToken, provider: "anthropic" });
      expect(config.models).toEqual([{ id: "offline-selected-model", model: "offline-selected-model", displayName: "offline-selected-model" }]);
      expect(options.env.BRIDGE_MODEL_ID).toBe("offline-selected-model");
      expect(config.clientToken).not.toBe(providerKey);
      expect(statSync(settingsPath).mode & 0o077).toBe(0);
      expect(readFileSync(join(f.state, "manifest.env"), "utf8")).toContain("DROID_CHAT_MODEL_ID=custom:offline-selected-model-0");
      expect(existsSync(join(f.project, ".factory/commands/relay-droid.sh"))).toBe(true);
      expect(readFileSync(join(f.project, ".factory/skills/relay-droid/SKILL.md"), "utf8")).toContain("name: relay-droid");
      const hooks = JSON.parse(readFileSync(hooksPath, "utf8")); expect(hooks.Stop).toContainEqual(userHook);
      expect(hooks.SessionStart).toHaveLength(1); expect(hooks.SessionEnd).toHaveLength(1);
      hooks.Stop.push(laterHook); writeFileSync(hooksPath, JSON.stringify(hooks));
      for (const path of [...files(f.project), ...files(f.state)]) {
        const contents = readFileSync(path, "utf8"); expect(contents, path).not.toContain(providerKey);
        if (contents.includes(config.clientToken) || contents.includes(config.adminToken)) expect(statSync(path).mode & 0o077, path).toBe(0);
      }
      return 0;
    });
    expect(await runLocal(f.argv, f.env)).toBe(0);
    expect(f.env).toEqual(originalEnv);
    expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual({ Stop: [userHook, laterHook] });
    expect(readFileSync(join(f.home, ".factory/settings.json"), "utf8")).toBe(f.userSettings);
    expect(readFileSync(join(f.home, ".claude/.credentials.json"), "utf8")).toBe("UNRELATED USER LOGIN MUST REMAIN UNTOUCHED");
    expect(observed.apps[0]!.app.server.listening).toBe(false);
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    expect(Object.values(process.env)).not.toContain(providerKey);
    expect(vi.mocked(process.stdout.write).mock.calls.map((call) => String(call[0])).join("")).not.toContain(providerKey);
    for (const path of [...files(f.project), ...files(f.state)]) expect(readFileSync(path, "utf8"), path).not.toContain(providerKey);
  });

  it("cleans up after Droid startup failure and releases ownership so the next launch can run", async () => {
    const f = fixture(); const hooksPath = join(f.project, ".factory/hooks.json"); mkdirSync(join(f.project, ".factory"));
    const userHooks = { Stop: [{ hooks: [{ type: "command", command: "keep-this-user-hook" }] }] };
    writeFileSync(hooksPath, JSON.stringify(userHooks));
    observed.runDroid.mockRejectedValueOnce(new Error("offline simulated Droid launch failure"));
    await expect(runLocal(f.argv, f.env)).rejects.toThrow("offline simulated Droid launch failure");
    expect(observed.apps).toHaveLength(1); expect(observed.apps[0]!.app.server.listening).toBe(false);
    expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual(userHooks);
    expect(Object.values(process.env)).not.toContain(providerKey);
    expect(await runLocal(f.argv, f.env)).toBe(0);
    expect(observed.runDroid).toHaveBeenCalledTimes(2);
    expect(observed.apps.every(({ app }) => !app.server.listening)).toBe(true);
  });

  it("refuses concurrent ownership without deleting the active launch's lock or hooks", async () => {
    const f = fixture(); let started!: () => void; let release!: (code: number) => void;
    const entered = new Promise<void>((done) => { started = done; });
    const child = new Promise<number>((done) => { release = done; });
    observed.runDroid.mockImplementationOnce(async () => { started(); return child; });
    const active = runLocal(f.argv, f.env); await entered;
    const hooksPath = join(f.project, ".factory/hooks.json"), hooks = readFileSync(hooksPath, "utf8");
    try {
      await expect(runLocal(f.argv, f.env)).rejects.toThrow(/lock|running|already|active/i);
      await expect(runLocal(f.argv, f.env)).rejects.toThrow(/lock|running|already|active/i);
      expect(observed.runDroid).toHaveBeenCalledTimes(1);
      expect(readFileSync(hooksPath, "utf8")).toBe(hooks);
      expect(observed.apps[0]!.app.server.listening).toBe(true);
    } finally { release(0); await active; }
    expect(await runLocal(f.argv, f.env)).toBe(0);
    expect(observed.runDroid).toHaveBeenCalledTimes(2);
  });

  it("cancels an active Droid on interrupt, restores handlers and removes only its own lifecycle configuration", async () => {
    const f = fixture();
    const signalHandlers = { interrupt: process.listenerCount("SIGINT"), terminate: process.listenerCount("SIGTERM") };
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    observed.runDroid.mockImplementationOnce(async (_argv: string[], options: { signal: AbortSignal; handleProcessSignals: boolean }) => {
      expect(options.handleProcessSignals).toBe(false);
      expect(options.signal.aborted).toBe(false);
      entered();
      return new Promise<number>((resolve) => options.signal.addEventListener("abort", () => resolve(130), { once: true }));
    });
    const active = runLocal(f.argv, f.env); await running;
    process.emit("SIGINT");
    expect(await active).toBe(130);
    expect(observed.apps[0]!.app.server.listening).toBe(false);
    expect(JSON.parse(readFileSync(join(f.project, ".factory/hooks.json"), "utf8"))).toEqual({});
    for (const name of ["factory-hooks.json", "admin-token", "launcher.lock"]) expect(existsSync(join(f.state, name)), name).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(signalHandlers.interrupt);
    expect(process.listenerCount("SIGTERM")).toBe(signalHandlers.terminate);
    expect(Object.values(process.env)).not.toContain(providerKey);
    expect(await runLocal(f.argv, f.env)).toBe(0);
  });

  it("help, invalid options and missing explicit BYOK credentials do not create state or launch a process", async () => {
    const f = fixture();
    expect(parseLocalArgs(["--help"]).help).toBe(true);
    expect(await runLocal(["--help"], {})).toBe(0);
    expect(() => parseLocalArgs([f.project, "--api-key", providerKey])).toThrow();
    expect(() => parseLocalArgs([f.project, "--unknown"])).toThrow();
    expect(() => parseLocalArgs([f.project, "extra-project"])).toThrow();
    expect(() => parseLocalArgs([f.project, "--models", "glm-5.2,glm-5.2"])).toThrow();
    expect(() => parseLocalArgs([f.project, "--models", "glm-5.2", "--model", "glm-4.7"])).toThrow();
    const missing = { ...f.env }; delete missing.LOCAL_TEST_PROVIDER_KEY;
    await expect(runLocal(f.argv, missing)).rejects.toThrow();
    expect(observed.runDroid).not.toHaveBeenCalled(); expect(observed.apps).toHaveLength(0);
    expect(existsSync(f.state)).toBe(false); expect(existsSync(join(f.project, ".factory"))).toBe(false);
  });

  it("remembers real model choices and preserves different valid Mission selections on restart", async () => {
    const f = fixture();
    const argv = [f.project, "--base-url", "https://provider.invalid/anthropic", "--models", "glm-5.2,glm-4.7", "--model", "glm-5.2", "--key-env", "LOCAL_TEST_PROVIDER_KEY"];
    observed.runDroid.mockImplementationOnce(async (droidArgs: string[]) => {
      const path = argument(droidArgs, "--settings")!, settings = JSON.parse(readFileSync(path, "utf8"));
      expect(settings.customModels.map((model: { displayName: string }) => model.displayName)).toEqual(["GLM-5.2", "GLM-4.7"]);
      expect(settings.sessionDefaultSettings.model).toBe("custom:GLM-5.2-0");
      settings.sessionDefaultSettings.model = "custom:GLM-4.7-0";
      settings.missionOrchestratorModel = "custom:GLM-4.7-0";
      settings.missionModelSettings.workerModel = "custom:GLM-5.2-0";
      settings.missionModelSettings.validationWorkerModel = "custom:GLM-4.7-0";
      settings.missionModelSettings.skipUserTesting = true;
      writeFileSync(path, JSON.stringify(settings));
      return 0;
    });
    expect(await runLocal(argv, f.env)).toBe(0);
    expect(JSON.parse(readFileSync(join(f.state, "provider.json"), "utf8"))).toEqual({ baseUrl: "https://provider.invalid/anthropic", model: "glm-5.2", models: ["glm-5.2", "glm-4.7"] });
    observed.runDroid.mockImplementationOnce(async (droidArgs: string[]) => {
      const settings = JSON.parse(readFileSync(argument(droidArgs, "--settings")!, "utf8"));
      expect(settings.customModels).toHaveLength(2);
      expect(settings.sessionDefaultSettings.model).toBe("custom:GLM-4.7-0");
      expect(settings.missionOrchestratorModel).toBe("custom:GLM-4.7-0");
      expect(settings.missionModelSettings).toMatchObject({ workerModel: "custom:GLM-5.2-0", validationWorkerModel: "custom:GLM-4.7-0", skipUserTesting: true });
      expect(observed.apps[1]!.config.models?.map((model) => model.model)).toEqual(["glm-5.2", "glm-4.7"]);
      return 0;
    });
    expect(await runLocal([f.project, "--key-env", "LOCAL_TEST_PROVIDER_KEY"], f.env)).toBe(0);
  });

  it("refuses to ignore BRIDGE_AUTH when it disagrees with --auth", async () => {
    const f = fixture();
    await expect(runLocal(f.argv, { ...f.env, BRIDGE_AUTH: "subscription" })).rejects.toThrow(/does not match --auth byok/);
    expect(observed.apps).toHaveLength(0);
    expect(observed.runDroid).not.toHaveBeenCalled();
  });

  it("refuses an sk-ant- key for a third-party BYOK host before starting", async () => {
    const f = fixture();
    const secret = "sk-ant-offline-not-a-real-key";
    const env = { ...f.env, LOCAL_TEST_PROVIDER_KEY: secret };
    await expect(runLocal(f.argv, env)).rejects.toThrow(/outside anthropic.com/);
    expect(observed.apps).toHaveLength(0);
    const text = vi.mocked(process.stdout.write).mock.calls.map((call) => String(call[0])).join("");
    expect(text).not.toContain(secret);
  });
});
