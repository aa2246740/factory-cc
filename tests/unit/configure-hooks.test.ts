import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHookConfigPath, planHooksConfiguration } from "../../scripts/configure-hooks.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relay-hooks-project-"))); directories.push(root);
  mkdirSync(join(root, ".factory"));
  return root;
}

describe("configure-hooks paths", () => {
  it("defaults the private config to the bridge repository, whatever the working directory", () => {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const cwd = project();
    const plan = planHooksConfiguration([], cwd);
    expect(plan.configPath).toBe(defaultHookConfigPath);
    expect(plan.configPath).toBe(join(repository, "tmp/bridge-data/factory-hooks.json"));
    expect(plan.hooksPath).toBe(join(cwd, ".factory/hooks.json"));
    expect(relative(cwd, plan.configPath).startsWith("..")).toBe(true);
    // Same result from another working directory: it is not derived from cwd.
    expect(planHooksConfiguration([], project()).configPath).toBe(plan.configPath);
  });

  it("refuses a config path inside the target project, including via a symlink or a not-yet-existing directory", () => {
    const root = project(), outside = project();
    const hooks = join(root, ".factory/hooks.json");
    for (const config of [join(root, "tmp/hooks.json"), join(root, ".factory/hooks-config.json"), join(root, "new-dir/deeper/hooks.json")]) {
      expect(() => planHooksConfiguration(["--hooks", hooks, "--config", config], outside), config).toThrow(/inside the project/);
    }
    symlinkSync(root, join(outside, "alias"));
    expect(() => planHooksConfiguration(["--hooks", hooks, "--config", join(outside, "alias/hooks.json")], outside)).toThrow(/inside the project/);
    expect(() => planHooksConfiguration(["--hooks", hooks, "--config", "tmp/hooks.json"], root)).toThrow(/inside the project/);
    expect(planHooksConfiguration(["--hooks", hooks, "--config", join(outside, "hooks-config.json")], root).configPath).toBe(join(outside, "hooks-config.json"));
    // Sibling with a common prefix is not inside.
    expect(() => planHooksConfiguration(["--hooks", hooks, "--config", `${root}-sibling/hooks.json`], outside)).not.toThrow();
  });

  it("still allows removing a configuration an older version kept inside the project", () => {
    const root = project();
    expect(planHooksConfiguration(["--remove", "--hooks", join(root, ".factory/hooks.json"), "--config", join(root, "tmp/bridge-data/factory-hooks.json")], root).remove).toBe(true);
  });

  it("errors on a flag with no value, a flag followed by another flag, duplicates and unknown options", () => {
    const cwd = project();
    for (const flag of ["--config", "--hooks", "--base-url"]) {
      expect(() => planHooksConfiguration([flag], cwd), flag).toThrow(`Missing value for ${flag}.`);
      expect(() => planHooksConfiguration([flag, "--remove"], cwd), flag).toThrow(`Missing value for ${flag}.`);
    }
    expect(() => planHooksConfiguration(["--config", "a", "--config", "b"], cwd)).toThrow(/Duplicate/);
    expect(() => planHooksConfiguration(["--confg", "x"], cwd)).toThrow(/Unknown option/);
  });
});
