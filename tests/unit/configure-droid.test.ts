import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDroid } from "../../scripts/configure-droid.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function paths(): { settings: string; backup: string; manifest: string; args: string[] } {
  const directory = mkdtempSync(join(tmpdir(), "relay-configure-"));
  directories.push(directory);
  const settings = join(directory, "settings.json");
  const manifest = join(directory, "manifest.env");
  return { settings, backup: `${settings}.relay-bridge.bak`, manifest, args: ["--settings", settings, "--manifest", manifest, "--models", "glm-5.2"] };
}

describe("configure Droid", () => {
  it("writes literal tokens privately, preserves other settings, and keeps the original backup across repeats", () => {
    const { settings, backup, args } = paths();
    const original = JSON.stringify({ theme: "dark", customModels: [{ model: "keep-me", apiKey: "original-key" }] });
    writeFileSync(settings, original, { mode: 0o644 });
    const token = "literal-key-for-test";
    const result = configureDroid(args, { BRIDGE_CLIENT_TOKEN: token });
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.customModels).toHaveLength(2);
    expect(parsed.customModels.slice(1).every((item: { apiKey: string }) => item.apiKey === token)).toBe(true);
    expect(readFileSync(settings, "utf8")).not.toContain("${BRIDGE_CLIENT_TOKEN}");
    expect(JSON.stringify(result)).not.toContain(token);
    expect(statSync(settings).mode & 0o777).toBe(0o600);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    configureDroid(args, { BRIDGE_CLIENT_TOKEN: "rotated-key" });
    expect(readFileSync(backup, "utf8")).toBe(original);
    configureDroid([...args, "--revert"], {});
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(statSync(settings).mode & 0o777).toBe(0o600);
  });

  it("removes the backup and marker on revert so the next configure takes a fresh backup", () => {
    const { settings, backup, args } = paths();
    writeFileSync(settings, '{"theme":"dark"}');
    configureDroid(args, { BRIDGE_CLIENT_TOKEN: "k" });
    configureDroid([...args, "--revert"], {});
    for (const path of [backup, `${backup}.absent`, `${settings}.relay-bridge.models.json`]) expect(existsSync(path)).toBe(false);
    expect(() => configureDroid([...args, "--revert"], {})).toThrow("No backup to revert.");
  });

  it("keeps user edits made between configure rounds and removes only the bridge's entries on revert", () => {
    const { settings, args } = paths();
    const userModel = { model: "my-model", displayName: "Mine", baseUrl: "https://user.invalid", apiKey: "user-key", provider: "anthropic" };
    writeFileSync(settings, JSON.stringify({ theme: "dark", customModels: [userModel] }));
    const first = readFileSync(settings, "utf8");
    configureDroid(args, { BRIDGE_CLIENT_TOKEN: "k1" });
    const reverted = configureDroid([...args, "--revert"], {});
    expect(reverted.outcome).toBe("restored");
    expect(readFileSync(settings, "utf8")).toBe(first);

    // The user keeps working, then configures again; the stale first backup must not come back.
    const edited = { ...JSON.parse(first), theme: "light", extra: { nested: [1, 2] } };
    writeFileSync(settings, JSON.stringify(edited));
    configureDroid(args, { BRIDGE_CLIENT_TOKEN: "k2" });
    const configured = JSON.parse(readFileSync(settings, "utf8"));
    configured.theme = "solarized"; configured.newSetting = true;
    configured.customModels.push({ model: "added-later", displayName: "Later", baseUrl: "https://later.invalid", apiKey: "later-key", provider: "anthropic" });
    writeFileSync(settings, JSON.stringify(configured));
    const result = configureDroid([...args, "--revert"], {});
    expect(result.outcome).toBe("removed-bridge-entries");
    expect(result.notice).toMatch(/changed after the last configure/);
    const final = JSON.parse(readFileSync(settings, "utf8"));
    expect(final.theme).toBe("solarized"); expect(final.newSetting).toBe(true); expect(final.extra).toEqual({ nested: [1, 2] });
    expect(final.customModels).toEqual([userModel, configured.customModels[2]]);
    expect(JSON.stringify(final)).not.toContain("glm-5.2");
    expect(final.sessionDefaultSettings.model).toBeUndefined();
    expect(final.missionOrchestratorModel).toBeUndefined();
    expect(final.missionModelSettings.workerModel).toBeUndefined(); expect(final.missionModelSettings.validationWorkerModel).toBeUndefined();
    expect(existsSync(`${settings}.relay-bridge.bak`)).toBe(false);
    expect(existsSync(`${settings}.relay-bridge.models.json`)).toBe(false);
  });

  it("keeps a user's selection of their own model and follows its renumbering after revert", () => {
    const { settings, args } = paths();
    const userModel = { model: "glm-5.2", displayName: "GLM-5.2", baseUrl: "https://user.invalid", apiKey: "user-key", provider: "anthropic" };
    writeFileSync(settings, JSON.stringify({ customModels: [userModel] }));
    configureDroid(args, { BRIDGE_CLIENT_TOKEN: "k1" });
    const configured = JSON.parse(readFileSync(settings, "utf8"));
    expect(configured.sessionDefaultSettings.model).toBe("custom:GLM-5.2-1");
    configured.sessionDefaultSettings.model = "custom:GLM-5.2-0"; configured.touched = 1;
    writeFileSync(settings, JSON.stringify(configured));
    configureDroid([...args, "--revert"], {});
    const final = JSON.parse(readFileSync(settings, "utf8"));
    expect(final.customModels).toEqual([userModel]);
    expect(final.sessionDefaultSettings.model).toBe("custom:GLM-5.2-0");
  });

  it("deletes a file the bridge created only if untouched, otherwise keeps user content", () => {
    const { settings, args } = paths();
    configureDroid(args, { BRIDGE_CLIENT_TOKEN: "k1" });
    const configured = JSON.parse(readFileSync(settings, "utf8"));
    configured.theme = "dark";
    writeFileSync(settings, JSON.stringify(configured));
    configureDroid([...args, "--revert"], {});
    expect(JSON.parse(readFileSync(settings, "utf8")).theme).toBe("dark");
    expect(JSON.parse(readFileSync(settings, "utf8")).customModels).toEqual([]);
    expect(existsSync(`${settings}.relay-bridge.bak.absent`)).toBe(false);
  });

  it("missing credentials do not create or change any files", () => {
    const { settings, backup, manifest, args } = paths();
    expect(() => configureDroid(args, {})).toThrow(/BRIDGE_CLIENT_TOKEN is required/);
    expect(existsSync(settings)).toBe(false);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(manifest)).toBe(false);
    writeFileSync(settings, '{"theme":"dark"}');
    expect(() => configureDroid(args, { BRIDGE_CLIENT_TOKEN: " " })).toThrow(/required/);
    expect(readFileSync(settings, "utf8")).toBe('{"theme":"dark"}');
  });

  it("restores absence when settings did not exist originally", () => {
    const { settings, args } = paths();
    configureDroid(args, { BRIDGE_CLIENT_TOKEN: "test-key" });
    configureDroid(args, { BRIDGE_CLIENT_TOKEN: "second-key" });
    configureDroid([...args, "--revert"], {});
    expect(existsSync(settings)).toBe(false);
  });

  it("rejects malformed settings without exposing their contents or changing them", () => {
    const { settings, backup, args } = paths();
    const original = '{"apiKey":"secret-sensitive-value",';
    writeFileSync(settings, original);
    expect(() => configureDroid(args, { BRIDGE_CLIENT_TOKEN: "test-key" })).toThrow("Invalid Droid settings JSON; settings were not changed.");
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(existsSync(backup)).toBe(false);
  });

  it("shows one real BYOK model rather than role aliases and emits canonical compatibility IDs", () => {
    const { settings, manifest, args } = paths();
    const result = configureDroid(args, { BRIDGE_CLIENT_TOKEN: "test-key" });
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.customModels).toHaveLength(1);
    expect(parsed.customModels[0]).toMatchObject({ model: "glm-5.2", displayName: "GLM-5.2" });
    expect(parsed.customModels[0].extraHeaders).toBeUndefined();
    expect(parsed.sessionDefaultSettings.model).toBe("custom:GLM-5.2-0");
    expect(parsed.missionOrchestratorModel).toBe(parsed.sessionDefaultSettings.model);
    expect(parsed.missionModelSettings.workerModel).toBe(parsed.sessionDefaultSettings.model);
    expect(parsed.missionModelSettings.validationWorkerModel).toBe(parsed.sessionDefaultSettings.model);
    expect(readFileSync(manifest, "utf8")).toContain("DROID_WORKER_MODEL_ID=custom:GLM-5.2-0");
    expect(result.modelIds).toEqual(["glm-5.2"]);
    const metadata = `${settings}.relay-bridge.models.json`;
    expect(statSync(metadata).mode & 0o777).toBe(0o600);
    expect(readFileSync(metadata, "utf8")).not.toContain("test-key");
    configureDroid([...args, "--revert"], {});
    expect(existsSync(metadata)).toBe(false);
  });

  it("migrates the old generated role menu and its references while preserving unrelated user models", () => {
    const { settings, args } = paths();
    const roles = [["probe", "Probe", "chat"], ["chat", "Chat", "chat"], ["orchestrator", "Orchestrator", "orchestrator"], ["worker", "Worker", "worker"], ["validator", "Validator", "validator"]];
    const userModel = { model: "relay-chat", displayName: "My private model", baseUrl: "https://user.invalid", apiKey: "user-key", provider: "anthropic" };
    writeFileSync(settings, JSON.stringify({ customModels: [...roles.map(([name, label, role]) => ({ model: `relay-${name}`, displayName: `Relay ${label}`,
      baseUrl: "http://127.0.0.1:18787", apiKey: "old-token", provider: "anthropic", authMode: "bearer", maxOutputTokens: 4096, extraHeaders: { "X-Bridge-Role": role } })), userModel],
      model: "custom:Relay-Chat-0", missionOrchestratorModel: "custom:Relay-Orchestrator-0",
      missionModelSettings: { workerModel: "custom:Relay-Worker-0", validationWorkerModel: "custom:Relay-Validator-0", skipScrutiny: true, workerReasoningEffort: "high" } }));
    configureDroid(args, { BRIDGE_CLIENT_TOKEN: "new-token" });
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.customModels).toHaveLength(2); expect(parsed.customModels[0]).toEqual(userModel);
    expect(parsed.customModels.map((model: { displayName: string }) => model.displayName)).toEqual(["My private model", "GLM-5.2"]);
    expect(parsed.sessionDefaultSettings.model).toBe("custom:GLM-5.2-0"); expect(parsed.missionOrchestratorModel).toBe(parsed.sessionDefaultSettings.model);
    expect(parsed.missionModelSettings).toMatchObject({ workerModel: parsed.sessionDefaultSettings.model, validationWorkerModel: parsed.sessionDefaultSettings.model, skipScrutiny: true, workerReasoningEffort: "high" });
  });

  it("keeps different valid Mission choices across token/port rotation and migrates a removed model", () => {
    const { settings, args } = paths();
    const multiple = [...args.slice(0, -2), "--models", "glm-5.2,glm-4.7"];
    configureDroid(multiple, { BRIDGE_CLIENT_TOKEN: "first-key" });
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    parsed.sessionDefaultSettings.model = "custom:GLM-4.7-0"; parsed.missionOrchestratorModel = "custom:GLM-4.7-0";
    parsed.missionModelSettings = { workerModel: "custom:GLM-5.2-0", validationWorkerModel: "custom:GLM-4.7-0", skipUserTesting: true };
    writeFileSync(settings, JSON.stringify(parsed));
    configureDroid([...multiple, "--base-url", "http://127.0.0.1:21212", "--model", "glm-5.2"], { BRIDGE_CLIENT_TOKEN: "rotated-key" });
    const rotated = JSON.parse(readFileSync(settings, "utf8"));
    expect(rotated.customModels).toHaveLength(2);
    expect(rotated.customModels.every((model: { apiKey: string; baseUrl: string }) => model.apiKey === "rotated-key" && model.baseUrl === "http://127.0.0.1:21212")).toBe(true);
    expect(rotated.sessionDefaultSettings.model).toBe("custom:GLM-5.2-0");
    expect(rotated.missionOrchestratorModel).toBe("custom:GLM-4.7-0");
    expect(rotated.missionModelSettings).toMatchObject(parsed.missionModelSettings);
    configureDroid(args, { BRIDGE_CLIENT_TOKEN: "third-key" });
    const reduced = JSON.parse(readFileSync(settings, "utf8"));
    expect(reduced.customModels).toHaveLength(1); expect(reduced.missionOrchestratorModel).toBe("custom:GLM-5.2-0");
    expect(reduced.missionModelSettings.validationWorkerModel).toBe("custom:GLM-5.2-0");
  });

  it("does not overwrite a user's same-name model and counts duplicate labels for canonical IDs", () => {
    const { settings, args } = paths();
    const userModel = { model: "glm-5.2", displayName: "GLM-5.2", baseUrl: "https://user.invalid", apiKey: "user-key", provider: "anthropic" };
    writeFileSync(settings, JSON.stringify({ customModels: [userModel], model: "custom:GLM-5.2-0", missionOrchestratorModel: "custom:GLM-5.2-0" }));
    configureDroid([...args, "--model", "glm-5.2"], { BRIDGE_CLIENT_TOKEN: "local-token" });
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.customModels[0]).toEqual(userModel); expect(parsed.customModels).toHaveLength(2);
    expect(parsed.sessionDefaultSettings.model).toBe("custom:GLM-5.2-1"); expect(parsed.missionOrchestratorModel).toBe("custom:GLM-5.2-0");
    configureDroid(args, { BRIDGE_CLIENT_TOKEN: "rotated" });
    expect(JSON.parse(readFileSync(settings, "utf8")).customModels).toHaveLength(2);
  });

  it("preserves canonical session defaults over obsolete top-level settings", () => {
    const { settings, args } = paths();
    const multiple = [...args.slice(0, -2), "--models", "glm-5.2,glm-4.7"];
    configureDroid(multiple, { BRIDGE_CLIENT_TOKEN: "first-key" });
    const current = JSON.parse(readFileSync(settings, "utf8"));
    current.model = "custom:Relay-Chat-0";
    current.specModeModel = "custom:Relay-Worker-0";
    current.sessionDefaultSettings = { model: "custom:GLM-4.7-0", reasoningEffort: "high", specModeModel: null };
    writeFileSync(settings, JSON.stringify(current));
    configureDroid(multiple, { BRIDGE_CLIENT_TOKEN: "second-key" });
    const updated = JSON.parse(readFileSync(settings, "utf8"));
    expect(updated.model).toBeUndefined(); expect(updated.specModeModel).toBeUndefined();
    expect(updated.sessionDefaultSettings).toEqual(current.sessionDefaultSettings);
  });

  it("recognizes managed models after official Droid adds derived IDs, indexes and image defaults", () => {
    const { settings, args } = paths();
    const multiple = [...args.slice(0, -2), "--models", "glm-5.2,glm-4.7"];
    configureDroid(multiple, { BRIDGE_CLIENT_TOKEN: "first-key" });
    const current = JSON.parse(readFileSync(settings, "utf8"));
    current.customModels.forEach((model: Record<string, unknown>, index: number) => {
      model.id = `custom:${model.displayName}-0`; model.index = index; model.noImageSupport = false;
    });
    current.sessionDefaultSettings.model = "custom:GLM-4.7-0";
    current.missionModelSettings.workerModel = "custom:GLM-4.7-0";
    writeFileSync(settings, JSON.stringify(current));
    configureDroid([...multiple, "--base-url", "http://127.0.0.1:21213"], { BRIDGE_CLIENT_TOKEN: "rotated-key" });
    const updated = JSON.parse(readFileSync(settings, "utf8"));
    expect(updated.customModels).toHaveLength(2);
    expect(updated.customModels.map((model: { model: string }) => model.model)).toEqual(["glm-5.2", "glm-4.7"]);
    expect(updated.customModels.every((model: { apiKey: string; baseUrl: string }) => model.apiKey === "rotated-key" && model.baseUrl === "http://127.0.0.1:21213")).toBe(true);
    expect(updated.sessionDefaultSettings.model).toBe("custom:GLM-4.7-0");
    expect(updated.missionModelSettings.workerModel).toBe("custom:GLM-4.7-0");
  });

  it("anthropic-api defaults to the same Claude aliases and cloud still requires explicit ids", () => {
    const { settings, args } = paths();
    configureDroid([...args.slice(0, -2), "--auth", "anthropic-api"], { BRIDGE_CLIENT_TOKEN: "local-token" });
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.customModels.map((model: { model: string; displayName: string }) => [model.model, model.displayName])).toEqual([
      ["sonnet", "Claude Sonnet"], ["opus", "Claude Opus"], ["haiku", "Claude Haiku"],
    ]);
    expect(() => configureDroid(args.slice(0, -2), { BRIDGE_CLIENT_TOKEN: "local-token", BRIDGE_AUTH: "cloud" })).toThrow(/explicit actual model/);
    expect(() => configureDroid([...args.slice(0, -2), "--auth", "nope"], { BRIDGE_CLIENT_TOKEN: "local-token" })).toThrow(/--auth/);
  });

  it("subscription configuration exposes real Claude aliases without touching subscription credentials", () => {
    const { settings, args } = paths();
    const env = { BRIDGE_CLIENT_TOKEN: "local-token", ANTHROPIC_AUTH_TOKEN: "do-not-use-or-change", BRIDGE_UPSTREAM_MODEL: "glm-5.2" };
    configureDroid([...args.slice(0, -2), "--auth", "subscription"], env);
    const parsed = JSON.parse(readFileSync(settings, "utf8"));
    expect(parsed.customModels.map((model: { model: string }) => model.model)).toEqual(["sonnet", "opus", "haiku"]);
    expect(parsed.customModels.map((model: { displayName: string }) => model.displayName)).toEqual(["Claude Sonnet", "Claude Opus", "Claude Haiku"]);
    expect(parsed.sessionDefaultSettings.model).toBe("custom:Claude-Sonnet-0");
    expect(readFileSync(settings, "utf8")).not.toContain(env.ANTHROPIC_AUTH_TOKEN); expect(env.ANTHROPIC_AUTH_TOKEN).toBe("do-not-use-or-change");
  });

  it("rejects missing real model selection, invalid catalogs and defaults before changing files", () => {
    const { settings, args } = paths();
    const plain = args.slice(0, -2), env = { BRIDGE_CLIENT_TOKEN: "test-key" };
    expect(() => configureDroid(plain, env)).toThrow(/explicit actual model/);
    for (const extra of [["--models", "glm-5.2,glm-5.2"], ["--models", "glm-5.2", "--model", "glm-4.7"], ["--bogus", "x"], ["--models", "glm-5.2\nmodel:x"]]) {
      expect(() => configureDroid([...plain, ...extra], env)).toThrow();
      expect(existsSync(settings)).toBe(false);
    }
  });
});
