#!/usr/bin/env -S node --import tsx
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { controlBaseUrl } from "./control.js";

const help = `Generate a project Droid using your configured local Relay Bridge (BYOK).

  node --import tsx scripts/generate-droid.ts --cwd <project> --name <name> --description <task>
  node --import tsx scripts/generate-droid.ts --cwd <project> --install-command

Options: --model inherit|custom:<id> (default inherit), --url <loopback Bridge URL>,
         --tools Read,LS,Grep,Glob (default read-only), --timeout <milliseconds>.
BRIDGE_CLIENT_TOKEN is required for generation. BRIDGE_CONTROL_URL sets the URL.
Installation creates /relay-droid as a project executable custom command; restart
Droid to discover it. It uses the same options above and inherits Bridge settings.
Existing files are never overwritten. Factory's hosted /droids generator is a
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
export function installDroidCommand(cwd: string): string {
  const directory = projectDirectory(cwd, "commands"), path = join(directory, "relay-droid.sh");
  targetAvailable(path);
  const repository = dirname(dirname(fileURLToPath(import.meta.url)));
  const tsx = join(repository, "node_modules/tsx/dist/loader.mjs");
  if (!existsSync(tsx)) throw new Error("Install this repository's npm dependencies first.");
  const script = `#!/bin/sh\n# Generate a project Droid through the configured local Relay Bridge.\nexec ${shellQuote(process.execPath)} --import ${shellQuote(pathToFileURL(tsx).href)} ${shellQuote(fileURLToPath(import.meta.url))} --cwd ${shellQuote(realpathSync(cwd))} "$@"\n`;
  exclusiveWrite(path, script, 0o700);
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
    body: JSON.stringify({ model: "relay-droid-generator", max_tokens: 4096, stream: false, tools: [], tool_choice: { type: "none" },
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
    console.log(args.install ? `Installed /relay-droid: ${path}\nRestart Droid to load this project command.`
      : `Created Droid: ${path}\nRELAY_DROID_GENERATION_COMPLETE\nConfiguration generation is complete. The generated file contains instructions for a future child Droid, not instructions to execute now. Confirm the created file path and stop without additional tool calls. Invoke the new Droid only after a separate user request.`);
  })().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Droid generation failed."); process.exitCode = 1; });
}
