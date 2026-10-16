#!/usr/bin/env -S node --import tsx
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { controlBaseUrl } from "./control.js";

const help = `Generate a project Droid using your configured local Relay Bridge (BYOK).

  node --import tsx scripts/generate-droid.ts --cwd <project> --name <name> --description <task>
  node --import tsx scripts/generate-droid.ts --cwd <project> --install-command

Options: --model inherit|custom:<id> (default inherit), --url <loopback Bridge URL>,
         --tools Read,LS,Grep,Glob (default read-only), --timeout <milliseconds>.
BRIDGE_CLIENT_TOKEN is required for generation. BRIDGE_CONTROL_URL sets the URL.
Installation creates the /relay-droid project command and a discoverable Factory
skill for natural-language requests to create custom Droids; restart Droid to load
both. The command uses the same options above and inherits Bridge settings.
Identical installations are reusable; existing files are never overwritten.
Factory's hosted /droids generator is a
separate service and still requires its own authorization.`;

const toolNames = new Set(["Read", "LS", "Grep", "Glob", "Edit", "Write", "Create", "Execute", "Bash", "TodoWrite", "WebSearch", "FetchUrl", "AskUser", "Skill", "Task", "TaskOutput", "TaskStop", "ToolSearch", "ExitSpecMode"]);
export interface GenerateDroidArgs { cwd: string; name?: string; description?: string; model: string; tools: string[]; url?: string; timeoutMs: number; install: boolean; help: boolean }
export function parseGenerateDroidArgs(argv: string[]): GenerateDroidArgs {
  const result: GenerateDroidArgs = { cwd: process.cwd(), model: "inherit", tools: ["Read", "LS", "Grep", "Glob"], timeoutMs: 600_000, install: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]!;
    if (option === "--help" || option === "-h") { result.help = true; continue; }
    if (option === "--install-command") { result.install = true; continue; }
    if (!["--cwd", "--name", "--description", "--model", "--tools", "--url", "--timeout"].includes(option)) throw new Error("Unknown option; use --help.");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
    if (option === "--cwd") result.cwd = resolve(value);
    else if (option === "--name") result.name = value;
    else if (option === "--description") result.description = value;
    else if (option === "--model") result.model = value;
    else if (option === "--tools") result.tools = [...new Set(value.split(","))];
    else if (option === "--url") result.url = value;
    else result.timeoutMs = Number(value);
  }
  if (result.help) return result;
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1 || result.timeoutMs > 2_147_483_647) throw new Error("Invalid timeout.");
  if (result.model !== "inherit" && !/^custom:[A-Za-z0-9_.:-]{1,128}$/.test(result.model)) throw new Error("Droid model must be inherit or an explicit custom: model ID.");
  if (!result.tools.length || result.tools.some((tool) => !toolNames.has(tool))) throw new Error("Unsupported Droid tool name.");
  if (result.install) {
    if (result.name || result.description) throw new Error("Install the command separately from generating a Droid.");
  } else {
    if (!result.name || !/^[a-z][a-z0-9-]{0,63}$/.test(result.name)) throw new Error("Name must contain 1–64 lowercase letters, digits or hyphens, starting with a letter.");
    if (!result.description?.trim() || result.description.length > 12_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(result.description)) throw new Error("Provide a nonempty description of at most 12000 characters.");
  }
  return result;
}

