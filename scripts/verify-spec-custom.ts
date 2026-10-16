#!/usr/bin/env -S node --import tsx
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { droidEnv, resolveSelection, startSdkBridge, type IsolatedBridge } from "./e2e-lib.js";
import { prepareDroidExecArgs, runDroid } from "./run-droid.js";
import { ownDirectory, removeOwnedDirectory, runtimeIsDrained } from "./verify-relay.js";
import { publicSelection } from "../src/upstream/providers.js";

type Feature = "spec" | "custom";
interface Args { feature: Feature; timeoutMs: number; summary?: string; addSpecTool: boolean; adversarialSpec: boolean; readOnlyCustom: boolean; help: boolean }
export function parseSpecCustomArgs(argv: string[]): Args {
  const result: Args = { feature: "spec", timeoutMs: 600_000, addSpecTool: false, adversarialSpec: false, readOnlyCustom: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]!;
    if (option === "--help") { result.help = true; continue; }
    if (option === "--add-spec-tool") { result.addSpecTool = true; continue; }
    if (option === "--adversarial-spec") { result.adversarialSpec = true; continue; }
    if (option === "--read-only-custom") { result.readOnlyCustom = true; continue; }
    if (!["--feature", "--timeout", "--summary"].includes(option)) throw new Error("Unknown option; use --help.");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
    if (option === "--feature") {
      if (value !== "spec" && value !== "custom") throw new Error("Feature must be spec or custom.");
      result.feature = value;
    } else if (option === "--summary") result.summary = resolve(value);
    else {
      result.timeoutMs = Number(value);
      if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1 || result.timeoutMs > 2_147_483_647) throw new Error("Timeout must be a positive integer of milliseconds.");
    }
  }
  if (result.adversarialSpec && result.feature !== "spec") throw new Error("--adversarial-spec requires --feature spec.");
  if (result.readOnlyCustom && result.feature !== "custom") throw new Error("--read-only-custom requires --feature custom.");
  return result;
}
function rows(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}
function nativeRows(dir: string): Record<string, unknown>[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? nativeRows(path) : entry.isFile() && path.endsWith(".jsonl") ? rows(path) : [];
  });
}
interface ToolCall { name: string; id: string; input: Record<string, unknown>; sessionId?: string; resultSeen: boolean; isError: boolean; resultText?: string }
export function observedTools(transcript: Record<string, unknown>[]): ToolCall[] {
  const tools: ToolCall[] = [], results = new Map<string, { isError: boolean; text: string }>();
  for (const row of transcript) {
    const message = row.message as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) continue;
    for (const item of message.content as Record<string, unknown>[]) {
      if (row.type === "assistant" && item.type === "tool_use" && typeof item.name === "string" && typeof item.id === "string") tools.push({ name: item.name, id: item.id, input: item.input as Record<string, unknown>, sessionId: row.sessionId as string | undefined, resultSeen: false, isError: false });
      if (row.type === "user" && item.type === "tool_result" && typeof item.tool_use_id === "string") results.set(item.tool_use_id, { isError: item.is_error === true, text: (typeof item.content === "string" ? item.content : JSON.stringify(item.content) ?? "").slice(0, 4_000) });
    }
  }
  return tools.map((tool) => ({ ...tool, resultSeen: results.has(tool.id), isError: results.get(tool.id)?.isError ?? false, ...(results.has(tool.id) ? { resultText: results.get(tool.id)!.text } : {}) }));
}
function scrub(value: unknown, secrets: string[]): unknown {
  let json = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) json = json.split(secret).join("[REDACTED]");
  return JSON.parse(json.replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/g, "[REDACTED]"));
}
export async function verifySpecCustom(argv: string[]): Promise<number> {
  const args = parseSpecCustomArgs(argv);
  if (args.help) { console.log("Usage: node --import tsx scripts/verify-spec-custom.ts --feature spec|custom [--timeout milliseconds] [--summary NEW.json]\n--adversarial-spec attempts a forbidden native Write before spec approval.\n--read-only-custom probes a custom Droid restricted to Read.\n--add-spec-tool explicitly supplies the Factory CLI workaround (normally the production wrapper adds it).\nRuns official isolated Droid exec through production run-droid and native Claude Code. Explicit BRIDGE_UPSTREAM_* BYOK selection required. Every attempt retains sanitized evidence and removes owned temporary directories."); return 0; }
  if (args.summary && existsSync(args.summary)) throw new Error("Summary exists; use a new path to preserve previous evidence.");
  const selection = await resolveSelection();
  const evidence = join(dirname(dirname(fileURLToPath(import.meta.url))), "evidence/local", `verify-${args.feature}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
  mkdirSync(evidence, { recursive: true });
  const owned = [ownDirectory("relay-e2e-home-"), ownDirectory("relay-e2e-ws-"), ownDirectory("relay-verify-private-")];
  const [home, workspace, data] = owned.map((item) => item.path) as [string, string, string];
  const secrets = [process.env[selection.provider.tokenEnv] ?? ""];
  const report: Record<string, unknown> = { feature: args.feature, variant: args.adversarialSpec ? "adversarial-spec-readonly" : args.readOnlyCustom ? "custom-readonly" : "ordinary", status: "FAIL", startedAt: new Date().toISOString(), authentication: { ...publicSelection(selection), subscriptionCredentialsRead: false }, exclusions: ["Anthropic subscription billing or account-safety guarantees", "different underlying models for Factory aliases", "all possible custom droids"] };
  const preserved = new Map<string, string>();
  const save = (name: string, value: unknown) => {
    const path = join(evidence, name), text = `${JSON.stringify(scrub(value, secrets), null, 2)}\n`;
    writeFileSync(path, text, { flag: "wx", mode: 0o600 });
    preserved.set(path, createHash("sha256").update(text).digest("hex"));
  };
  let isolated: IsolatedBridge | undefined;
  try {
    isolated = await startSdkBridge(0, data, selection, { home, workspace });
    secrets.push(isolated.token, isolated.config.adminToken);
    // Observe official permission metadata without collecting hook environment,
    // credential paths, model text, or arbitrary tool outputs.
    const modeProbe = join(data, "hook-mode-probe.mjs"), modeEvents = join(data, "hook-modes.jsonl");
    writeFileSync(modeProbe, "import {appendFileSync} from 'node:fs'; let raw=''; for await (const chunk of process.stdin) raw+=chunk; const e=JSON.parse(raw); appendFileSync(process.argv[2],JSON.stringify({at:new Date().toISOString(),hook:e.hook_event_name,sessionId:e.session_id,permissionMode:e.permission_mode,toolName:e.tool_name})+'\\n',{mode:0o600});\n", { mode: 0o600 });
    const hooksPath = join(workspace, ".factory/hooks.json"), hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<string, unknown[]>;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [process.execPath, modeProbe, modeEvents].map(quote).join(" ");
    for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionEnd"]) hooks[event] = [...hooks[event] ?? [], { hooks: [{ type: "command", command, timeout: 10 }] }];
    writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });
    const fixture = { nonce: randomBytes(12).toString("hex"), a: 17, b: 29 };
    writeFileSync(join(workspace, "input.json"), `${JSON.stringify(fixture)}\n`);
    const settings = JSON.parse(readFileSync(isolated.settingsPath, "utf8")) as { customModels: Record<string, unknown>[] };
    const childModel = "relay-custom-child";
    settings.customModels.push({ ...settings.customModels[0], model: childModel, displayName: childModel });
    writeFileSync(isolated.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    const bodyMarker = `DROID_BODY_${randomBytes(10).toString("hex")}`;
    if (args.feature === "custom") {
      mkdirSync(join(workspace, ".factory/droids"), { recursive: true });
      const action = args.readOnlyCustom
        ? `This is an authorized disposable permission test: first attempt native Write to forbidden-custom-write.json with content PERMISSION_PROBE. That attempt must be mechanically denied; do not retry it through another tool. Then use native Read to read input.json. Return CUSTOM_CHILD_OK and the exact JSON object {"nonce": <input nonce>, "sum": <input a + b>, "bodyMarker": "${bodyMarker}"} in your final response. Do not alter input.json or write any other file.`
        : `Use native Read to read input.json. Use native Write to write custom-result.json containing the exact JSON object {"nonce": <input nonce>, "sum": <input a + b>, "bodyMarker": "${bodyMarker}"}. Do not alter input.json. Return the bodyMarker to the parent in your final response with CUSTOM_CHILD_OK.`;
      writeFileSync(join(workspace, ".factory/droids/relay-verifier.md"), `---\nname: relay-verifier\ndescription: Run the dedicated project's verification task.\nmodel: custom:relay-custom-child-0\n${args.readOnlyCustom ? "tools: [Read]\n" : ""}---\nYou are the dedicated verification droid. ${action} The bodyMarker comes only from this droid definition. Do not delegate or inspect other files.\n`);
    }
    const prompt = args.feature === "spec"
      ? `${args.adversarialSpec ? "This is a disposable permission regression test. Before submitting the spec, attempt native Write to forbidden-before-spec.json with content PERMISSION_PROBE. The native permission hook must deny it; do not retry that forbidden write through another tool. Then continue the ordinary task. " : ""}Use spec mode to plan this small task, submit the specification with the Factory ExitSpecMode tool, then implement after the CLI approves it. Read input.json. Write spec-result.json with exactly {\"nonce\": <input nonce>, \"sum\": <input a + b>}. Do not alter input.json. This is a disposable fixture and no questions are needed. After implementation reply SPEC_IMPLEMENTED_OK.`
      : `Invoke the Factory Task tool once with subagent_type relay-verifier and await true to complete its verification task. Use ToolSearch to discover Factory Task if needed. The project droid has all instructions; ask it to execute them and return CUSTOM_CHILD_OK with its bodyMarker. Do not read .factory/droids or input.json yourself and do not write any files yourself. After the Task returns, report ${args.readOnlyCustom ? "the full JSON result including nonce, sum, and bodyMarker" : "the exact bodyMarker"} it returned and CUSTOM_PARENT_OK.`;
    const droidArgs = ["exec", "--settings", isolated.settingsPath, "--output-format", "json", "--model", "relay-chat", "--auto", "high", ...(args.feature === "spec" ? ["--use-spec", "--spec-model", "relay-chat", ...(args.addSpecTool ? ["--add-tools", "ExitSpecMode"] : [])] : []), prompt];
    const out = join(data, "wrapper.json");
    const wrapperArgs = ["--home", home, "--cwd", workspace, "--airgap", "1", "--timeout", String(args.timeoutMs), "--out", out, "--", ...droidArgs];
    console.log(JSON.stringify({ feature: args.feature, evidenceDirectory: evidence, workspace, privateData: data }));
    const env = { ...droidEnv(home, isolated.token), BRIDGE_ADMIN_TOKEN: isolated.config.adminToken, BRIDGE_CONTROL_URL: isolated.app.url };
    const exitCode = await runDroid(wrapperArgs, { env, stdio: "ignore" });
    const capture = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) as { stdout: string; stderr: string } : { stdout: "", stderr: "No wrapper capture" };
    save("action.json", { command: ["npm", "run", "run-droid", "--", ...wrapperArgs], effectiveDroidArguments: prepareDroidExecArgs(droidArgs), exitCode, ...capture });
    report.exitCode = exitCode;
    let body: { session_id?: string; result?: string; is_error?: boolean } = {};
    try { body = JSON.parse(capture.stdout) as typeof body; } catch { /* preserved output explains malformed response */ }
    const requests = rows(join(isolated.config.logDir, "requests.jsonl"));
    const transcript = nativeRows(join(data, "claude-config/projects"));
    const tools = observedTools(transcript);
    const sessions = isolated.app.store.list();
    const runtime = isolated.app.runtimeStatus();
    const outputPath = join(workspace, args.feature === "spec" ? "spec-result.json" : "custom-result.json");
    let output: Record<string, unknown> | undefined;
    if (existsSync(outputPath)) { try { output = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>; } catch { /* assertion below */ } }
    const checks: Record<string, boolean> = {
      droidSucceeded: exitCode === 0 && body.is_error === false,
      [args.readOnlyCustom ? "forbiddenFilesAbsent" : "independentFileResult"]: args.readOnlyCustom ? !existsSync(join(workspace, "forbidden-custom-write.json")) && !existsSync(outputPath) : output?.nonce === fixture.nonce && output?.sum === fixture.a + fixture.b,
      inputUnchanged: readFileSync(join(workspace, "input.json"), "utf8").trim() === JSON.stringify(fixture),
      authenticatedBridgeTraffic: isolated.app.records.some((row) => row.authOk),
      nativeReadCompleted: tools.some((tool) => tool.name === "Read" && tool.resultSeen && !tool.isError),
      [args.readOnlyCustom ? "nativeWriteDenied" : "nativeWriteCompleted"]: args.readOnlyCustom ? tools.some((tool) => tool.name === "Write" && tool.resultSeen && tool.isError && tool.resultText?.includes("BRIDGE_HOST_TOOL_NOT_ADVERTISED")) : tools.some((tool) => tool.name === "Write" && tool.resultSeen && !tool.isError),
      runtimeDrained: runtimeIsDrained(runtime),
      nativeSessionsPresent: sessions.some((session) => Boolean(session.sdkSessionId)),
    };
    if (args.feature === "spec") {
      const exitSpec = tools.find((tool) => tool.name === "mcp__droid__ExitSpecMode" && tool.resultSeen && !tool.isError);
      checks.realFactoryExitSpecMode = Boolean(exitSpec);
      checks.sameNativeSessionThroughApproval = Boolean(exitSpec?.sessionId)
        && tools.some((tool) => tool.name === "Read" && tool.sessionId === exitSpec!.sessionId && tool.resultSeen && !tool.isError)
        && tools.some((tool) => tool.name === "Write" && tool.sessionId === exitSpec!.sessionId && tool.resultSeen && !tool.isError);
      checks.factoryApprovalObserved = requests.some((request) => JSON.stringify((request.body as { messages?: unknown } | undefined)?.messages).includes("The user has approved your implementation plan. Spec mode has been exited"));
      checks.finalCompletionMarker = Boolean(body.result?.includes("SPEC_IMPLEMENTED_OK"));
      if (args.adversarialSpec) {
        checks.preApprovalWriteDenied = tools.some((tool) => tool.name === "Write" && String(tool.input?.file_path).endsWith("/forbidden-before-spec.json") && tool.resultSeen && tool.isError && tool.resultText?.includes("BRIDGE_FACTORY_SPEC_READ_ONLY"));
        checks.preApprovalFileAbsent = !existsSync(join(workspace, "forbidden-before-spec.json"));
      }
    } else {
      const task = tools.find((tool) => tool.name === "mcp__droid__Task" && tool.input?.subagent_type === "relay-verifier");
      checks.actualCustomFactoryTask = Boolean(task?.resultSeen) && task?.isError === false;
      checks.bodyOnlyMarkerPreserved = (args.readOnlyCustom || output?.bodyMarker === bodyMarker) && Boolean(body.result?.includes(bodyMarker));
      checks.customModelSelected = requests.some((request) => (request.body as { model?: string } | undefined)?.model === childModel);
      checks.childNativeSession = new Set(sessions.filter((session) => session.sdkSessionId).map((session) => session.sdkSessionId)).size >= 2;
      checks.parentDidNotReadOrWrite = Boolean(task?.sessionId) && !tools.some((tool) => tool.sessionId === task?.sessionId && ["Read", "Write", "Edit", "Bash"].includes(tool.name));
      checks.markerNotInDelegatedPrompt = Boolean(task) && !JSON.stringify(task!.input).includes(bodyMarker);
      if (args.readOnlyCustom) {
        checks.readOnlyResultFidelity = Boolean(body.result?.includes(fixture.nonce)) && Boolean(body.result?.includes(String(fixture.a + fixture.b)));
        checks.childNativeFileToolsReadOnly = requests.some((request) => {
          const value = request.body as { model?: string; tools?: Array<{ name: string }> } | undefined;
          // Factory retains its own Skill entry even for a tools:[Read] Droid.
          // Skill stays a Factory callback; it is not native file-write access.
          return value?.model === childModel && Boolean(value.tools?.some((tool) => tool.name === "Read"))
            && value.tools!.every((tool) => tool.name === "Read" || tool.name === "Skill");
        });
      }
    }
    report.checks = checks;
    report.status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
    report.observations = { result: body, independentFileResult: output, tools, hookModes: rows(modeEvents), requests: requests.map((request) => ({ at: request.at, session: request.session, model: (request.body as Record<string, unknown> | undefined)?.model })), sessions, runtime };
    save("requests.json", requests); save("native-transcript.json", transcript); save("snapshot.json", report.observations);
  } catch (error) {
    report.error = error instanceof Error ? error.message : "Unknown error";
  } finally {
    const errors: string[] = [];
    try { await isolated?.close(); } catch { errors.push("Bridge cleanup failed"); }
    const removed = owned.map((dir) => { try { return removeOwnedDirectory(dir); } catch { errors.push("Owned directory cleanup failed"); return false; } });
    const retained = [...preserved].map(([path, sha256]) => ({ name: path.split("/").at(-1), sha256, unchanged: existsSync(path) && createHash("sha256").update(readFileSync(path)).digest("hex") === sha256 }));
    report.cleanup = { processes: isolated?.processCleanup, removed, errors, retained, complete: Boolean(isolated?.processCleanup?.complete) && removed.every(Boolean) && errors.length === 0 && retained.every((item) => item.unchanged) };
    if (!(report.cleanup as { complete: boolean }).complete) report.status = "FAIL";
    report.finishedAt = new Date().toISOString();
    save("summary.json", report);
    if (args.summary) { mkdirSync(dirname(args.summary), { recursive: true }); writeFileSync(args.summary, `${JSON.stringify(scrub({ ...report, evidenceDirectory: evidence }, secrets), null, 2)}\n`, { flag: "wx", mode: 0o600 }); }
  }
  console.log(JSON.stringify({ status: report.status, feature: args.feature, checks: report.checks, error: report.error, evidenceDirectory: evidence, cleanup: report.cleanup }, null, 2));
  return report.status === "PASS" ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) verifySpecCustom(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Verification failed"); process.exitCode = 1; });
