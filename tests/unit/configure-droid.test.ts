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
  return { settings, backup: `${settings}.relay-bridge.bak`, manifest, args: ["--settings", settings, "--manifest", manifest] };
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
    expect(parsed.customModels).toHaveLength(6);
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
});