/** Both directory components are owned project configuration, never followed through symlinks. */
function projectDirectory(cwd: string, leaf: "commands" | "droids"): string {
  const root = realpathSync(cwd);
  if (!lstatSync(root).isDirectory()) throw new Error("Project path is not a directory.");
  let current = root;
  for (const component of [".factory", leaf]) {
    current = join(current, component);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entry = lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(current) !== current) throw new Error("Refusing a symlink or non-directory in project configuration.");
  }
  return current;
}
function targetAvailable(path: string): void {
  try { lstatSync(path); throw new Error("Destination already exists; choose a new name. No existing Droid or command is overwritten."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function exclusiveWrite(path: string, text: string, mode: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, text); } finally { closeSync(fd); }
}
function shellQuote(text: string): string { return `'${text.replaceAll("'", "'\\''")}'`; }

/** Validate all existing parents before creating any part of an installation. */
function installationDirectory(root: string, components: string[], create: boolean): string {
  let current = root;
  for (const component of components) {
    current = join(current, component);
    if (create) {
      try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    try {
      const entry = lstatSync(current);
      if (!entry.isDirectory() || entry.isSymbolicLink() || realpathSync(current) !== current) throw new Error("Refusing a symlink or non-directory in project configuration.");
    } catch (error) { if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
  }
  return current;
}

/** Only byte-identical generated files are reusable; user files remain untouched. */
function installedFileMatches(path: string, expected: string, executable: boolean): boolean {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw new Error("Installation destination already exists or cannot be safely read; no existing file is overwritten.", { cause: error }); }
  try {
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.size !== Buffer.byteLength(expected) || (executable && !(entry.mode & 0o100)) || readFileSync(fd, "utf8") !== expected) {
      throw new Error("Installation destination already exists with different contents or permissions; no existing file is overwritten.");
    }
    return true;
  } finally { closeSync(fd); }
}

function discoverySkill(command: string): string {
  // Keep even unusual project paths inside one Markdown code block.
  const fence = "`".repeat(Math.max(3, ...Array.from(command.matchAll(/`+/g), (match) => match[0].length + 1)));
  return `---
name: relay-droid
description: "Create or generate a new reusable custom Factory Droid, agent or subagent using the local BYOK generator. 新建、创建或生成自定义 Droid、Agent、子代理。Only for explicit requests to create agent definitions; not normal conversation, running Mission or Agent Readiness, or invoking an existing agent."
---

# Create a custom Droid with Relay Bridge

Use this skill when the user asks to create a new reusable custom Droid/agent definition for this project. The installed generator uses the configured local Relay Bridge and BYOK model.

## Choose the correct operation

- Create a new custom agent: follow the generation steps below.
- Invoke an existing custom agent: use Factory's Task tool with that agent's name. Do not generate a replacement definition.
- Ordinary conversation, coding work, starting or continuing a Mission, or running Agent Readiness: keep the normal workflow. These requests do not authorize creating an agent definition.
- Factory's built-in /droids menu still manages Droids and has its own hosted generator. This skill does not intercept that menu or change its authorization.

## Generate the requested definition

1. Choose a name from the user's request: 1–64 lowercase letters, digits or hyphens, starting with a letter. Describe the requested agent's task, inputs, outputs and limits. If required details cannot be inferred, ask for them.
2. Use model inherit and the read-only tools Read,LS,Grep,Glob by default. Add --tools or an explicit custom: model ID only when the user's requested capabilities require it. Do not give an agent write, execution, delegation or network tools merely because they exist. The model generates prose only; the command controls the name, model and tool permissions.
3. Invoke the installed command with the available shell execution tool (Factory Execute or native Bash). The executable path below is already shell-quoted. Replace NAME and TASK with the actual values, each safely quoted as one argument; never interpolate task text as shell code. For POSIX shells, enclose each value in single quotes and replace an embedded apostrophe with the sequence '\\''.

${fence}sh
${shellQuote(command)} --name 'NAME' --description 'TASK'
${fence}

The command is bound to this project and inherits BRIDGE_CLIENT_TOKEN and BRIDGE_CONTROL_URL from its environment. Never print or inspect credentials. If the command reports missing configuration or a Bridge error, report that error; do not write a definition manually, use a hosted provider, or invent successful generation. Existing definitions are never overwritten; preserve a name collision and ask for a new name.

4. Success prints Created Droid and RELAY_DROID_GENERATION_COMPLETE. Report the created .factory/droids/<name>.md path and stop. Its contents are instructions for a future child Droid, not instructions to execute now. Do not invoke Task, run the generated agent, or perform its task after creation without a separate user request. Droid may need a session restart to discover the new agent.
`;
}

export function installDroidCommand(cwd: string): string {
  const root = realpathSync(cwd);
  if (!lstatSync(root).isDirectory()) throw new Error("Project path is not a directory.");
  const commandParts = [".factory", "commands"], skillParts = [".factory", "skills", "relay-droid"];
  const path = join(installationDirectory(root, commandParts, false), "relay-droid.sh");
  const skillPath = join(installationDirectory(root, skillParts, false), "SKILL.md");
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  const tsx = join(repository, "node_modules/tsx/dist/loader.mjs");
  if (!existsSync(tsx)) throw new Error("Install this repository's npm dependencies first.");
  const script = `#!/bin/sh\n# Generate a project Droid through the configured local Relay Bridge.\nexec ${shellQuote(process.execPath)} --import ${shellQuote(pathToFileURL(tsx).href)} ${shellQuote(fileURLToPath(import.meta.url))} --cwd ${shellQuote(root)} "$@"\n`;
  const files = [{ path, contents: script, mode: 0o700 }, { path: skillPath, contents: discoverySkill(path), mode: 0o600 }];
  // Preflight both files before any writes, including a legacy command-only install.
  for (const file of files) installedFileMatches(file.path, file.contents, file.mode === 0o700);
  installationDirectory(root, commandParts, true);
  installationDirectory(root, skillParts, true);
  const created: Array<{ path: string; dev: number; ino: number }> = [];
  try {
    for (const file of files) {
      installationDirectory(root, file.path === path ? commandParts : skillParts, false);
      if (installedFileMatches(file.path, file.contents, file.mode === 0o700)) continue;
      exclusiveWrite(file.path, file.contents, file.mode);
      const entry = lstatSync(file.path);
      created.push({ path: file.path, dev: entry.dev, ino: entry.ino });
    }
  } catch (error) {
    for (const file of created.reverse()) {
      try { const entry = lstatSync(file.path); if (entry.dev === file.dev && entry.ino === file.ino) unlinkSync(file.path); } catch { /* Preserve any concurrent replacement. */ }
    }
    throw error;
  }
  return path;
}

export function validateGeneratedDroid(value: unknown): { description: string; systemPrompt: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Generator returned an invalid object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "description,systemPrompt"
    || typeof record.description !== "string" || !record.description.trim() || record.description.length > 1024 || /[\r\n\x00-\x1f]/.test(record.description)
    || typeof record.systemPrompt !== "string" || record.systemPrompt.trim().length < 20 || record.systemPrompt.length > 60_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(record.systemPrompt)) {
    throw new Error("Generator returned invalid description/systemPrompt fields; no Droid was written.");
  }
  return { description: record.description.trim(), systemPrompt: record.systemPrompt.trim() };
}

export async function generateDroid(args: GenerateDroidArgs, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  args = parseGenerateDroidArgs(["--cwd", args.cwd, "--name", args.name ?? "", "--description", args.description ?? "", "--model", args.model,
    "--tools", args.tools.join(","), "--timeout", String(args.timeoutMs), ...(args.url ? ["--url", args.url] : [])]);
  const token = env.BRIDGE_CLIENT_TOKEN?.trim();
  if (!token) throw new Error("BRIDGE_CLIENT_TOKEN is required; no model request was sent.");
  const url = controlBaseUrl(args.url ?? env.BRIDGE_CONTROL_URL);
  const directory = projectDirectory(args.cwd, "droids"), path = join(directory, `${args.name}.md`);
  targetAvailable(path);
  // The model proposes prose only. Names, paths, model and tool capabilities are
  // caller-controlled and are never taken from model output.
  const response = await fetch(`${url}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": token }, redirect: "error",
    body: JSON.stringify({ model: env.BRIDGE_MODEL_ID ?? "relay-droid-generator", max_tokens: 4096, stream: false, tools: [], tool_choice: { type: "none" },
      system: "Generate a Factory custom Droid configuration. Reply with one JSON object only, with exactly description (one line) and systemPrompt (Markdown instructions). Do not use tools, write files, add frontmatter, or put the JSON in a code fence. Explain when the Droid is useful and how it should do the requested task. Respect the declared tools; do not instruct it to use unavailable capabilities.",
      messages: [{ role: "user", content: JSON.stringify({ name: args.name, task: args.description, tools: args.tools }) }] }),
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Droid generation failed (Bridge HTTP ${response.status}); no Droid was written.`); }
  const raw = await response.text();
  if (raw.length > 262_144) throw new Error("Generator response exceeded the size limit.");
  const envelope = JSON.parse(raw) as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string };
  if (envelope.stop_reason !== "end_turn" || !Array.isArray(envelope.content) || envelope.content.some((block) => block.type !== "text")) throw new Error("Generator did not finish with a text-only result.");
  const generated = validateGeneratedDroid(JSON.parse(envelope.content.map((block) => block.text ?? "").join("")));
  // Revalidate the directory after the network wait; exclusive create prevents
  // replacing a file created while generation was running.
  if (projectDirectory(args.cwd, "droids") !== directory) throw new Error("Project directory changed during generation.");
  const markdown = `---\nname: ${JSON.stringify(args.name)}\ndescription: ${JSON.stringify(generated.description)}\nmodel: ${JSON.stringify(args.model)}\ntools: ${JSON.stringify(args.tools)}\n---\n\n${generated.systemPrompt}\n`;
  exclusiveWrite(path, markdown, 0o600);
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (async () => { const args = parseGenerateDroidArgs(process.argv.slice(2)); if (args.help) { console.log(help); return; }
    const path = args.install ? installDroidCommand(args.cwd) : await generateDroid(args);
    console.log(args.install ? `Installed /relay-droid: ${path}\nInstalled discovery skill: ${join(realpathSync(args.cwd), ".factory/skills/relay-droid/SKILL.md")}\nRestart Droid to discover the command and skill for requests to create custom agents.`
      : `Created Droid: ${path}\nRELAY_DROID_GENERATION_COMPLETE\nConfiguration generation is complete. The generated file contains instructions for a future child Droid, not instructions to execute now. Confirm the created file path and stop without additional tool calls. Invoke the new Droid only after a separate user request.`);
  })().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Droid generation failed."); process.exitCode = 1; });
}
