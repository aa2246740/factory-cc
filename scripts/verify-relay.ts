#!/usr/bin/env -S node --import tsx
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { droidEnv, resolveSelection, runE2eCommand, startSdkBridge, type IsolatedBridge } from "./e2e-lib.js";
import { runDroid } from "./run-droid.js";
import { summarizeUsage, type UsageLedgerEvent } from "../src/runtime/usage.js";
import { publicSelection } from "../src/upstream/providers.js";

const help = `Usage: npm run verify:relay -- [options]

  --feature chat       Real Droid -> Bridge -> native Claude Code read/write and resume verification
  --timeout <ms>       Per-Droid-invocation timeout (default 600000)
  --summary <new.json>  Also save the sanitized result to a NEW file (never overwrites)
  --doctor <manifest>  Read-only checks of this harness's RUNNING isolated instance
  --offline-check      Check local prerequisites only; does not prove instance or model readiness
  --help               Show this help without credentials, processes or model calls

Explicit BYOK selection is required: BRIDGE_UPSTREAM_BASE_URL,
BRIDGE_UPSTREAM_MODEL, BRIDGE_UPSTREAM_TOKEN_ENV (whose named key must be set).
BRIDGE_DROID_EXECUTABLE and BRIDGE_CLAUDE_EXECUTABLE select unmodified official CLIs.
No subscription credentials are read. Proxy/CA settings are preserved.

The chat run launches a fresh bridge on port 0, calls read-only doctor, drives the
production run-droid wrapper twice, independently checks file effects and native
session/usage evidence, then removes its own private directories and processes.
Sanitized commands, outputs, checks and cleanup proof survive in evidence/local.
A private manifest exists only while the run is active; --doctor never sends a
model prompt. Health/doctor success alone is NOT model availability or all-feature coverage.`;

