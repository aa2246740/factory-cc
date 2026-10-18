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
    assertPortFree: vi.fn(async () => {}), health: vi.fn(async () => true) };
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
  for (const token of tokens) { expect(plist).not.toContain(token); expect(readFileSync(paths.settings, "utf8")).not.toContain(token); }
  const settings = JSON.parse(readFileSync(paths.settings, "utf8"));
  expect(settings.customModels).toHaveLength(1);
  expect(settings.customModels[0]).toMatchObject({ model: "sonnet", apiKeyHelperTtlMs: 300000, authMode: "bearer" });
  expect(settings.customModels[0].apiKey).toBeUndefined(); expect(settings.customModels[0].apiKeyHelper).toContain("/bin/cat '");
  expect(settings.customModels[0].apiKeyHelper).toContain("'\\''");
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
