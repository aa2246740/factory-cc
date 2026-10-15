import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { publicSelection, type UpstreamSelection } from "../src/upstream/providers.js";
import { summarizeUsage, type UsageLedgerEvent } from "../src/runtime/usage.js";
import {
  beginFactoryLaunch, endFactoryLaunch, resolveSelection, rolesSeen, runDroid, runE2eCommand, startDroidDaemon, startSdkBridge,
  type CapturedCommand, type IsolatedBridge,
} from "./e2e-lib.js";
import { redactText, writeJson } from "./lib.js";

export const PACKAGE_JSON = `${JSON.stringify({
  name: "relay-mission-sum-fixture", private: true, type: "module", scripts: { test: "node --test" },
}, null, 2)}\n`;
export const ACCEPTANCE_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { sum } from './sum.js';",
  "test('adds positive numbers', () => assert.equal(sum(2, 3), 5));",
  "test('adds negative numbers', () => assert.equal(sum(-2, -3), -5));",
  "test('adds mixed signs and zero', () => { assert.equal(sum(-2, 3), 1); assert.equal(sum(0, 4), 4); });",
  "",
].join("\n");

export async function runE2eMission(): Promise<number> {
  const startedAt = Date.now();
  const timeoutMs = missionTimeout();
  const evidence = join(process.cwd(), "evidence", "local", `e2e-mission-${stamp()}`);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(process.cwd(), "evidence/e2e-mission-current.txt"), `${evidence}\n`);
  let selection: UpstreamSelection | undefined;
  let isolated: IsolatedBridge | undefined;
  let daemon: ReturnType<typeof startDroidDaemon> | undefined;
  let launchId: string | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let baseline: CapturedCommand | undefined;
  let captured: CapturedCommand | undefined;
  let tests: CapturedCommand | undefined;
  let failure: string | undefined;
  let runtimeBeforeCleanup: Record<string, unknown> | undefined;
  let runtimeAfterCleanup: Record<string, unknown> | undefined;
  let sessionsBeforeCleanup: Array<{ bridgeSessionId: string; state: string; pendingToolIds: string[] }> = [];
  const cleanupErrors: string[] = [];
  let fixtureCreated = false;
  try {
    selection = await resolveSelection();
    writeJson(join(evidence, "upstream.json"), publicSelection(selection));
    isolated = await startSdkBridge(0, join(evidence, "bridge-data"), selection);
    const repo = isolated.workspace;
    writeFixture(repo);
    fixtureCreated = true;
    await checkedCommand("git", ["init"], repo);
    await checkedCommand("git", ["add", "."], repo);
    await checkedCommand("git", ["-c", "user.email=relay@example.invalid", "-c", "user.name=Relay Fixture", "commit", "-m", "Create intentionally broken sum fixture"], repo);
    baseline = await runE2eCommand(process.execPath, ["--test", "--test-reporter=tap", "sum.test.js"], { cwd: repo, timeoutMs: 30_000 });
    if (baseline.code !== 1 || baseline.timedOut || !baseline.stdout.includes("not ok")) {
      throw new Error("The untouched fixture did not reproduce its expected failing assertions; refusing to run a Mission.");
    }

    // Leave Factory's own planning, built-in skills, Mission artifacts and
    // worker/validator orchestration intact. No seeded Mission pack or forced
    // StartMissionRun call can satisfy this acceptance run.
    const daemonPort = process.env.BRIDGE_E2E_DAEMON_PORT;
    if (daemonPort) {
      const port = Number(daemonPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("BRIDGE_E2E_DAEMON_PORT must be a TCP port");
      daemon = startDroidDaemon(isolated.home, isolated.token, port);
    }
    launchId = await beginFactoryLaunch(isolated);
    let lastRequestCount = 0;
    let lastProgressAt = Date.now();
    const active = isolated;
    progressTimer = setInterval(() => {
      const snapshot = missionSnapshot(active.factoryHome);
      if (active.app.records.length !== lastRequestCount) {
        lastRequestCount = active.app.records.length;
        lastProgressAt = Date.now();
      }
      const progress = {
        at: new Date().toISOString(), elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        requests: active.app.records.length, requestedRoles: [...new Set(rolesSeen(active.app))],
        validation: snapshot.validation, features: snapshot.features, missionState: snapshot.missionState,
        httpSilenceSec: Math.round((Date.now() - lastProgressAt) / 1000), model: selection!.provider.model,
        nativeRuntime: active.app.runtimeStatus(),
      };
      writeJson(join(evidence, "progress.json"), progress);
      writeJson(join(process.cwd(), "evidence/e2e-mission-live.json"), progress);
      console.log(`[e2e-mission] t=${progress.elapsedSec}s req=${progress.requests} roles=${progress.requestedRoles.join(",")} state=${progress.missionState}`);
    }, 15_000);
    captured = await runDroid([
      "exec", "--mission", "--output-format", "json", "-m", "relay-orchestrator",
      "--worker-model", "relay-worker", "--validator-model", "relay-validator", "--auto", "high", "-f", "MISSION.md",
    ], { home: isolated.home, token: isolated.token, cwd: repo, timeoutMs, launchId });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    if (isolated) {
      // Official SessionEnd/PostToolUse hooks can finish after Droid's final
      // model response. Observe their bounded drain before teardown could mask
      // a stranded worker or turn it into an expected shutdown cancellation.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      runtimeBeforeCleanup = isolated.app.runtimeStatus();
      sessionsBeforeCleanup = isolated.app.store.list().map((session) => ({
        bridgeSessionId: session.bridgeSessionId, state: session.state, pendingToolIds: [...session.pendingToolIds],
      }));
      // The launcher is an authenticated cleanup authority, but it must never
      // turn missing worker completion signals into a passing pre-cleanup gate.
      if (launchId) {
        try { await endFactoryLaunch(isolated, launchId, !captured || captured.code !== 0 || captured.timedOut); }
        catch (error) { cleanupErrors.push(String(error)); }
      }
    }
    try { await daemon?.stop(); } catch (error) { cleanupErrors.push(String(error)); }
    try { await isolated?.close(); } catch (error) { cleanupErrors.push(String(error)); }
    runtimeAfterCleanup = isolated?.app.runtimeStatus();
  }

  // Freeze execution before inspecting the result or running the final tests.
  // The harness never writes features.json, state.json, validation artifacts or
  // worker skills; every such artifact below must come from the real workflow.
  if (fixtureCreated && isolated) {
    tests = await runE2eCommand("npm", ["test"], { cwd: isolated.workspace, timeoutMs: 60_000 });
  }
  const snapshot = isolated ? missionSnapshot(isolated.factoryHome) : emptySnapshot();
  const missionHandoffs = readMissionHandoffs(snapshot);
  const usageEvents = isolated ? readUsageEvents(join(isolated.config.logDir, "usage.jsonl")) : [];
  const factoryToolCalls = isolated ? readFactoryToolCalls(join(isolated.config.logDir, "requests.jsonl")) : [];
  const bridgeErrors = isolated ? readBridgeErrors(join(isolated.config.logDir, "bridge.jsonl")) : [];
  const toolFreeSessions = isolated ? readToolFreeSessionActivity(
    join(isolated.config.logDir, "requests.jsonl"), join(isolated.config.dataDir, "claude-config"), isolated.app.store.list(),
  ) : [];
  const unsettledSessions = sessionsBeforeCleanup.filter((session) => ["NEW", "GENERATING", "RESUMING", "WAITING_DROID_TOOL"].includes(session.state)
    || session.pendingToolIds.length > 0);
  const completedFactoryTools = new Set(factoryToolCalls.filter((call) => call.resultObserved && !call.isError).map((call) => call.name));
  const roleEvidence = (isolated?.app.store.list() ?? []).filter((session) => session.sdkSessionId).map((session) => ({
    role: session.role, bridgeSessionId: session.bridgeSessionId, sdkSessionId: session.sdkSessionId,
    state: session.state,
    // Factory's title/readiness helpers can inherit a model header. Require a
    // real Mission session with lifecycle capabilities as well as SDK activity.
    missionSession: (isolated?.app.records ?? []).some((record) => record.authOk && record.sessionHint === session.bridgeSessionId
      && (session.role === "orchestrator"
        ? record.toolNames?.some((name) => name === "ProposeMission" || name === "StartMissionRun")
        : record.toolNames?.includes("EndFeatureRun"))),
    providerMessages: new Set(usageEvents.filter((event) => event.source === "provider_message"
      && event.status === "reported" && event.sdkSessionId === session.sdkSessionId && event.messageId)
      .map((event) => event.messageId)).size,
  }));
  const uniqueRoles = [...new Set(roleEvidence.filter((item) => item.missionSession && item.providerMessages > 0).map((item) => item.role))];
  const droidResult = objectJson(captured?.stdout);
  const gates = {
    droidSuccessful: Boolean(captured && captured.code === 0 && !captured.timedOut && droidResult
      && droidResult.is_error !== true && droidResult.type !== "error"),
    threeRoles: ["orchestrator", "worker", "validator"].every((role) => uniqueRoles.includes(role as typeof uniqueRoles[number])),
    factoryWorkflowObserved: ["Skill", "ProposeMission", "StartMissionRun"].every((name) => completedFactoryTools.has(name)),
    missionCompleted: snapshot.missionState === "completed" && snapshot.missionDirs.length === 1 && snapshot.errors.length === 0,
    featuresDone: snapshot.features.length > 0 && snapshot.features.every((item) => item.status === "completed"),
    validationGreen: snapshot.validation.length > 0 && snapshot.validation.every((item) => item.status === "passed"),
    testsGreen: Boolean(tests && tests.code === 0 && !tests.timedOut),
    originalTestsPreserved: Boolean(isolated && fixtureCreated
      && fileEquals(join(isolated.workspace, "sum.test.js"), ACCEPTANCE_TEST)
      && fileEquals(join(isolated.workspace, "package.json"), PACKAGE_JSON)),
    baselineFailedAsExpected: Boolean(baseline && baseline.code === 1 && !baseline.timedOut && baseline.stdout.includes("not ok")),
    nativeRuntimeHealthy: Boolean(runtimeBeforeCleanup
      && Array.isArray(runtimeBeforeCleanup.fatalErrors) && runtimeBeforeCleanup.fatalErrors.length === 0
      && Array.isArray(object(runtimeBeforeCleanup.control)?.failures) && (object(runtimeBeforeCleanup.control)?.failures as unknown[]).length === 0
      && bridgeErrors.length === 0),
    toolFreeHelpersRespected: toolFreeSessions.every((session) => session.transcriptFound && session.nativeToolCalls.every((call) => call.denied)),
    nativeWorkSettled: Boolean(runtimeBeforeCleanup && runtimeBeforeCleanup.pendingHostCalls === 0
      && runtimeBeforeCleanup.pendingApprovals === 0 && runtimeBeforeCleanup.activeNativeTurns === 0
      && unsettledSessions.length === 0),
    cleanupSuccessful: cleanupErrors.length === 0 && isolated?.processCleanup?.complete === true
      && captured?.processCleanup.complete === true && runtimeAfterCleanup?.activeNativeSessions === 0,
  };
  const status = !failure && Object.values(gates).every(Boolean) ? "PASS" : "FAIL";
  const redact = (text: string) => {
    let result = redactText(text);
    if (isolated?.token) result = result.replaceAll(isolated.token, "[redacted]");
    if (isolated?.config.adminToken) result = result.replaceAll(isolated.config.adminToken, "[redacted]");
    const key = selection ? process.env[selection.provider.tokenEnv] : undefined;
    if (key) result = result.replaceAll(key, "[redacted]");
    return result;
  };
  const report = {
    suite: "e2e-mission", workflow: "factory-native-unseeded", status,
    upstream: selection ? publicSelection(selection) : undefined,
    durationSec: Math.round((Date.now() - startedAt) / 1000), timeoutMs,
    requestCount: isolated?.app.records.length ?? 0,
    droid: captured, droidResult, baseline, tests,
    roles: isolated ? rolesSeen(isolated.app) : [], uniqueRoles, roleEvidence,
    factoryToolCalls,
    missionHandoffs,
    ...gates, failedGates: Object.entries(gates).filter(([, passed]) => !passed).map(([gate]) => gate),
    validation: snapshot.validation, features: snapshot.features, missionState: snapshot.missionState,
    missionDir: snapshot.missionDir, missionDirs: snapshot.missionDirs, artifactErrors: snapshot.errors,
    workspace: isolated?.workspace, factoryHome: isolated?.factoryHome,
    cache: { ...summarizeUsage(usageEvents), representativeOfClaudeSubscription: false },
    failure, cleanupErrors,
    runtimeBeforeCleanup, runtimeAfterCleanup, unsettledSessions, bridgeErrors,
    toolFreeSessions,
    processCleanup: isolated?.processCleanup,
    hostHooks: isolated?.hostHooks,
    launchId,
    notes: [
      "PASS requires successful Droid exit, completed Factory skill/planning/start tool roundtrips, real SDK/provider activity for all three roles, completed Mission state and features, passed validation, unchanged passing fixture tests, no execution of native tools from tool-free helpers, no fatal native runtime/control errors, and no stranded native turns or host tool handlers before cleanup.",
      "Factory generates the plan, skills, features and validation artifacts through its normal workflow; the harness does not seed or repair those artifacts.",
      "The Mission has a positive time limit; timeout, interruption and exit clean up owned CLI processes and the bridge SDK sessions. Linux process identity tracking verifies no live owned descendants remain, including previously detached/reparented children; it reads no process environments or arguments.",
      "Factory uses an isolated FACTORY_HOME_OVERRIDE plus an explicit --settings file with a literal local bridge token; HOME is unchanged.",
      "The selected BYOK provider's reported Claude Code usage is recorded. These numbers do not establish Claude subscription cache behavior.",
    ],
  };
  const sanitized = JSON.parse(redact(JSON.stringify(report))) as typeof report;
  writeJson(join(evidence, "result.json"), sanitized);
  writeJson(join(process.cwd(), "evidence/e2e-mission.json"), sanitized);
  console.log(JSON.stringify({ status, failedGates: report.failedGates, uniqueRoles, missionState: snapshot.missionState, evidence, failure: failure ? redact(failure) : undefined }, null, 2));
  return status === "PASS" ? 0 : 1;
}

