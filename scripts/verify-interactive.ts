#!/usr/bin/env -S node --import tsx
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { droidEnv, resolveSelection, runE2eCommand, startSdkBridge } from "./e2e-lib.js";
import { ownDirectory, removeOwnedDirectory } from "./verify-relay.js";
import { installDroidCommand } from "./generate-droid.js";
import { verifyGeneratedDroidDelegation, type NativeProofRow } from "./interactive-proof.js";

// Requires Python 3 + pexpect; uses an actual PTY, official Droid, official
// Claude Code and the caller's explicitly selected authorized BYOK endpoint.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cancelOnly = process.argv.includes("--cancel-only");
const generationOnly = process.argv.includes("--generation-only");
if (cancelOnly && generationOnly) throw new Error("Choose one focused verification mode.");
const positional = process.argv.slice(2).filter((arg) => arg !== "--cancel-only" && arg !== "--generation-only");
const summary = positional[0] ? resolve(positional[0]) : undefined;
if (process.argv.includes("--help")) {
  console.log("Usage: node --import tsx scripts/verify-interactive.ts [--cancel-only|--generation-only] [new-summary.json]\nReal PTY /relay-droid generation + Task, /review, hosted /droids behavior and Escape cancellation. --cancel-only runs just the independently observed native-process cancellation. Requires explicit BRIDGE_UPSTREAM_* selection, official CLIs, python3 and pexpect.");
  process.exit(0);
}
if (summary && existsSync(summary)) throw new Error("Summary already exists; preserve earlier attempts.");
if (spawnSync("python3", ["-c", "import pexpect"]).status !== 0) throw new Error("Python 3 with pexpect is required.");
const evidence = join(root, "evidence/local", `interactive-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
mkdirSync(evidence, { recursive: true });
const selection = await resolveSelection();
const dirs = [ownDirectory("relay-e2e-home-"), ownDirectory("relay-e2e-ws-"), ownDirectory("relay-verify-private-")];
const [home, workspace, data] = dirs;
const report: Record<string, unknown> = { suite: "real-interactive-surfaces", status: "FAIL", startedAt: new Date().toISOString(), evidence,
  authentication: "isolated explicit BYOK; no subscription credential access", allFactoryModelCallsitesCovered: false };
const app = await startSdkBridge(0, data!.path, selection, { home: home!.path, workspace: workspace!.path }).catch((error: unknown) => { dirs.forEach(removeOwnedDirectory); throw error; });
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
const secrets = [app.token, app.config.adminToken, process.env[app.selection.provider.tokenEnv] ?? ""].filter(Boolean);
const scrub = (value: unknown) => { let text = JSON.stringify(value); for (const secret of secrets) text = text.split(secret).join("[REDACTED]"); return JSON.parse(text); };
const save = (name: string, value: unknown) => writeFileSync(join(evidence, name), `${JSON.stringify(scrub(value), null, 2)}\n`, { mode: 0o600 });
const actions = join(evidence, "actions.jsonl"); writeFileSync(actions, "");
const terminal = () => existsSync(join(evidence, "terminal.txt")) ? readFileSync(join(evidence, "terminal.txt"), "utf8") : "";
const send = (text: string) => appendFileSync(actions, `${JSON.stringify({ send: text })}\n`);
const waitFor = async (label: string, condition: () => boolean, timeout = 600_000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (interrupted) throw new Error("Interactive verification was interrupted.");
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    const statePath = join(evidence, "pty-state.json");
    if (existsSync(statePath) && JSON.parse(readFileSync(statePath, "utf8")).alive === false) throw new Error(`Droid exited before ${label}.`);
    await new Promise((done) => setTimeout(done, 250));
  }
};
const idle = () => app.app.runtimeStatus().activeNativeTurns === 0 && app.app.runtimeStatus().pendingHostCalls === 0;
const rows = (path: string): Array<Record<string, unknown>> => {
  if (!existsSync(path)) return [];
  const current = readFileSync(path, "utf8");
  // Writers append JSONL while a native turn is running; only complete lines
  // are proof. A later read includes an in-flight trailing record.
  return current.slice(0, current.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((line) => JSON.parse(line));
};
const nativeMessages = (): Array<Record<string, unknown>> => {
  const found: Array<Record<string, unknown>> = [];
  const walk = (directory: string) => { if (!existsSync(directory)) return; for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name); if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) for (const row of rows(path)) if (row.type === "user" || row.type === "assistant") found.push({ sdkSessionId: entry.name.slice(0, -6), type: row.type, message: row.message });
  } }; walk(join(data!.path, "claude-config/projects")); return found;
};
let driver: ReturnType<typeof runE2eCommand> | undefined;
try {
  const settings = JSON.parse(readFileSync(app.settingsPath, "utf8")); settings.model = "relay-chat";
  writeFileSync(app.settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  writeFileSync(join(app.workspace, "math.js"), 'export function divide(a,b) { if (b===0) throw new Error("zero"); return a/b; }\n');
  for (const args of [["init", "-q"], ["add", "math.js"], ["-c", "user.name=Verification", "-c", "user.email=verify@example.invalid", "commit", "-qm", "baseline"]]) {
    if (spawnSync("git", args, { cwd: app.workspace }).status !== 0) throw new Error("Unable to prepare the owned review fixture.");
  }
  const broken = "export function divide(a,b) { return a*b; }\n";
  writeFileSync(join(app.workspace, "math.js"), broken);
  const nonce = randomBytes(12).toString("hex"); writeFileSync(join(app.workspace, "input.json"), JSON.stringify({ a: 19, b: 37, nonce }));
  installDroidCommand(app.workspace);
  const env: NodeJS.ProcessEnv = { ...droidEnv(app.home, app.token), BRIDGE_ADMIN_TOKEN: app.config.adminToken, BRIDGE_CONTROL_URL: app.app.url, CLAUDE_CONFIG_DIR: join(data!.path, "claude-config") };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"]) delete env[key];
  const privatePath = join(data!.path, "pty-private.json");
  writeFileSync(privatePath, JSON.stringify({ env, cwd: root, command: [process.execPath, "--import", "tsx", join(root, "scripts/run-droid.ts"), "--home", app.home, "--cwd", app.workspace, "--airgap", "1", "--timeout", "2400000", "--"] }), { mode: 0o600 });
  console.log(`Interactive verification evidence: ${evidence}`);
  driver = runE2eCommand("python3", [join(root, "scripts/verify-interactive.py"), privatePath, evidence, actions], { cwd: root, env, timeoutMs: 2410000 });
  await waitFor("trust owned folder", () => terminal().includes("Trust this folder?"), 60_000); send("\r");
  await waitFor("interactive prompt", () => terminal().includes("Auto (Off)"), 60_000);
  if (!cancelOnly) {
  const description = "Read input.json using only read-only tools. Return exactly JSON with sum equal to a plus b and nonce identical to input.nonce. Never edit files or execute commands. No prose.";
  send(`/relay-droid --name relay-json-auditor --description ${JSON.stringify(description)}\r`);
  const generatedPath = join(app.workspace, ".factory/droids/relay-json-auditor.md");
  await waitFor("BYOK /relay-droid generation", () => existsSync(generatedPath));
  // Executable custom-command stdout is inserted into Droid's prompt. The TUI
  // renders the model's response, which need not repeat the helper's log text.
  await waitFor("generation command completion", () => idle() && app.app.records.length >= 2 && JSON.stringify(nativeMessages()).includes("Command file:"));
  const generationToolCalls = nativeMessages().flatMap((row) => row.type === "assistant" && Array.isArray((row.message as { content?: unknown })?.content) ? ((row.message as { content: Array<Record<string, unknown>> }).content).filter((block) => block.type === "tool_use") : []);
  if (generationToolCalls.length) throw new Error("The generation command unexpectedly executed follow-up native tools.");
  report.generator = { status: "PASS", unrequestedNativeToolCalls: generationToolCalls.length, entryPoint: "/relay-droid", definition: readFileSync(generatedPath, "utf8"), immutableCapabilities: "model inherit; tools Read,LS,Grep,Glob" };
  const beforeTask = app.app.records.length;
  send("Use Factory Task to delegate to the project custom droid relay-json-auditor with await true. Ask it to read input.json and return exact JSON sum and nonce. Do not read input.json yourself. Report the child result.\r");
  await waitFor("generated Droid Task", () => app.app.records.length > beforeTask
    && verifyGeneratedDroidDelegation(nativeMessages() as unknown as NativeProofRow[], { sum: 56, nonce }).status === "PASS" && idle());
  const messagesAfterTask = nativeMessages();
  report.generatedDroidExecution = verifyGeneratedDroidDelegation(messagesAfterTask as unknown as NativeProofRow[], { sum: 56, nonce });
  if ((report.generatedDroidExecution as Record<string, unknown>).status !== "PASS") throw new Error("Generated Droid Task/child Read chain failed independent verification.");

  if (!generationOnly) {
  const beforeReview = terminal().length; send("/review\r");
  await waitFor("actual review menu", () => terminal().slice(beforeReview).includes("Select a review preset"), 30_000); send("2");
  await waitFor("review finding and completion", () => /\[P[012]\]/.test(terminal().slice(beforeReview)) && terminal().slice(beforeReview).includes("math.js") && idle());
  const reviewMessages = nativeMessages();
  report.review = { status: "PASS", actualSlashMenu: true, builtinSkillObserved: JSON.stringify(reviewMessages).includes('name=\\"review\\"'),
    fixtureUnchanged: readFileSync(join(app.workspace, "math.js"), "utf8") === broken,
    findings: reviewMessages.filter((row) => row.type === "assistant" && /\[P[012]\]/.test(JSON.stringify(row))) };
  if ((report.review as Record<string, unknown>).fixtureUnchanged !== true || !(report.review as Record<string, unknown>).builtinSkillObserved) throw new Error("Review proof did not preserve its fixture or builtin Skill.");

  let offset = terminal().length; send("/droids\r"); await waitFor("Droids menu", () => terminal().slice(offset).includes("Create new droid"), 30_000);
  offset = terminal().length; send("\r"); await waitFor("location", () => terminal().slice(offset).includes("Choose location"), 30_000);
  offset = terminal().length; send("\r"); await waitFor("method", () => terminal().slice(offset).includes("Creation method"), 30_000);
  offset = terminal().length; send("\r"); await waitFor("description", () => terminal().slice(offset).includes("Describe what this droid should do"), 30_000);
  const requestsBeforeHosted = app.app.records.length; offset = terminal().length; send("A read-only arithmetic JSON auditor.\r");
  await waitFor("hosted generator response", () => terminal().slice(offset).includes("Failed to generate droid configuration"), 60_000);
  const factoryLog = readFileSync(join(app.factoryHome, "logs/droid-log-single.log"), "utf8");
  report.hostedGenerator = { status: "BLOCKED_FACTORY_AUTH", error401Observed: /401.*Access token is invalid or expired/.test(factoryLog), bridgeRequestsAdded: app.app.records.length - requestsBeforeHosted,
    replacement: "Verified /relay-droid uses the configured BYOK Bridge and creates a usable project Droid." };
  if (!(report.hostedGenerator as Record<string, unknown>).error401Observed || (report.hostedGenerator as Record<string, unknown>).bridgeRequestsAdded !== 0) throw new Error("Hosted generator failure did not establish the expected independent Factory-auth boundary.");
  for (let index = 0; index < 4; index++) { send("\x1b"); await new Promise((done) => setTimeout(done, 350)); }
  }

  }
  if (!generationOnly) {
  const startedPath = join(app.workspace, "cancel-started.txt");
  send("Use native Bash to run exactly: printf started > cancel-started.txt; sleep 45; printf delayed > cancel-must-not-exist.txt . Wait for completion. Do not do anything else.\r");
  await waitFor("independent native process-start marker", () => existsSync(startedPath) && readFileSync(startedPath, "utf8") === "started");
  const cancelAt = Date.now(), beforeCancelRuntime = app.app.runtimeStatus(); send("\x1b");
  await waitFor("Escape stopped native work", idle, 15_000);
  const nativeStoppedAfterMs = Date.now() - cancelAt;
  await new Promise((done) => setTimeout(done, Math.max(0, 47_000 - (Date.now() - cancelAt))));
  report.escapeCancellation = { status: "PASS", independentStartMarker: readFileSync(startedPath, "utf8"), nativeStoppedAfterMs, before: beforeCancelRuntime, after: app.app.runtimeStatus(),
    observedAfterMs: Date.now() - cancelAt, delayedFileExists: existsSync(join(app.workspace, "cancel-must-not-exist.txt")) };
  if ((report.escapeCancellation as Record<string, unknown>).delayedFileExists) throw new Error("Native delayed write survived Escape cancellation.");
  }
  send("/exit\r");
  await waitFor("interactive exit", () => existsSync(join(evidence, "pty-state.json")) && JSON.parse(readFileSync(join(evidence, "pty-state.json"), "utf8")).alive === false, 20_000);
  report.command = await driver;
  const ptyResult = JSON.parse(readFileSync(join(evidence, "pty-state.json"), "utf8")); report.ptyExit = { exitStatus: ptyResult.exitStatus, signalStatus: ptyResult.signalStatus };
  const command = report.command as { code: number; timedOut: boolean };
  if (ptyResult.exitStatus !== 0 || ptyResult.signalStatus !== null || command.code !== 0 || command.timedOut) throw new Error("Interactive CLI did not exit cleanly.");
  report.requests = app.app.records; report.sessions = app.app.store.list(); report.runtimeBeforeClose = app.app.runtimeStatus();
  save("native-proof.json", nativeMessages());
  report.status = cancelOnly ? "PASS_CANCEL_ONLY" : generationOnly ? "PASS_GENERATION_ONLY" : "PASS_WITH_HOSTED_FEATURE_REPLACEMENT";
} catch (error) { report.error = error instanceof Error ? error.message : String(error); }
finally {
  if (driver) { appendFileSync(actions, `${JSON.stringify({ signal: "SIGTERM" })}\n`); await driver.catch(() => undefined); }
  save("request-proof.json", app.app.records);
  const titles: Array<Record<string, unknown>> = [];
  const titleDirectory = join(app.factoryHome, "sessions");
  if (existsSync(titleDirectory)) for (const folder of readdirSync(titleDirectory, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const file of readdirSync(join(titleDirectory, folder.name)).filter((name) => name.endsWith(".jsonl"))) {
      for (const row of rows(join(titleDirectory, folder.name, file))) if (typeof row.title === "string") titles.push({ factorySessionId: row.id, type: row.type, title: row.title });
    }
  }
  report.interactiveTitles = { entries: titles, scope: "Observed persisted interactive session titles; first-file-edit and fallback variants are not independently established." };
  await app.close(); report.processCleanup = app.processCleanup;
  report.removedOwnedDirectories = dirs.map((owned) => ({ path: owned.path, removed: removeOwnedDirectory(owned) }));
  if (!app.processCleanup?.complete) report.status = "FAIL";
  report.finishedAt = new Date().toISOString(); save("result.json", report);
  if (summary) writeFileSync(summary, `${JSON.stringify(scrub(report), null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
}
console.log(JSON.stringify({ status: report.status, evidence, error: report.error }));
if (report.status !== "PASS_WITH_HOSTED_FEATURE_REPLACEMENT" && report.status !== "PASS_CANCEL_ONLY" && report.status !== "PASS_GENERATION_ONLY") process.exitCode = 1;