interface Args { feature?: "chat"; timeoutMs: number; summary?: string; doctor?: string; offline: boolean; help: boolean }
export function parseVerificationArgs(argv: string[]): Args {
  const args: Args = { timeoutMs: 600_000, offline: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index]!;
    if (option === "--help" || option === "-h") { args.help = true; continue; }
    if (option === "--offline-check") { args.offline = true; continue; }
    if (!["--feature", "--timeout", "--summary", "--doctor"].includes(option)) throw new Error("Unknown verification option; use --help.");
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}.`);
    if (option === "--feature") {
      if (value !== "chat") throw new Error("Only the chat feature is implemented; this harness does not certify every Factory model path.");
      args.feature = value;
    } else if (option === "--timeout") {
      const timeout = Number(value);
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new Error("--timeout must be a positive integer of milliseconds at most 2147483647.");
      args.timeoutMs = timeout;
    } else if (option === "--summary") args.summary = resolve(value);
    else args.doctor = resolve(value);
  }
  if (!args.help && Number(Boolean(args.feature)) + Number(Boolean(args.doctor)) + Number(args.offline) !== 1) throw new Error("Choose exactly one of --feature chat, --doctor or --offline-check.");
  if (args.summary && !args.feature) throw new Error("--summary requires --feature chat.");
  return args;
}

interface OwnedDirectory { path: string; dev: number; ino: number }
export function ownDirectory(prefix: string): OwnedDirectory {
  const path = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  const info = lstatSync(path);
  return { path, dev: info.dev, ino: info.ino };
}
export function removeOwnedDirectory(owned: OwnedDirectory): boolean {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(owned.path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== owned.dev || info.ino !== owned.ino
    || realpathSync(owned.path) !== owned.path || dirname(owned.path) !== realpathSync(tmpdir())
    || !/^relay-(?:e2e-home-|e2e-ws-|verify-private-)/.test(basename(owned.path))) {
    throw new Error("Refusing cleanup: temporary directory ownership changed.");
  }
  rmSync(owned.path, { recursive: true, force: false });
  return !existsSync(owned.path);
}

interface Manifest {
  kind: "relay-verification-instance"; version: 1; url: string; adminToken: string;
  home: OwnedDirectory; workspace: OwnedDirectory; data: OwnedDirectory;
  droidExecutable: string; claudeExecutable: string;
}
function readManifest(path: string): Manifest {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Doctor requires this user's regular mode-0600 private manifest.");
  const value = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (value.kind !== "relay-verification-instance" || value.version !== 1 || typeof value.adminToken !== "string") throw new Error("Invalid verification manifest.");
  const url = new URL(value.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Doctor only accepts an owned loopback instance.");
  for (const [owned, prefix] of [[value.home, "relay-e2e-home-"], [value.workspace, "relay-e2e-ws-"], [value.data, "relay-verify-private-"]] as const) {
    const current = lstatSync(owned.path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino
      || realpathSync(owned.path) !== owned.path || dirname(owned.path) !== realpathSync(tmpdir()) || !basename(owned.path).startsWith(prefix)) throw new Error("Doctor instance directory ownership did not match.");
  }
  return value;
}

function executable(name: string): string {
  const candidates = name.includes("/") ? [resolve(name)] : (process.env.PATH ?? "").split(":").map((dir) => resolve(dir, name));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* next PATH candidate */ }
  }
  throw new Error("An official CLI executable was not found; set BRIDGE_DROID_EXECUTABLE and BRIDGE_CLAUDE_EXECUTABLE.");
}
function prerequisites() {
  const require = createRequire(import.meta.url);
  const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const sdk = JSON.parse(readFileSync(join(dirname(sdkEntry), "package.json"), "utf8")) as { version: string };
  return { droidExecutable: executable(process.env.BRIDGE_DROID_EXECUTABLE ?? "droid"), claudeExecutable: executable(process.env.BRIDGE_CLAUDE_EXECUTABLE ?? "claude"), sdkVersion: sdk.version, nodeVersion: process.version };
}

async function readEndpoint(manifest: Manifest, path: string, admin = false): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${manifest.url}${path}`, { headers: admin ? { authorization: `Bearer ${manifest.adminToken}` } : {}, redirect: "error", signal: AbortSignal.timeout(5_000) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
export async function doctorInstance(manifestPath: string): Promise<Record<string, unknown>> {
  const manifest = readManifest(manifestPath);
  const [health, runtime, sessions, unauthorized] = await Promise.all([
    readEndpoint(manifest, "/healthz"), readEndpoint(manifest, "/internal/runtime", true), readEndpoint(manifest, "/internal/sessions", true), readEndpoint(manifest, "/internal/runtime"),
  ]);
  const checkPrivate = (path: string) => { const info = lstatSync(path); return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0; };
  const checks = {
    healthIsSdk: health.status === 200 && health.body.ok === true && health.body.mode === "sdk" && health.body.sdk === undefined && health.body.upstream === undefined,
    authenticatedSdkByokRuntime: runtime.status === 200 && runtime.body.kind === "sdk" && runtime.body.authMode === "byok",
    adminReadWorks: sessions.status === 200 && Array.isArray(sessions.body.sessions),
    unauthenticatedAdminReadDenied: unauthorized.status === 401,
    ownedDirectoriesMatch: true,
    privateFactorySettings: checkPrivate(join(manifest.home.path, ".factory/settings.json")),
    privateHookCredential: checkPrivate(join(manifest.home.path, ".factory/relay-hooks.json")),
    isolatedClaudeConfig: lstatSync(join(manifest.data.path, "claude-config")).isDirectory(),
  };
  return { at: new Date().toISOString(), status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", readOnly: true,
    modelAvailability: "NOT_TESTED_BY_DOCTOR", checks, runtime: runtime.body, sessionCount: Array.isArray(sessions.body.sessions) ? sessions.body.sessions.length : null };
}

function jsonRows(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}
function nativeEvidence(configDir: string, sdkSessionId?: string) {
  let finalAssistantText: string | undefined;
  const tools = new Map<string, { id: string; name: string; resultSeen: boolean; isError: boolean }>();
  const results = new Map<string, boolean>();
  let files = 0;
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && (!sdkSessionId || entry.name === `${sdkSessionId}.jsonl`)) {
        if (++files > 1000 || statSync(path).size > 20_000_000) throw new Error("Native transcript evidence exceeded its bounded scan.");
        for (const row of jsonRows(path)) {
          const message = row.message as { content?: unknown } | undefined;
          if (!Array.isArray(message?.content)) continue;
          if (row.type === "assistant") {
            const text = (message.content as Array<Record<string, unknown>>).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
            if (text) finalAssistantText = text;
          }
          for (const block of message.content as Array<Record<string, unknown>>) {
            if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") tools.set(block.id, { id: block.id, name: block.name, resultSeen: false, isError: false });
            if (block.type === "tool_result" && typeof block.tool_use_id === "string") results.set(block.tool_use_id, block.is_error === true);
          }
        }
      }
    }
  };
  walk(join(configDir, "projects"));
  return { tools: [...tools.values()].map((tool) => ({ ...tool, resultSeen: results.has(tool.id), isError: results.get(tool.id) ?? false })), finalAssistantText };
}

