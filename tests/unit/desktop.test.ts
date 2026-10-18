import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktop, desktopPaths, type DesktopDependencies } from "../../scripts/desktop.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-desktop-")); roots.push(root);
  const home = join(root, "home'&"), repo = join(root, "repo"), node = join(root, "node");
  mkdirSync(join(home, ".claude"), { recursive: true }); mkdirSync(join(repo, "dist"), { recursive: true });
  writeFileSync(join(repo, "dist/index.js"), ""); writeFileSync(node, "");
  // A helper that must never execute, even during install and restart.
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ apiKeyHelper: `touch ${join(root, "HELPER-RAN")}`, env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "fixture-sonnet" } }));
  const run = vi.fn<DesktopDependencies["run"]>(() => ({ status: 0 }));
  const deps: DesktopDependencies = { home, repo, node, path: "/fixture/bin:&/usr/bin", uid: 501, platform: "darwin", run,
    assertPortFree: vi.fn(async () => {}), health: vi.fn(async () => true), sleep: vi.fn(async () => {}) };
  return { root, deps, paths: desktopPaths(home), run };
}
it("installs built Node service, private token files and helper models without executing helper", async () => {
  const { deps, paths, root, run } = fixture();
  const result = await desktop(["install", "--port", "19876"], deps);
  const plist = readFileSync(paths.plist, "utf8");
  expect(plist).toContain("dist/index.js"); expect(plist).not.toContain("tsx");
  expect(plist).toContain("claude-config"); expect(plist).toContain("127.0.0.1"); expect(plist).toContain("19876");
  expect(plist).toContain("<string>ask</string>"); expect(plist).toContain("BRIDGE_DESKTOP");
  expect(plist).toContain("/fixture/bin:&amp;/usr/bin"); expect(plist).toContain("<integer>30</integer>");
  expect(plist).not.toContain("apiKeyHelper"); expect(plist).not.toContain("fixture-sonnet");
  expect(statSync(paths.state).mode & 0o777).toBe(0o700);
  for (const path of [paths.token, paths.admin, paths.hook, paths.plist, paths.settings, paths.manifest, join(paths.state, "stdout.log")]) expect(statSync(path).mode & 0o777).toBe(0o600);
  const tokens = [paths.token, paths.admin, paths.hook].map((path) => readFileSync(path, "utf8").trim());
  expect(new Set(tokens).size).toBe(3);
  for (const token of tokens) expect(plist).not.toContain(token);
  // Droid strips apiKeyHelper from the runtime settings Mission workers load, so
  // the 0600 settings carry the loopback client token, never admin or hook authority.
  const settings = JSON.parse(readFileSync(paths.settings, "utf8"));
  expect(settings.customModels).toHaveLength(1);
  // A pinned direct-tool base keeps Droid's Script mode away from names like claude-opus-5-5.
  expect(settings.customModels[0]).toMatchObject({ model: "sonnet", apiKey: tokens[0], authMode: "bearer", baseModelId: "claude-sonnet-5-5" });
  expect(settings.customModels[0].apiKeyHelper).toBeUndefined();
  for (const token of tokens.slice(1)) expect(readFileSync(paths.settings, "utf8")).not.toContain(token);
  expect(existsSync(join(root, "HELPER-RAN"))).toBe(false);
  expect(run).toHaveBeenLastCalledWith("launchctl", ["bootstrap", "gui/501", paths.plist]);
  expect(deps.assertPortFree).toHaveBeenCalledExactlyOnceWith(19876);
  expect(result.uninstall).toBe("npm run desktop -- uninstall");
  expect(existsSync(join(deps.home, ".factory/hooks.json"))).toBe(false);
});
it("preserves original settings and later user edits on surgical uninstall", async () => {
  const { deps, paths } = fixture(); mkdirSync(join(deps.home, ".factory"));
  writeFileSync(paths.settings, JSON.stringify({ customModels: [{ model: "mine", displayName: "Mine" }], hooks: { original: true } }));
  await desktop(["install"], deps);
  const settings = JSON.parse(readFileSync(paths.settings, "utf8")); settings.theme = "dark";
  settings.customModels.push({ model: "later" }); writeFileSync(paths.settings, JSON.stringify(settings));
  await desktop(["uninstall"], deps);
  const after = JSON.parse(readFileSync(paths.settings, "utf8"));
  expect(after.customModels.map((model: { model: string }) => model.model)).toEqual(["mine", "later"]);
  expect(after.theme).toBe("dark"); expect(after.hooks).toEqual({ original: true });
  expect(existsSync(paths.state)).toBe(false); expect(existsSync(paths.plist)).toBe(false);
  expect(existsSync(`${paths.settings}.relay-bridge.bak`)).toBe(false);
});
it("restores absent settings and supports repeated uninstall", async () => {
  const { deps, paths } = fixture(); await desktop(["install"], deps); await desktop(["uninstall"], deps);
  expect(existsSync(paths.settings)).toBe(false); expect(await desktop(["uninstall"], deps)).toMatchObject({ installed: false });
});
it("restart re-reads the catalog and preserves unrelated models", async () => {
  const { deps, paths, run } = fixture(); await desktop(["install"], deps);
  writeFileSync(join(deps.home, ".claude/settings.json"), JSON.stringify({ apiKeyHelper: "never-run", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "fixture-opus" } }));
  await desktop(["restart"], deps);
  expect(JSON.parse(readFileSync(paths.settings, "utf8")).customModels.map((v: { model: string }) => v.model)).toEqual(["opus"]);
  expect(run.mock.calls.slice(-2)).toEqual([["launchctl", ["bootout", "gui/501/ai.factory-cc.bridge"]], ["launchctl", ["bootstrap", "gui/501", paths.plist]]]);
});
it("status checks only the registered port and reports unavailable external repository", async () => {
  const { deps, paths } = fixture(); await desktop(["install"], deps); rmSync(join(deps.repo, "dist/index.js"));
  expect(await desktop(["status"], deps)).toMatchObject({ loaded: true, plistPresent: true, healthy: true, repositoryPresent: false });
  expect(deps.health).toHaveBeenCalledExactlyOnceWith(18787);
  await expect(desktop(["restart"], deps)).rejects.toThrow("unmounted"); expect(existsSync(paths.plist)).toBe(true);
});
it("status warns when Droid's cached Script-mode list includes the pinned base model", async () => {
  const { deps } = fixture(); await desktop(["install"], deps);
  const flags = (models: string[]) => { mkdirSync(join(deps.home, ".factory/cache"), { recursive: true });
    writeFileSync(join(deps.home, ".factory/cache/feature-flags.json"), JSON.stringify({ configs: { script_tool_models: { models } } })); };
  expect(await desktop(["status"], deps)).not.toHaveProperty("warning");
  flags(["claude-opus-5-5", "gpt-6.1-sol"]);
  expect(await desktop(["status"], deps)).not.toHaveProperty("warning");
  flags(["claude-opus-5-5", "claude-sonnet-5-5"]);
  expect(await desktop(["status"], deps)).toMatchObject({ warning: expect.stringContaining("Script mode") });
});
it("busy port fails before writing state or changing settings", async () => {
  const { deps, paths } = fixture(); deps.assertPortFree = async () => { throw new Error("busy"); };
  await expect(desktop(["install"], deps)).rejects.toThrow("busy");
  expect(existsSync(paths.state)).toBe(false); expect(existsSync(paths.settings)).toBe(false);
});
it("bootstrap failure rolls back owned files and exact original settings", async () => {
  const { deps, paths, run } = fixture(); mkdirSync(join(deps.home, ".factory")); writeFileSync(paths.settings, '{"theme":"original"}\n');
  run.mockImplementation((command) => ({ status: command === "launchctl" ? 5 : 0 }));
  await expect(desktop(["install"], deps)).rejects.toThrow("bootstrap failed");
  expect(readFileSync(paths.settings, "utf8")).toBe('{"theme":"original"}\n'); expect(existsSync(paths.state)).toBe(false);
});
it("refuses deletion when bootout fails or state ownership is absent", async () => {
  const { deps, paths, run } = fixture(); await desktop(["install"], deps);
  run.mockReturnValue({ status: 5 }); await expect(desktop(["uninstall"], deps)).rejects.toThrow("preserved");
  expect(existsSync(paths.token)).toBe(true);
  rmSync(paths.manifest); await expect(desktop(["uninstall"], deps)).rejects.toThrow("Unrecognized");
});
it.each(["0", "65536", "garbage"])("rejects invalid port %s", async (port) => {
  const { deps } = fixture(); await expect(desktop(["install", "--port", port], deps)).rejects.toThrow();
});
it("rejects literal-only Claude credentials offline without creating state", async () => {
  const { deps, paths } = fixture(); writeFileSync(join(deps.home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "fixture-not-real" } }));
  await expect(desktop(["install"], deps)).rejects.toThrow("Literal settings credentials"); expect(existsSync(paths.state)).toBe(false);
});