function writeFixture(repo: string): void {
  writeFileSync(join(repo, "package.json"), PACKAGE_JSON);
  writeFileSync(join(repo, "sum.js"), "export function sum(a, b) { return a - b; }\n");
  writeFileSync(join(repo, "sum.test.js"), ACCEPTANCE_TEST);
  writeFileSync(join(repo, "MISSION.md"), [
    "# Fix addition through a complete Factory Mission",
    "",
    "Fix sum.js so sum(a, b) adds two numbers. Preserve the existing tests and package.json, and run npm test.",
    "Use the normal Factory Mission workflow and required skills: plan the work, hand implementation to a worker, and complete scrutiny plus user-testing/validation.",
    "This is a backend-only fixture with no dependencies to install or services to launch. Validate behavior with its automated tests.",
    "Create only one implementation feature. Do not skip verification, fabricate validation results, or change unrelated files.",
    "Run the Mission to completion; do not stop after writing a plan.",
    "",
  ].join("\n"));
}

async function checkedCommand(command: string, args: string[], cwd: string): Promise<void> {
  const result = await runE2eCommand(command, args, { cwd, timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(`${command} fixture setup failed: ${result.stderr.slice(-2000)}`);
}

interface MissionSnapshot {
  missionDirs: string[];
  missionDir?: string;
  missionState: string;
  validation: Array<{ id: string; status: string }>;
  features: Array<{ id: string; status: string; skillName?: string; completedWorkerSessionId?: string }>;
  errors: string[];
}

function emptySnapshot(): MissionSnapshot {
  return { missionDirs: [], missionState: "unknown", validation: [], features: [], errors: [] };
}

export function missionSnapshot(factoryHome: string): MissionSnapshot {
  const snapshot = emptySnapshot();
  const root = join(factoryHome, "missions");
  if (!existsSync(root)) return snapshot;
  try {
    snapshot.missionDirs = readdirSync(root).map((name) => join(root, name)).filter((dir) => statSync(dir).isDirectory());
    if (snapshot.missionDirs.length !== 1) {
      if (snapshot.missionDirs.length > 1) snapshot.errors.push("Multiple Mission directories in an isolated single-Mission run; refusing to guess.");
      return snapshot;
    }
    const dir = snapshot.missionDirs[0]!;
    snapshot.missionDir = dir;
    const readArtifact = (name: string): Record<string, unknown> | undefined => {
      const path = join(dir, name);
      if (!existsSync(path)) return undefined;
      const parsed = objectJson(readFileSync(path, "utf8"));
      if (!parsed) snapshot.errors.push(`${name} is not a valid JSON object`);
      return parsed;
    };
    const state = readArtifact("state.json");
    snapshot.missionState = typeof state?.state === "string" ? state.state : "unknown";
    const validation = readArtifact("validation-state.json");
    if (validation?.assertions && typeof validation.assertions === "object" && !Array.isArray(validation.assertions)) {
      snapshot.validation = Object.entries(validation.assertions).map(([id, value]) => ({ id, status: statusOf(value) }));
    }
    const features = readArtifact("features.json");
    if (Array.isArray(features?.features)) snapshot.features = features.features.map((value: unknown) => {
      const item = object(value);
      return { id: typeof item?.id === "string" ? item.id : "unknown", status: statusOf(item),
        skillName: typeof item?.skillName === "string" ? item.skillName : undefined,
        completedWorkerSessionId: typeof item?.completedWorkerSessionId === "string" ? item.completedWorkerSessionId : undefined };
    });
  } catch (error) {
    snapshot.errors.push(error instanceof Error ? error.message : String(error));
  }
  return snapshot;
}

export function readUsageEvents(file: string): UsageLedgerEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => objectJson(line)).filter((event): event is Record<string, unknown> => Boolean(event)) as unknown as UsageLedgerEvent[];
}

