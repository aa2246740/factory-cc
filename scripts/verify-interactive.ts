#!/usr/bin/env -S node --import tsx
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { droidEnv, resolveSelection, runE2eCommand, startSdkBridge } from "./e2e-lib.js";
import { ownDirectory, removeOwnedDirectory } from "./verify-relay.js";
import { installDroidCommand } from "./generate-droid.js";
import { installFactoryHooks } from "../src/control/factory-hooks.js";
import { nativePromptHasFinalResponse, verifyGeneratedDroidDelegation, verifyNaturalDroidGeneration, verifyOrdinaryChatRouting, verifyTerminalLifecycleDelivery, type NativeProofRow } from "./interactive-proof.js";

// Requires Python 3 + pexpect; uses an actual PTY, official Droid, official
// Claude Code and the caller's explicitly selected authorized BYOK endpoint.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
function verificationSourceHashes(): Record<string, string> {
  const files = ["scripts/verify-interactive.ts", "scripts/verify-interactive.py", "scripts/interactive-proof.ts", "scripts/generate-droid.ts", "scripts/e2e-lib.ts", "scripts/run-droid.ts", "scripts/factory-hook.ts"];
  const visit = (directory: string) => { for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`; if (entry.isDirectory()) visit(path); else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  } };
  visit("src");
  return Object.fromEntries(files.sort().map((path) => [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")]));
}
const cancelOnly = process.argv.includes("--cancel-only");
const generationOnly = process.argv.includes("--generation-only");
const naturalGenerationOnly = process.argv.includes("--natural-generation-only");
const exitOnly = process.argv.includes("--exit-only");
const focusedGeneration = generationOnly || naturalGenerationOnly;
const diagnosticHook = process.env.VERIFY_INTERACTIVE_HOOK_ENTRY;
if (diagnosticHook && (!exitOnly || !existsSync(diagnosticHook))) throw new Error("Diagnostic hook entry requires --exit-only and an existing explicitly selected file.");
if ([cancelOnly, generationOnly, naturalGenerationOnly, exitOnly].filter(Boolean).length > 1) throw new Error("Choose one focused verification mode.");
const positional = process.argv.slice(2).filter((arg) => !["--cancel-only", "--generation-only", "--natural-generation-only", "--exit-only"].includes(arg));
const summary = positional[0] ? resolve(positional[0]) : undefined;
if (process.argv.includes("--help")) {
  console.log("Usage: node --import tsx scripts/verify-interactive.ts [--cancel-only|--generation-only|--natural-generation-only|--exit-only] [new-summary.json]\nReal PTY /relay-droid generation + Task, /review, hosted /droids behavior and Escape cancellation. --cancel-only runs just the independently observed native-process cancellation. --natural-generation-only starts with an unhinted Chinese creation request, verifies Factory Skill discovery and native generator execution, then separately checks Task delegation and ordinary-chat routing. --exit-only checks two ordinary chat turns followed by normal /exit and lifecycle delivery. Requires explicit BRIDGE_UPSTREAM_* selection, official CLIs, python3 and pexpect.");
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
  authentication: "isolated explicit BYOK; no subscription credential access", allFactoryModelCallsitesCovered: false, sourceHashesAtStart: verificationSourceHashes() };
const app = await startSdkBridge(0, data!.path, selection, { home: home!.path, workspace: workspace!.path }).catch((error: unknown) => { dirs.forEach(removeOwnedDirectory); throw error; });
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
const secrets = [app.token, app.config.adminToken, process.env[app.selection.provider.tokenEnv] ?? ""].filter(Boolean);
const scrub = (value: unknown) => { let text = JSON.stringify(value); for (const secret of secrets) text = text.split(secret).join("[REDACTED]"); return JSON.parse(text.replace(/\[factory-cc-session:[a-f0-9]{64}\]/gi, "[REDACTED_SESSION_CAPABILITY]")); };
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
  if (diagnosticHook) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [process.execPath, "--import", pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href, resolve(diagnosticHook), "--factory-cc-hook-config", app.hostHooks.configPath].map(quote).join(" ");
    installFactoryHooks({ ...app.hostHooks, url: app.app.url, hookToken: app.config.hookToken, command });
    report.diagnosticHookEntry = resolve(diagnosticHook);
    report.diagnosticScope = "Explicit diagnostic hook wrapper; this run cannot certify the uninstrumented production hook entry.";
  }
  const env: NodeJS.ProcessEnv = { ...droidEnv(app.home, app.token), BRIDGE_ADMIN_TOKEN: app.config.adminToken, BRIDGE_CONTROL_URL: app.app.url, CLAUDE_CONFIG_DIR: join(data!.path, "claude-config") };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"]) delete env[key];
  const privatePath = join(data!.path, "pty-private.json");
  writeFileSync(privatePath, JSON.stringify({ env, cwd: root, command: [process.execPath, "--import", "tsx", join(root, "scripts/run-droid.ts"), "--home", app.home, "--cwd", app.workspace, "--airgap", "1", "--timeout", "2400000", "--"] }), { mode: 0o600 });
  console.log(`Interactive verification evidence: ${evidence}`);
  driver = runE2eCommand("python3", [join(root, "scripts/verify-interactive.py"), privatePath, evidence, actions], { cwd: root, env, timeoutMs: 2410000 });
  await waitFor("trust owned folder", () => terminal().includes("Trust this folder?"), 60_000); send("\r");
  await waitFor("interactive prompt", () => terminal().includes("Auto (Off)"), 60_000);
  if (!cancelOnly && !exitOnly) {
  const description = "Read input.json using only read-only tools. Return exactly JSON with sum equal to a plus b and nonce identical to input.nonce. Never edit files or execute commands. No prose.";
  const droidName = naturalGenerationOnly ? "json-auditor" : "relay-json-auditor";
  const generatedPath = join(app.workspace, `.factory/droids/${droidName}.md`);
  const inputBeforeGeneration = readFileSync(join(app.workspace, "input.json"), "utf8");
  if (naturalGenerationOnly) {
    const skillPath = join(app.workspace, ".factory/skills/relay-droid/SKILL.md");
    const skill = readFileSync(skillPath, "utf8"), skillBody = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
    const rawDescription = /^description:\s*(.+)$/m.exec(skill)?.[1]?.trim();
    const skillDescription = rawDescription?.startsWith('"') ? JSON.parse(rawDescription) as string : rawDescription ?? "";
    const prompt = "帮我在当前项目创建一个名为 json-auditor 的只读自定义助手，以后用于读取 input.json 并返回严格 JSON：sum 是 a 与 b 的和，nonce 保持原值。这个助手运行时只能使用读取、列目录和搜索工具，不能编辑文件或执行命令。现在只创建配置并告诉我位置，不要运行这个助手。";
    report.naturalCreationRequest = prompt;
    const generatorRequestsBeforeCreation = app.app.records.filter((request) => request.model === "relay-droid-generator").length;
    send(`${prompt}\r`);
    await waitFor("natural creation response", () => nativePromptHasFinalResponse(nativeMessages() as unknown as NativeProofRow[], prompt, "Available skills (name:") && idle());
    report.generator = verifyNaturalDroidGeneration(nativeMessages() as unknown as NativeProofRow[], { prompt, skillBody, skillDescription, generatedPath });
    const generatorRequestIndex = app.app.records.filter((request) => request.model === "relay-droid-generator");
    const generatorBodies = rows(join(app.config.logDir, "requests.jsonl")).map((request) => request.body as Record<string, unknown> | undefined).filter((body) => body?.model === "relay-droid-generator");
    const generatorBody = generatorBodies[0], generatorMessages = generatorBody?.messages as Array<{ role?: string; content?: unknown }> | undefined;
    let requestedDefinition: Record<string, unknown> = {};
    try { requestedDefinition = JSON.parse(String(generatorMessages?.[0]?.content)) as Record<string, unknown>; } catch { /* proof below rejects malformed request metadata */ }
    const requestChecks = { exactlyOneNewAuthenticatedGeneratorRequest: generatorRequestIndex.length - generatorRequestsBeforeCreation === 1 && generatorRequestIndex.every((request) => request.authOk),
      exactlyOneRecordedBody: generatorBodies.length === 1, modelMatches: generatorBody?.model === "relay-droid-generator",
      toolsDisabled: Array.isArray(generatorBody?.tools) && generatorBody.tools.length === 0 && (generatorBody?.tool_choice as Record<string, unknown> | undefined)?.type === "none",
      expectedName: requestedDefinition.name === droidName, readonlyRequestedTools: JSON.stringify(requestedDefinition.tools) === JSON.stringify(["Read", "LS", "Grep", "Glob"]) };
    report.generationRequestProof = { status: Object.values(requestChecks).every(Boolean) ? "PASS" : "FAIL", checks: requestChecks,
      source: "isolated Bridge requests.jsonl plus authenticated request index", before: generatorRequestsBeforeCreation, after: generatorRequestIndex.length,
      request: { model: generatorBody?.model, tools: generatorBody?.tools, tool_choice: generatorBody?.tool_choice, definition: requestedDefinition } };
    const definition = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : "";
    const field = (name: string): unknown => { const raw = new RegExp(`^${name}: (.+)$`, "m").exec(definition)?.[1]; try { return raw ? JSON.parse(raw) : undefined; } catch { return undefined; } };
    const generatedFiles = existsSync(dirname(generatedPath)) ? readdirSync(dirname(generatedPath)).sort() : [];
    const fileChecks = { independentlyCreated: Boolean(definition), exactName: field("name") === droidName, inheritedModel: field("model") === "inherit",
      readonlyCapabilities: JSON.stringify(field("tools")) === JSON.stringify(["Read", "LS", "Grep", "Glob"]),
      onlyRequestedDroidCreated: JSON.stringify(generatedFiles) === JSON.stringify([`${droidName}.md`]),
      authenticatedGeneratorRequest: app.app.records.some((request) => request.model === "relay-droid-generator" && request.authOk),
      inputUnchanged: readFileSync(join(app.workspace, "input.json"), "utf8") === inputBeforeGeneration };
    report.generatedDefinition = { status: Object.values(fileChecks).every(Boolean) ? "PASS" : "FAIL", checks: fileChecks, definition };
    if ((report.generator as Record<string, unknown>).status !== "PASS" || !Object.values(fileChecks).every(Boolean) || !Object.values(requestChecks).every(Boolean)) throw new Error("Natural request did not complete the strict Factory Skill → authenticated native generator → read-only definition chain.");
  } else {
  send(`/relay-droid --name ${droidName} --description ${JSON.stringify(description)}\r`);
  await waitFor("BYOK /relay-droid generation", () => existsSync(generatedPath));
  // Executable custom-command stdout is inserted into Droid's prompt. The TUI
  // renders the model's response, which need not repeat the helper's log text.
  await waitFor("generation command completion", () => idle() && app.app.records.length >= 2 && JSON.stringify(nativeMessages()).includes("Command file:"));
  const generationToolCalls = nativeMessages().flatMap((row) => row.type === "assistant" && Array.isArray((row.message as { content?: unknown })?.content) ? ((row.message as { content: Array<Record<string, unknown>> }).content).filter((block) => block.type === "tool_use") : []);
  if (generationToolCalls.length) throw new Error("The generation command unexpectedly executed follow-up native tools.");
  report.generator = { status: "PASS", unrequestedNativeToolCalls: generationToolCalls.length, entryPoint: "/relay-droid", definition: readFileSync(generatedPath, "utf8"), immutableCapabilities: "model inherit; tools Read,LS,Grep,Glob" };
  }
  const beforeTask = app.app.records.length;
  const generatorRequestCount = () => app.app.records.filter((request) => request.model === "relay-droid-generator").length;
  const generatorRequestsBeforeTask = generatorRequestCount(), filesBeforeTask = readdirSync(dirname(generatedPath)).sort(), definitionBeforeTask = readFileSync(generatedPath, "utf8");
  send(`Use Factory Task to delegate to the project custom droid ${droidName} with await true. Ask it to read input.json and return exact JSON sum and nonce. Do not read input.json yourself. Report the child result.\r`);
  await waitFor("generated Droid Task", () => app.app.records.length > beforeTask
    && verifyGeneratedDroidDelegation(nativeMessages() as unknown as NativeProofRow[], { sum: 56, nonce }, droidName).status === "PASS" && idle());
  const messagesAfterTask = nativeMessages();
  report.generatedDroidExecution = verifyGeneratedDroidDelegation(messagesAfterTask as unknown as NativeProofRow[], { sum: 56, nonce }, droidName);
  if ((report.generatedDroidExecution as Record<string, unknown>).status !== "PASS") throw new Error("Generated Droid Task/child Read chain failed independent verification.");

  if (naturalGenerationOnly) {
    report.existingAgentRouting = { status: "PASS", generatorRequestsBefore: generatorRequestsBeforeTask, generatorRequestsAfter: generatorRequestCount(),
      definitionUnchanged: readFileSync(generatedPath, "utf8") === definitionBeforeTask,
      noAdditionalDroids: JSON.stringify(readdirSync(dirname(generatedPath)).sort()) === JSON.stringify(filesBeforeTask) };
    const existingAgent = report.existingAgentRouting as Record<string, unknown>;
    if (generatorRequestCount() !== generatorRequestsBeforeTask || !existingAgent.definitionUnchanged || !existingAgent.noAdditionalDroids) {
      existingAgent.status = "FAIL"; throw new Error("Invoking an existing agent unexpectedly regenerated a definition.");
    }
    const ordinaryPrompt = "谢谢。顺便问一个常识问题：法国的首都是哪里？只回答城市中文名。";
    const definitionBeforeChat = readFileSync(generatedPath, "utf8"), filesBeforeChat = readdirSync(dirname(generatedPath)).sort(), generatorRequestsBeforeChat = generatorRequestCount();
    send(`${ordinaryPrompt}\r`);
    await waitFor("ordinary chat response", () => nativePromptHasFinalResponse(nativeMessages() as unknown as NativeProofRow[], ordinaryPrompt) && idle());
    report.ordinaryChat = { ...verifyOrdinaryChatRouting(nativeMessages() as unknown as NativeProofRow[], ordinaryPrompt, "巴黎"),
      prompt: ordinaryPrompt, definitionUnchanged: readFileSync(generatedPath, "utf8") === definitionBeforeChat,
      generatorRequestsBefore: generatorRequestsBeforeChat, generatorRequestsAfter: generatorRequestCount(),
      noAdditionalDroids: JSON.stringify(readdirSync(dirname(generatedPath)).sort()) === JSON.stringify(filesBeforeChat) };
    const ordinary = report.ordinaryChat as Record<string, unknown>;
    if (ordinary.status !== "PASS" || generatorRequestCount() !== generatorRequestsBeforeChat || !ordinary.definitionUnchanged || !ordinary.noAdditionalDroids) {
      ordinary.status = "FAIL"; throw new Error("Ordinary chat unexpectedly invoked tools or changed generated Droids.");
    }
  }

  if (!focusedGeneration && !exitOnly) {
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
  if (!focusedGeneration && !exitOnly) {
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
  if (exitOnly) {
    const turns = [{ prompt: "法国的首都是哪里？只回答城市中文名。", answer: "巴黎" }, { prompt: "日本的首都是哪里？只回答城市中文名。", answer: "东京" }];
    report.exitOnlyConversation = [];
    for (const [index, turn] of turns.entries()) {
      send(`${turn.prompt}\r`);
      await waitFor("ordinary conversation before exit", () => nativePromptHasFinalResponse(nativeMessages() as unknown as NativeProofRow[], turn.prompt, index === 0 ? "Available skills (name:" : undefined) && idle());
      const proof = verifyOrdinaryChatRouting(nativeMessages() as unknown as NativeProofRow[], turn.prompt, turn.answer);
      (report.exitOnlyConversation as unknown[]).push({ prompt: turn.prompt, ...proof });
      if (proof.status !== "PASS") throw new Error("Ordinary conversation failed before lifecycle exit verification.");
    }
  }
  send("/exit\r");
  await waitFor("interactive exit", () => existsSync(join(evidence, "pty-state.json")) && JSON.parse(readFileSync(join(evidence, "pty-state.json"), "utf8")).alive === false, 20_000);
  report.command = await driver;
  const ptyResult = JSON.parse(readFileSync(join(evidence, "pty-state.json"), "utf8")); report.ptyExit = { exitStatus: ptyResult.exitStatus, signalStatus: ptyResult.signalStatus };
  const command = report.command as { code: number; timedOut: boolean };
  if (ptyResult.exitStatus !== 0 || ptyResult.signalStatus !== null || command.code !== 0 || command.timedOut) throw new Error("Interactive CLI did not exit cleanly.");
  report.requests = app.app.records; report.sessions = app.app.store.list(); report.runtimeBeforeClose = app.app.runtimeStatus();
  report.sourceHashesAtCompletion = verificationSourceHashes();
  report.terminalLifecycle = { ...verifyTerminalLifecycleDelivery(terminal()), terminalSha256: createHash("sha256").update(terminal()).digest("hex") };
  const runtime = report.runtimeBeforeClose as Record<string, unknown>, control = runtime.control as Record<string, unknown> | undefined;
  report.completionChecks = { noActiveTurns: runtime.activeNativeTurns === 0, noPendingHostCalls: runtime.pendingHostCalls === 0,
    noPendingApprovals: runtime.pendingApprovals === 0 && control?.pendingApprovals === 0, noActiveHostSessions: control?.activeHostSessions === 0,
    noFatalErrors: Array.isArray(runtime.fatalErrors) && runtime.fatalErrors.length === 0, noControlFailures: Array.isArray(control?.failures) && control.failures.length === 0,
    terminalLifecycleDeliverySucceeded: (report.terminalLifecycle as Record<string, unknown>).status === "PASS",
    sourceUnchangedDuringRun: JSON.stringify(report.sourceHashesAtStart) === JSON.stringify(report.sourceHashesAtCompletion) };
  if (!Object.values(report.completionChecks as Record<string, boolean>).every(Boolean)) throw new Error("Interactive completion failed lifecycle delivery, source stability or runtime drain checks.");
  report.status = cancelOnly ? "PASS_CANCEL_ONLY" : exitOnly ? "PASS_EXIT_ONLY" : naturalGenerationOnly ? "PASS_NATURAL_GENERATION_ONLY" : generationOnly ? "PASS_GENERATION_ONLY" : "PASS_WITH_HOSTED_FEATURE_REPLACEMENT";
} catch (error) { report.error = error instanceof Error ? error.message : String(error); }
finally {
  if (driver) { appendFileSync(actions, `${JSON.stringify({ signal: "SIGTERM" })}\n`); await driver.catch(() => undefined); }
  save("native-proof.json", nativeMessages());
  save("request-proof.json", app.app.records);
  const hostEvents = rows(join(app.config.logDir, "host-events.jsonl"));
  save("host-events.json", hostEvents);
  report.sessionEndEvents = hostEvents.filter((event) => event.hook === "SessionEnd");
  const factoryLogPath = join(app.factoryHome, "logs/droid-log-single.log");
  if (existsSync(factoryLogPath)) save("factory-lifecycle-log.json", readFileSync(factoryLogPath, "utf8").split("\n").filter((line) => /SessionEnd|lifecycle|hook/i.test(line)));
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
if (!["PASS_WITH_HOSTED_FEATURE_REPLACEMENT", "PASS_CANCEL_ONLY", "PASS_GENERATION_ONLY", "PASS_NATURAL_GENERATION_ONLY", "PASS_EXIT_ONLY"].includes(String(report.status))) process.exitCode = 1;
