import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDroid, DROID_MAX_OUTPUT_TOKENS } from "../../scripts/configure-droid.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("writes the output ceiling and leaves Droid's default context limit", () => {
  const directory = mkdtempSync(join(tmpdir(), "relay-configure-limits-"));
  directories.push(directory);
  const settings = join(directory, "settings.json");
  const catalog = [
    { id: "sonnet", model: "sonnet", displayName: "Claude Code · Sonnet" },
    { id: "opus", model: "opus", displayName: "Claude Code · Opus" },
  ];
  configureDroid(["--settings", settings, "--manifest", join(directory, "manifest.env"), "--preserve-selections"], { BRIDGE_CLIENT_TOKEN: "test" }, catalog);
  const models = JSON.parse(readFileSync(settings, "utf8")).customModels as Array<Record<string, unknown>>;
  expect(models.map((model) => model.maxOutputTokens)).toEqual([DROID_MAX_OUTPUT_TOKENS, DROID_MAX_OUTPUT_TOKENS]);
  for (const model of models) expect(model).not.toHaveProperty("maxContextLimit");
});