export function readBridgeErrors(file: string): Array<{ at?: unknown; event?: unknown; data?: unknown }> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((line) => {
    const row = objectJson(line);
    return row?.level === "error" ? [{ at: row.at, event: row.event, data: row.data }] : [];
  });
}

/** Inspect only this BYOK run's isolated native transcripts, never host Claude data. */
export function readToolFreeSessionActivity(requestLog: string, isolatedClaudeConfig: string,
  sessions: Array<{ bridgeSessionId: string; sdkSessionId?: string }>): Array<{
    bridgeSessionId: string; sdkSessionId: string; transcriptFound: boolean; nativeToolCalls: Array<{ id: string; name: string; denied: boolean }>;
  }> {
  if (!existsSync(requestLog)) return [];
  const catalogs = new Map<string, boolean[]>();
  for (const line of readFileSync(requestLog, "utf8").split("\n")) {
    const row = objectJson(line);
    const body = object(row?.body);
    if (typeof row?.session !== "string" || !body) continue;
    const requests = catalogs.get(row.session) ?? [];
    requests.push(Array.isArray(body.tools) && body.tools.length === 0);
    catalogs.set(row.session, requests);
  }
  const transcripts = new Map<string, string>();
  const visit = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Do not follow symlinks out of the isolated BYOK configuration.
      if (entry.isDirectory()) visit(join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) transcripts.set(entry.name, join(dir, entry.name));
    }
  };
  visit(isolatedClaudeConfig);
  const denials = new Set<string>();
  const bridgeLog = join(dirname(requestLog), "bridge.jsonl");
  for (const line of existsSync(bridgeLog) ? readFileSync(bridgeLog, "utf8").split("\n") : []) {
    const row = objectJson(line);
    const data = object(row?.data);
    if (row?.event === "host_tool_access_denied" && typeof data?.sessionId === "string" && typeof data.toolUseId === "string") {
      denials.add(`${data.sessionId}:${data.toolUseId}`);
    }
  }
  return sessions.flatMap((session) => {
    const requests = catalogs.get(session.bridgeSessionId);
    if (!session.sdkSessionId || !requests?.length || !requests.every(Boolean)) return [];
    const transcript = transcripts.get(`${session.sdkSessionId}.jsonl`);
    const nativeToolCalls = new Map<string, { id: string; name: string; denied: boolean }>();
    for (const line of transcript ? readFileSync(transcript, "utf8").split("\n") : []) {
      const row = objectJson(line);
      const content = object(row?.message)?.content;
      if (!Array.isArray(content)) continue;
      for (const raw of content) {
        const block = object(raw);
        if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          nativeToolCalls.set(block.id, { id: block.id, name: block.name, denied: denials.has(`${session.bridgeSessionId}:${block.id}`) });
        }
      }
    }
    return [{ bridgeSessionId: session.bridgeSessionId, sdkSessionId: session.sdkSessionId,
      transcriptFound: Boolean(transcript), nativeToolCalls: [...nativeToolCalls.values()] }];
  });
}

