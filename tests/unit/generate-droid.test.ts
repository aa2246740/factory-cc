import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
    const path = await generateDroid(args(root), { BRIDGE_CLIENT_TOKEN: "test-only", BRIDGE_MODEL_ID: "haiku" });
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.model).toBe("haiku");
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
  it("installs a credential-free executable command and discoverable Factory skill", () => {
    const root = own(), path = installDroidCommand(root), text = readFileSync(path, "utf8");
    expect(text).toContain('"$@"'); expect(text).not.toContain("BRIDGE_CLIENT_TOKEN=");
    expect(lstatSync(path).mode & 0o777).toBe(0o700);
    const skillPath = join(root, ".factory/skills/relay-droid/SKILL.md"), skill = readFileSync(skillPath, "utf8");
    expect(skill).toMatch(/^---\nname: relay-droid\ndescription: /);
    expect(skill).toContain("新建、创建或生成自定义"); expect(skill).toContain("Factory's Task tool");
    expect(skill).toContain("Mission"); expect(skill).toContain("Agent Readiness");
    expect(skill).toContain("separate user request"); expect(skill).toContain("Read,LS,Grep,Glob");
    expect(skill).toContain("sequence '\\''.");
    expect(skill).toContain(`'${path}' --name 'NAME' --description 'TASK'`);
    expect(skill).not.toContain("BRIDGE_CLIENT_TOKEN="); expect(lstatSync(skillPath).mode & 0o777).toBe(0o600);
  });
  it("reuses exact installations and upgrades the previous command-only install without rewriting", () => {
    const root = own(), path = installDroidCommand(root), entry = lstatSync(path);
    const skillPath = join(root, ".factory/skills/relay-droid/SKILL.md"), skill = readFileSync(skillPath, "utf8");
    expect(installDroidCommand(root)).toBe(path);
    expect(lstatSync(path).ino).toBe(entry.ino); expect(lstatSync(path).mtimeMs).toBe(entry.mtimeMs);
    rmSync(join(root, ".factory/skills"), { recursive: true });
    expect(installDroidCommand(root)).toBe(path);
    expect(lstatSync(path).ino).toBe(entry.ino); expect(lstatSync(path).mtimeMs).toBe(entry.mtimeMs);
    expect(readFileSync(skillPath, "utf8")).toBe(skill);
  });
  it("preflights conflicting user files before installing either artifact", () => {
    for (const conflict of ["commands/relay-droid.sh", "skills/relay-droid/SKILL.md"]) {
      const root = own(), path = join(root, ".factory", conflict);
      mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "USER CONTENT", { mode: 0o700 });
      expect(() => installDroidCommand(root)).toThrow("already exists");
      expect(readFileSync(path, "utf8")).toBe("USER CONTENT");
      const other = conflict.startsWith("commands") ? "skills/relay-droid/SKILL.md" : "commands/relay-droid.sh";
      expect(existsSync(join(root, ".factory", other))).toBe(false);
    }
  });
  it("preserves an edited discovery skill and disabled command permissions", () => {
    const root = own(), path = installDroidCommand(root), skillPath = join(root, ".factory/skills/relay-droid/SKILL.md");
    writeFileSync(skillPath, "MY EDITED SKILL");
    expect(() => installDroidCommand(root)).toThrow("already exists");
    expect(readFileSync(skillPath, "utf8")).toBe("MY EDITED SKILL");
    rmSync(skillPath); chmodSync(path, 0o600);
    expect(() => installDroidCommand(root)).toThrow("permissions");
    expect(lstatSync(path).mode & 0o777).toBe(0o600); expect(existsSync(skillPath)).toBe(false);
  });
  it("rejects symlinked configuration parents or destinations without writing through them", () => {
    for (const component of [".factory", ".factory/commands", ".factory/skills", ".factory/skills/relay-droid", ".factory/commands/relay-droid.sh", ".factory/skills/relay-droid/SKILL.md"]) {
      const root = own(), outside = own(), path = join(root, component);
      mkdirSync(join(path, ".."), { recursive: true }); symlinkSync(outside, path);
      expect(() => installDroidCommand(root)).toThrow();
      expect(existsSync(join(outside, "relay-droid.sh"))).toBe(false);
      expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    }
  });
  it("keeps shell metacharacters in project paths literal in the executable and skill invocation", () => {
    const parent = own(), root = join(parent, "quoted ' project $(touch injected) `touch injected`"); mkdirSync(root);
    const path = installDroidCommand(root), skill = readFileSync(join(root, ".factory/skills/relay-droid/SKILL.md"), "utf8");
    const invocation = skill.match(/```sh\n(.+) --name 'NAME' --description 'TASK'\n```/)?.[1];
    expect(invocation).toBeDefined();
    const result = spawnSync("/bin/sh", ["-c", `${invocation} --help`], { cwd: parent, env: { PATH: process.env.PATH }, encoding: "utf8" });
    expect(result.status).toBe(0); expect(result.stdout).toContain("Generate a project Droid");
    expect(existsSync(join(parent, "injected"))).toBe(false); expect(existsSync(path)).toBe(true);
  });
});