function selection(label: string, index = 0): string { return `custom:${label.trim().replace(/\s+/g, "-")}-${index}`; }
function realisticSettings() {
  return { model: "factory-default", specModeModel: "factory-spec", missionOrchestratorModel: "factory-orchestrator",
    sessionDefaultSettings: { model: "factory-default", specModeModel: null, reasoningEffort: "high" },
    missionModelSettings: { workerModel: "factory-worker", validationWorkerModel: "custom:Duplicate-1", skipScrutiny: true, workerReasoningEffort: "high" },
    customModels: [{ model: "mine", displayName: "Duplicate" }, { model: "other", displayName: "Duplicate" }],
    theme: "dark", hooks: { original: true }, unrelated: { nested: [1, false, null] } };
}
it("only appends models to realistic desktop settings and restores the exact original bytes", async () => {
  const { deps, paths } = fixture(); mkdirSync(join(deps.home, ".factory"));
  const original = realisticSettings(), bytes = JSON.stringify(original, null, 4) + "\n\n";
  writeFileSync(paths.settings, bytes);
  await desktop(["install"], deps);
  const installed = JSON.parse(readFileSync(paths.settings, "utf8"));
  expect(installed.customModels.slice(0, 2)).toEqual(original.customModels);
  expect(installed.customModels).toHaveLength(3);
  const { customModels: _models, ...other } = installed;
  const { customModels: _originalModels, ...originalOther } = original;
  expect(other).toEqual(originalOther);
  await desktop(["restart"], deps);
  expect(JSON.parse(readFileSync(paths.settings, "utf8"))).toEqual(installed);
  await desktop(["uninstall"], deps);
  expect(readFileSync(paths.settings, "utf8")).toBe(bytes);
});
it("does not create absent selection containers or defaults", async () => {
  const { deps, paths } = fixture(); await desktop(["install"], deps);
  expect(Object.keys(JSON.parse(readFileSync(paths.settings, "utf8")))).toEqual(["customModels"]);
});
it("restart remaps kept duplicate labels and surviving owned models, dropping removed owned selections", async () => {
  const { deps, paths } = fixture();
  writeFileSync(join(deps.home, ".claude/settings.json"), JSON.stringify({ apiKeyHelper: "never-run", env: {
    ANTHROPIC_DEFAULT_SONNET_MODEL: "fixture-sonnet", ANTHROPIC_DEFAULT_OPUS_MODEL: "fixture-opus" } }));
  await desktop(["install"], deps);
  const current = JSON.parse(readFileSync(paths.settings, "utf8"));
  const sonnet = current.customModels.find((v: { model: string }) => v.model === "sonnet");
  const opus = current.customModels.find((v: { model: string }) => v.model === "opus");
  // Droid adds derived IDs; a user adds a same-label model after the owned one.
  sonnet.id = selection(sonnet.displayName); opus.id = selection(opus.displayName);
  const mine = { model: "mine", displayName: sonnet.displayName };
  current.customModels.push(mine);
  current.model = selection(sonnet.displayName, 1);
  current.specModeModel = opus.id;
  current.sessionDefaultSettings = { model: sonnet.id, specModeModel: opus.id, reasoningEffort: "high" };
  current.missionOrchestratorModel = "factory-orchestrator";
  current.missionModelSettings = { workerModel: sonnet.id, validationWorkerModel: opus.id, skipUserTesting: true };
  writeFileSync(paths.settings, JSON.stringify(current));
  // Same Bridge ID survives with a changed mapped version/display name.
  writeFileSync(join(deps.home, ".claude/settings.json"), JSON.stringify({ apiKeyHelper: "never-run", env: { ANTHROPIC_DEFAULT_SONNET_MODEL: "fixture-sonnet-new" } }));
  await desktop(["restart"], deps);
  const updated = JSON.parse(readFileSync(paths.settings, "utf8"));
  expect(updated.customModels[0]).toEqual(mine);
  expect(updated.customModels.map((v: { model: string }) => v.model)).toEqual(["mine", "sonnet"]);
  expect(updated.model).toBe(selection(mine.displayName));
  expect(updated).not.toHaveProperty("specModeModel");
  const newSonnet = selection(updated.customModels[1].displayName);
  expect(updated.sessionDefaultSettings).toEqual({ model: newSonnet, reasoningEffort: "high" });
  expect(updated.missionOrchestratorModel).toBe("factory-orchestrator");
  expect(updated.missionModelSettings).toEqual({ workerModel: newSonnet, skipUserTesting: true });
});
it("uninstall after a desktop edit removes owned selections and keeps all other settings", async () => {
  const { deps, paths } = fixture(); mkdirSync(join(deps.home, ".factory"));
  const original = realisticSettings(); writeFileSync(paths.settings, JSON.stringify(original));
  await desktop(["install"], deps);
  const edited = JSON.parse(readFileSync(paths.settings, "utf8"));
  const bridge = edited.customModels[2]; bridge.id = selection(bridge.displayName);
  const later = { model: "later", displayName: bridge.displayName };
  edited.customModels.push(later); edited.theme = "light";
  edited.model = bridge.id; edited.specModeModel = selection(bridge.displayName, 1);
  edited.sessionDefaultSettings.specModeModel = bridge.id;
  edited.missionModelSettings.workerModel = bridge.id;
  writeFileSync(paths.settings, JSON.stringify(edited));
  await desktop(["uninstall"], deps);
  const after = JSON.parse(readFileSync(paths.settings, "utf8"));
  const expected: Record<string, unknown> = { ...original, theme: "light", customModels: [...original.customModels, later],
    specModeModel: selection(later.displayName), sessionDefaultSettings: { model: "factory-default", reasoningEffort: "high" },
    missionModelSettings: { validationWorkerModel: "custom:Duplicate-1", skipScrutiny: true, workerReasoningEffort: "high" } };
  delete expected.model;
  expect(after).toEqual(expected);
});
it("labels all desktop aliases as Claude Code without changing model IDs", async () => {
  const { deps, paths } = fixture();
  writeFileSync(join(deps.home, ".claude/settings.json"), JSON.stringify({ apiKeyHelper: "never-run", env: {
    ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5-5", ANTHROPIC_DEFAULT_OPUS_MODEL: "fixture-opus",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "fixture-haiku", ANTHROPIC_DEFAULT_FABLE_MODEL: "fixture-fable" } }));
  await desktop(["install"], deps);
  const models = JSON.parse(readFileSync(paths.settings, "utf8")).customModels;
  expect(models.map((v: { model: string; displayName: string }) => [v.model, v.displayName])).toEqual([
    ["opus", "Claude Code · Opus (fixture-opus)"], ["sonnet", "Claude Code · Sonnet (claude-sonnet-5-5)"],
    ["haiku", "Claude Code · Haiku (fixture-haiku)"], ["fable", "Claude Code · Fable (fixture-fable)"],
  ]);
});
it("labels unmapped desktop defaults as Claude Code", async () => {
  const { deps, paths } = fixture();
  writeFileSync(join(deps.home, ".claude/settings.json"), JSON.stringify({ apiKeyHelper: "never-run" }));
  await desktop(["install"], deps);
  expect(JSON.parse(readFileSync(paths.settings, "utf8")).customModels.map((v: { displayName: string }) => v.displayName))
    .toEqual(["Claude Code · Sonnet", "Claude Code · Opus", "Claude Code · Haiku"]);
});
it.each(["restart", "status"])("%s explains how to install when the state or manifest is absent", async (action) => {
  const { deps, paths, run } = fixture();
  const message = "Bridge desktop is not installed; run npm run desktop -- install.";
  await expect(desktop([action], deps)).rejects.toThrow(message);
  mkdirSync(paths.state, { recursive: true });
  await expect(desktop([action], deps)).rejects.toThrow(message);
  expect(run).not.toHaveBeenCalled(); expect(deps.health).not.toHaveBeenCalled();
});
it("pins explicit Droid models without touching Claude Code settings, and restart can change or keep them", async () => {
  const { deps, paths, root } = fixture();
  const claudeSettings = JSON.stringify({ apiKeyHelper: "never-run", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6", ANTHROPIC_DEFAULT_FABLE_MODEL: "gpt-6.1-sol" } });
  writeFileSync(join(deps.home, ".claude/settings.json"), claudeSettings);
  const result = await desktop(["install", "--models", "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5"], deps);
  const entries = () => JSON.parse(readFileSync(paths.settings, "utf8")).customModels.map((v: { model: string; displayName: string }) => [v.model, v.displayName]);
  expect(entries()).toEqual([
    ["claude-opus-5-5", "Claude Code · Opus 5.5 (claude-opus-5-5)"], ["claude-sonnet-5-5", "Claude Code · Sonnet 5.5 (claude-sonnet-5-5)"],
    ["claude-haiku-5-5", "Claude Code · Haiku 5.5 (claude-haiku-5-5)"],
  ]);
  expect(readFileSync(paths.plist, "utf8")).toContain("<key>BRIDGE_MODELS</key><string>claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5</string>");
  expect(readFileSync(join(deps.home, ".claude/settings.json"), "utf8")).toBe(claudeSettings);
  expect(JSON.stringify(result)).not.toContain("gpt-6.1-sol");
  await desktop(["restart"], deps);
  expect(entries().map(([model]: [string]) => model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  await desktop(["restart", "--models", "claude-sonnet-5-5,claude-opus-5-5"], deps);
  expect(entries().map(([model]: [string]) => model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
  expect(readFileSync(paths.plist, "utf8")).toContain("<string>claude-sonnet-5-5,claude-opus-5-5</string>");
  expect(JSON.parse(readFileSync(paths.manifest, "utf8")).models).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
  for (const path of [paths.manifest, paths.plist]) expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(existsSync(join(root, "HELPER-RAN"))).toBe(false);
});
it.each([
  [["restart", "--port", "19876"]], [["install", "--models", ""]], [["install", "--models", "a,a"]],
  [["install", "--models", "a", "--models", "b"]], [["status", "--models", "a"]], [["install", "--port"]],
])("rejects invalid desktop options %j", async (argv) => {
  const { deps, paths } = fixture();
  await expect(desktop(argv, deps)).rejects.toThrow();
  expect(existsSync(paths.state)).toBe(false);
});
it("restart retries bootstrap while launchd is still removing the old job", async () => {
  const { deps, paths, run } = fixture(); await desktop(["install"], deps);
  let refusals = 2;
  run.mockImplementation((_command, args) => ({ status: args[0] === "bootstrap" && refusals-- > 0 ? 5 : 0 }));
  await desktop(["restart"], deps);
  expect(run.mock.calls.filter(([, args]) => args[0] === "bootstrap").slice(-3)).toEqual(Array(3).fill(["launchctl", ["bootstrap", "gui/501", paths.plist]]));
  expect(deps.sleep).toHaveBeenCalledTimes(2);
});
