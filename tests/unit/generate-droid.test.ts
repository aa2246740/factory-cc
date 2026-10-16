import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDroid, installDroidCommand, parseGenerateDroidArgs, validateGeneratedDroid } from "../../scripts/generate-droid.js";

const roots: string[] = [];
const own = () => { const root = mkdtempSync(join(tmpdir(), "relay-droid-generator-test-")); roots.push(root); return root; };
afterEach(() => { vi.unstubAllGlobals(); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
function args(cwd: string) { return parseGenerateDroidArgs(["--cwd", cwd, "--name", "json-auditor", "--description", "Read and audit fixture JSON."]); }
describe("local BYOK Droid generation", () => {
  it("rejects path traversal, unexpected model routes and tool capability injection", () => {
    for (const extra of [["--name", "../escape"], ["--model", "claude-paid"], ["--tools", "Read,Unknown"], ["--model", "custom:x\nmodel: y"]]) {
      expect(() => parseGenerateDroidArgs(["--name", "valid", "--description", "task", ...extra])).toThrow();
    }
    expect(() => validateGeneratedDroid({ description: "valid", systemPrompt: "Read JSON and return its sum.", tools: ["Execute"] })).toThrow();
  });
  it("never replaces existing files and makes no model request on conflict", async () => {
    const root = own(); mkdirSync(join(root, ".factory/droids"), { recursive: true });
    const path = join(root, ".factory/droids/json-auditor.md"); writeFileSync(path, "USER CONTENT");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(generateDroid(args(root), { BRIDGE_CLIENT_TOKEN: "test-only" })).rejects.toThrow("already exists");
    expect(readFileSync(path, "utf8")).toBe("USER CONTENT"); expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses project configuration symlinks and leaves their target untouched", async () => {
    const root = own(), outside = own(); symlinkSync(outside, join(root, ".factory"));
    await expect(generateDroid(args(root), { BRIDGE_CLIENT_TOKEN: "test-only" })).rejects.toThrow("symlink");
    expect(existsSync(join(outside, "droids"))).toBe(false);
  });
  it("writes only caller-selected capabilities after a complete tool-free model reply", async () => {
    const root = own(); const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ description: "Audits arithmetic JSON.", systemPrompt: "Read the JSON input and independently calculate a plus b. Return the nonce unchanged." }) }] })));
    vi.stubGlobal("fetch", fetch);
    const path = await generateDroid(args(root), { BRIDGE_CLIENT_TOKEN: "test-only" });
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.tools).toEqual([]); expect(body.tool_choice).toEqual({ type: "none" });
    const markdown = readFileSync(path, "utf8"); expect(markdown).toContain('model: "inherit"'); expect(markdown).toContain('tools: ["Read","LS","Grep","Glob"]');
  });
  it("rejects partial or invalid model output without writing a definition", async () => {
    const root = own(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }] }))));
    await expect(generateDroid(args(root), { BRIDGE_CLIENT_TOKEN: "test-only" })).rejects.toThrow("did not finish");
    expect(existsSync(join(root, ".factory/droids/json-auditor.md"))).toBe(false);
  });
  it("preserves a user file created while the model request is running", async () => {
    const root = own(), path = join(root, ".factory/droids/json-auditor.md");
    vi.stubGlobal("fetch", vi.fn(async () => {
      writeFileSync(path, "USER FILE ARRIVED DURING GENERATION");
      return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ description: "Audit JSON.", systemPrompt: "Read JSON and independently calculate its arithmetic result." }) }] }));
    }));
    await expect(generateDroid(args(root), { BRIDGE_CLIENT_TOKEN: "test-only" })).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("USER FILE ARRIVED DURING GENERATION");
  });
  it("refuses a configuration directory swapped for a symlink during generation", async () => {
    const root = own(), outside = own(), target = join(root, ".factory/droids");
    vi.stubGlobal("fetch", vi.fn(async () => {
      renameSync(target, `${target}-original`); symlinkSync(outside, target);
      return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ description: "Audit JSON.", systemPrompt: "Read JSON and independently calculate its arithmetic result." }) }] }));
    }));
    await expect(generateDroid(args(root), { BRIDGE_CLIENT_TOKEN: "test-only" })).rejects.toThrow("symlink");
    expect(existsSync(join(outside, "json-auditor.md"))).toBe(false);
  });
  it("installs a credential-free executable project command without overwriting", () => {
    const root = own(), path = installDroidCommand(root), text = readFileSync(path, "utf8");
    expect(text).toContain('"$@"'); expect(text).not.toContain("BRIDGE_CLIENT_TOKEN=");
    expect(() => installDroidCommand(root)).toThrow("already exists");
  });
});