/** Droid aggregates Bridge tool-trace text; the actual native final answer must independently match. */
export function completionMatches(droidResult: string, nativeFinalText: string | undefined, expected: string): boolean {
  return droidResult.trim().split("\n").at(-1)?.trim() === expected && nativeFinalText?.trim() === expected;
}

export function runtimeIsDrained(runtime: Record<string, unknown>): boolean {
  const control = runtime.control as Record<string, unknown> | undefined;
  return runtime.activeNativeSessions === 0 && runtime.activeNativeTurns === 0 && runtime.pendingHostCalls === 0 && runtime.pendingApprovals === 0
    && Array.isArray(runtime.fatalErrors) && runtime.fatalErrors.length === 0 && control?.activeHostSessions === 0 && control.pendingApprovals === 0
    && Array.isArray(control.failures) && control.failures.length === 0;
}
function digest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function writeNewJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
function scrub(value: unknown, secrets: string[]): unknown {
  let json = JSON.stringify(value);
  for (const secret of secrets.filter(Boolean)) json = json.split(secret).join("[REDACTED]");
  return JSON.parse(json.replace(/(?:sk-|fk-|ant-|Bearer\s+)[A-Za-z0-9._\-]{8,}/g, "[REDACTED]"));
}

export async function verifyRelay(argv: string[]): Promise<number> {
  const args = parseVerificationArgs(argv);
  if (args.help) { console.log(help); return 0; }
  if (args.doctor) { const result = await doctorInstance(args.doctor); console.log(JSON.stringify(result, null, 2)); return result.status === "PASS" ? 0 : 1; }
  const local = prerequisites();
  if (args.offline) { console.log(JSON.stringify({ status: "PASS", scope: "LOCAL_PREREQUISITES_ONLY", ...local, instanceReadiness: "NOT_TESTED", modelAvailability: "NOT_TESTED" }, null, 2)); return 0; }
  if (args.summary && existsSync(args.summary)) throw new Error("Summary path already exists; choose a new filename. Existing evidence is never overwritten.");
  const selection = await resolveSelection();
  const evidence = join(dirname(dirname(fileURLToPath(import.meta.url))), "evidence/local", `verify-relay-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
  mkdirSync(evidence, { recursive: true });
  const dirs: OwnedDirectory[] = [];
  let isolated: IsolatedBridge | undefined;
  let manifestPath: string | undefined;
  const actions: Record<string, unknown>[] = [];
  const secrets = [process.env[selection.provider.tokenEnv] ?? ""];
  const report: Record<string, unknown> = {
    suite: "verification-skill-chat", status: "FAIL", startedAt: new Date().toISOString(), feature: "chat",
    scope: ["official Droid production wrapper", "native Read/Write", "official --session-id resume", "native usage", "owned cleanup"],
    exclusions: ["every Factory model-using path", "Mission", "real Anthropic subscription", "provider billing", "compaction"],
    authentication: { mode: "isolated BYOK", subscriptionCredentialsRead: false, ...publicSelection(selection) },
    versions: { sdk: local.sdkVersion, node: local.nodeVersion }, actions,
  };
  const preserved = new Map<string, string>();
  const save = (name: string, value: unknown) => { const path = join(evidence, name); writeNewJson(path, scrub(value, secrets)); preserved.set(path, digest(path)); };
  try {
    const home = ownDirectory("relay-e2e-home-"); dirs.push(home);
    const workspace = ownDirectory("relay-e2e-ws-"); dirs.push(workspace);
    const data = ownDirectory("relay-verify-private-"); dirs.push(data);
    mkdirSync(join(data.path, "claude-config"), { mode: 0o700 });
    const previousClaude = process.env.BRIDGE_CLAUDE_EXECUTABLE;
    try {
      process.env.BRIDGE_CLAUDE_EXECUTABLE = local.claudeExecutable;
      isolated = await startSdkBridge(0, data.path, selection, { home: home.path, workspace: workspace.path });
    } finally {
      if (previousClaude === undefined) delete process.env.BRIDGE_CLAUDE_EXECUTABLE;
      else process.env.BRIDGE_CLAUDE_EXECUTABLE = previousClaude;
    }
    secrets.push(isolated.token, isolated.config.adminToken);
    manifestPath = join(data.path, "verification-manifest.json");
    writeNewJson(manifestPath, { kind: "relay-verification-instance", version: 1, url: isolated.app.url, adminToken: isolated.config.adminToken,
      home, workspace, data, droidExecutable: local.droidExecutable, claudeExecutable: local.claudeExecutable } satisfies Manifest);
    console.log(`Verification instance manifest (private, removed on cleanup): ${manifestPath}`);
    const env: NodeJS.ProcessEnv = { ...droidEnv(home.path, isolated.token), CLAUDE_CONFIG_DIR: join(data.path, "claude-config"), BRIDGE_DROID_EXECUTABLE: local.droidExecutable };
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"]) delete env[name];
    const versions = await Promise.all([
      runE2eCommand(local.droidExecutable, ["--version"], { env, cwd: workspace.path, timeoutMs: 10_000 }),
      runE2eCommand(local.claudeExecutable, ["--version"], { env, cwd: workspace.path, timeoutMs: 10_000 }),
    ]);
    if (versions.some((version) => version.code !== 0)) throw new Error("Official CLI version check failed.");
    report.versions = { sdk: local.sdkVersion, node: local.nodeVersion, droid: versions[0]!.stdout.trim(), claude: versions[1]!.stdout.trim() };
    const doctor = await doctorInstance(manifestPath); save("doctor.json", { ...doctor, versions: report.versions }); report.doctor = doctor;
    if (doctor.status !== "PASS" || isolated.app.records.length !== 0) throw new Error("Read-only instance doctor failed or unexpectedly made a model request.");
    const nonce = randomBytes(12).toString("hex"), memory = `RELAY_MEMORY_${randomBytes(10).toString("hex")}`;
    const fixture = { nonce, a: 19, b: 37 };
    writeFileSync(join(workspace.path, "input.json"), `${JSON.stringify(fixture)}\n`);
    const expected = { nonce, sum: fixture.a + fixture.b };
    const invoke = async (turn: number, prompt: string, sessionId?: string) => {
      const out = join(data.path, `wrapper-turn-${turn}.json`);
      const droidArgs = ["exec", "--settings", isolated!.settingsPath, "--output-format", "json", "-m", "relay-chat", "--auto", "high", ...(sessionId ? ["--session-id", sessionId] : []), prompt];
      const wrapperArgs = ["--home", home.path, "--cwd", workspace.path, "--airgap", "1", "--timeout", String(args.timeoutMs), "--out", out, "--", ...droidArgs];
      const startedAt = new Date().toISOString();
      console.log(`Driving chat turn ${turn} through the production run-droid wrapper.`);
      let code = 1;
      let invocationError: unknown;
      try { code = await runDroid(wrapperArgs, { env: { ...env, BRIDGE_ADMIN_TOKEN: isolated!.config.adminToken, BRIDGE_CONTROL_URL: isolated!.app.url }, stdio: "ignore" }); }
      catch (error) { invocationError = error; }
      const captured = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) as { code: number; stdout: string; stderr: string } : { code, stdout: "", stderr: "Wrapper did not produce a capture." };
      const action = { action: `chat-turn-${turn}`, startedAt, completedAt: new Date().toISOString(), command: ["npm", "run", "run-droid", "--", ...wrapperArgs], stdout: captured.stdout, stderr: captured.stderr, exitCode: code,
        ...(invocationError ? { error: invocationError instanceof Error ? invocationError.message : "Wrapper failed." } : {}) };
      actions.push(action); save(`action-${turn}.json`, action);
      if (invocationError) throw invocationError;
      if (code !== 0) throw new Error(`Droid turn ${turn} failed (exit ${code}); inspect preserved action evidence.`);
      const body = JSON.parse(captured.stdout) as { session_id?: string; result?: string; is_error?: boolean };
      if (body.is_error !== false || typeof body.session_id !== "string" || typeof body.result !== "string") throw new Error(`Droid turn ${turn} did not return a successful JSON result.`);
      return body as { session_id: string; result: string; is_error: false };
    };
    const first = await invoke(1, `Use native Read to read input.json in the current directory. Use native Write to create result.json with exactly the JSON object {"nonce": <nonce read from input.json>, "sum": <a+b from input.json>}. Do not modify input.json. Remember the phrase ${memory} for the next message; do not put that phrase in any file. After the file is written reply exactly VERIFY_WRITE_OK.`);
    const afterFirst = isolated.app.store.list().map((session) => structuredClone(session));
    const firstSession = afterFirst.find((session) => session.factorySessionId === first.session_id && session.toolNames.length > 0);
    const fileBeforeResume = JSON.parse(readFileSync(join(workspace.path, "result.json"), "utf8")) as unknown;
    const firstRuntime = isolated.app.runtimeStatus();
    const firstNative = nativeEvidence(join(data.path, "claude-config"), firstSession?.sdkSessionId);
    save("after-first.json", { result: first, native: firstNative, file: fileBeforeResume, inputUnchanged: isDeepStrictEqual(JSON.parse(readFileSync(join(workspace.path, "input.json"), "utf8")), fixture), sessions: afterFirst, runtime: firstRuntime });
    if (!completionMatches(first.result, firstNative.finalAssistantText, "VERIFY_WRITE_OK") || !isDeepStrictEqual(fileBeforeResume, expected) || !firstSession?.sdkSessionId || !runtimeIsDrained(firstRuntime)) throw new Error("First-turn file/native-session/lifecycle assertions failed; preserved snapshot explains the failure.");
    const second = await invoke(2, "What exact phrase did I ask you to remember in the previous message? Reply with only that phrase. Do not use tools or read files.", first.session_id);
    const afterSecond = isolated.app.store.list();
    const secondSession = afterSecond.find((session) => session.bridgeSessionId === firstSession.bridgeSessionId);
    const runtime = isolated.app.runtimeStatus();
    const native = nativeEvidence(join(data.path, "claude-config"), secondSession?.sdkSessionId);
    const nativeTools = native.tools;
    const usages = jsonRows(join(isolated.config.logDir, "usage.jsonl"));
    const nativeUsage = summarizeUsage(usages as unknown as UsageLedgerEvent[]);
    const secondUsage = secondSession?.usage as Record<string, unknown> | undefined;
    const checks = {
      firstDroidSucceeded: first.is_error === false && completionMatches(first.result, firstNative.finalAssistantText, "VERIFY_WRITE_OK"),
      independentFileResult: isDeepStrictEqual(JSON.parse(readFileSync(join(workspace.path, "result.json"), "utf8")), expected),
      inputUnchanged: isDeepStrictEqual(JSON.parse(readFileSync(join(workspace.path, "input.json"), "utf8")), fixture),
      nativeReadCompleted: nativeTools.some((tool) => tool.name === "Read" && tool.resultSeen && !tool.isError),
      nativeWriteCompleted: nativeTools.some((tool) => tool.name === "Write" && tool.resultSeen && !tool.isError),
      secondDroidSucceeded: second.is_error === false && completionMatches(second.result, native.finalAssistantText, memory),
      sameFactorySession: first.session_id === second.session_id,
      sameNativeSession: Boolean(firstSession.sdkSessionId) && firstSession.sdkSessionId === secondSession?.sdkSessionId,
      bothHostSessionsEndedResumably: firstSession.hostEnded === "resumable" && secondSession?.hostEnded === "resumable",
      providerUsageReported: nativeUsage.status === "reported" && nativeUsage.requests > 0,
      continuationUsageReported: secondUsage?.status === "reported" && secondUsage.scope === "provider_messages",
      runtimeDrainedBeforeCleanup: runtimeIsDrained(runtime),
      noPendingStoredTools: afterSecond.every((session) => session.pendingToolIds.length === 0 && session.state === "IDLE"),
    };
    report.checks = checks;
    report.nativeUsage = nativeUsage;
    report.continuationUsage = secondUsage;
    report.cacheInterpretation = "Provider-message counters inside native Claude Code; missing fields remain unknown. A cache read is evidence of reuse, not an Anthropic subscription billing guarantee.";
    report.sessionIds = { factory: second.session_id, bridge: secondSession?.bridgeSessionId, native: secondSession?.sdkSessionId };
    save("snapshot.json", { checks, first, second, independentFileResult: JSON.parse(readFileSync(join(workspace.path, "result.json"), "utf8")), nativeTools, finalNativeAssistantText: native.finalAssistantText, nativeUsage, continuationUsage: secondUsage, runtime, sessions: afterSecond });
    report.status = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
  } catch (error) {
    report.error = error instanceof Error ? error.message : "Verification failed.";
    if (manifestPath && existsSync(manifestPath)) {
      try { const diagnostic = await doctorInstance(manifestPath); save("doctor-on-failure.json", diagnostic); report.failureDoctor = diagnostic; }
      catch (doctorError) { report.failureDoctorError = doctorError instanceof Error ? doctorError.message : "Doctor failed."; }
    }
  } finally {
    const cleanupErrors: string[] = [];
    try { await isolated?.close(); } catch { cleanupErrors.push("Bridge close failed."); }
    const removed = dirs.map((owned) => {
      try { return { kind: basename(owned.path).replace(/[a-zA-Z0-9]{6}$/, "<run>"), removed: removeOwnedDirectory(owned) }; }
      catch { cleanupErrors.push("Owned directory cleanup failed."); return { kind: "owned-temporary-directory", removed: false }; }
    });
    const retention = [...preserved].map(([path, hash]) => ({ artifact: basename(path), exists: existsSync(path), sha256: hash, unchangedAfterCleanup: existsSync(path) && digest(path) === hash }));
    const cleanup = { at: new Date().toISOString(), processes: isolated?.processCleanup, removed, errors: cleanupErrors, evidenceRetention: retention,
      complete: Boolean(isolated?.processCleanup?.complete) && removed.every((dir) => dir.removed) && cleanupErrors.length === 0 && retention.every((file) => file.unchangedAfterCleanup) };
    report.cleanup = cleanup;
    if (!cleanup.complete) report.status = "FAIL";
    report.finishedAt = new Date().toISOString();
    save("cleanup.json", cleanup);
    writeNewJson(join(evidence, "summary.json"), scrub(report, secrets));
    if (args.summary) writeNewJson(args.summary, scrub({ ...report, evidenceDirectory: evidence }, secrets));
  }
  console.log(JSON.stringify(scrub({ status: report.status, feature: "chat", evidenceDirectory: evidence, summary: args.summary ?? join(evidence, "summary.json"), checks: report.checks, cleanupComplete: (report.cleanup as { complete?: boolean })?.complete, error: report.error }, secrets), null, 2));
  return report.status === "PASS" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyRelay(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Verification failed."); process.exitCode = 1; });
}