export function readMissionHandoffs(snapshot: MissionSnapshot): Array<{
  workerSessionId: string; featureId: string; endFeatureRunObserved: true; matchesCompletedFeature: boolean;
}> {
  if (!snapshot.missionDir) return [];
  const file = join(snapshot.missionDir, "worker-transcripts.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((line) => {
    const row = objectJson(line);
    if (!row || typeof row.workerSessionId !== "string" || typeof row.featureId !== "string"
      || typeof row.skeleton !== "string" || !/^## Tool: EndFeatureRun\s*$/m.test(row.skeleton)) return [];
    const feature = snapshot.features.find((item) => item.id === row.featureId);
    return [{ workerSessionId: row.workerSessionId, featureId: row.featureId, endFeatureRunObserved: true as const,
      matchesCompletedFeature: feature?.status === "completed" && feature.completedWorkerSessionId === row.workerSessionId }];
  });
}

interface FactoryToolEvidence {
  id: string;
  name: string;
  sessionId: string;
  skill?: string;
  resultObserved: boolean;
  isError?: boolean;
}

/** Read actual tool call/result history, never infer execution from a tool catalog. */
export function readFactoryToolCalls(file: string): FactoryToolEvidence[] {
  if (!existsSync(file)) return [];
  const calls = new Map<string, FactoryToolEvidence>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const row = objectJson(line);
    const sessionId = row?.session;
    const messages = object(row?.body)?.messages;
    if (typeof sessionId !== "string" || !Array.isArray(messages)) continue;
    for (const message of messages) {
      const item = object(message);
      if (!Array.isArray(item?.content)) continue;
      for (const raw of item.content) {
        const block = object(raw);
        if (item.role === "assistant" && block?.type === "tool_use"
            && typeof block.id === "string" && typeof block.name === "string") {
          const key = `${sessionId}:${block.id}`;
          if (!calls.has(key)) {
            const input = object(block.input);
            const skill = input?.skill ?? input?.name ?? input?.skillName;
            calls.set(key, { id: block.id, name: block.name, sessionId, resultObserved: false,
              skill: block.name === "Skill" && typeof skill === "string" && /^[A-Za-z0-9_:/.-]{1,128}$/.test(skill) ? skill : undefined });
          }
        } else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
          const call = calls.get(`${sessionId}:${block.tool_use_id}`);
          if (call) {
            call.resultObserved = true;
            call.isError = block.is_error === true;
          }
        }
      }
    }
  }
  return [...calls.values()];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function objectJson(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try { return object(JSON.parse(text)); } catch { return undefined; }
}

function statusOf(value: unknown): string {
  const item = object(value);
  return typeof item?.status === "string" ? item.status : "unknown";
}

export function fileEquals(path: string, expected: string): boolean {
  try { return readFileSync(path, "utf8") === expected; } catch { return false; }
}

function missionTimeout(): number {
  const timeout = Number(process.env.BRIDGE_E2E_MISSION_TIMEOUT_MS ?? 60 * 60 * 1000);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 60 * 60 * 1000) {
    throw new Error("BRIDGE_E2E_MISSION_TIMEOUT_MS must be positive and at most 3600000");
  }
  return timeout;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runE2eMission().then((code) => process.exit(code)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
