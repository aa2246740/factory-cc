import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { summarizeUsage } from "../src/runtime/usage.js";
import { publicSelection } from "../src/upstream/providers.js";
import { beginFactoryLaunch, endFactoryLaunch, resolveSelection, runDroid, runE2eCommand, startSdkBridge, type CapturedCommand, type IsolatedBridge } from "./e2e-lib.js";
import { ACCEPTANCE_TEST, PACKAGE_JSON, fileEquals, missionSnapshot, readBridgeErrors, readFactoryToolCalls, readMissionHandoffs, readToolFreeSessionActivity, readUsageEvents } from "./e2e-mission.js";
import { redactText, writeJson } from "./lib.js";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

/** Continue the actual Factory Mission after a harness timeout, without reseeding its artifacts. */
export async function resumeE2eMission(previousEvidence: string): Promise<number> {
  const previousDir = resolve(previousEvidence);
  const previousPath = join(previousDir, "result.json");
  const previous = JSON.parse(readFileSync(previousPath, "utf8")) as RecordValue;
  if (previous.suite !== "e2e-mission" || previous.workflow !== "factory-native-unseeded"
      || object(previous.droid)?.timedOut !== true || previous.baselineFailedAsExpected !== true
      || previous.originalTestsPreserved !== true || previous.nativeRuntimeHealthy !== true
      || previous.toolFreeHelpersRespected !== true || previous.cleanupSuccessful !== true
      || typeof previous.factoryHome !== "string" || typeof previous.workspace !== "string") {
    throw new Error("Recovery requires a cleanly stopped, healthy, isolated, unseeded Mission timeout report");
  }
  const originalStarted = statSync(previousPath).mtimeMs - Number(previous.durationSec) * 1000;
  const remainingMs = Math.floor(originalStarted + 60 * 60 * 1000 - Date.now());
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new Error("The one-hour total Mission acceptance deadline has expired");
  const factoryHome = previous.factoryHome;
  const workspace = previous.workspace;
  const initial = missionSnapshot(factoryHome);
  if (initial.errors.length || initial.missionDirs.length !== 1 || !initial.missionDir
      || !fileEquals(join(workspace, "sum.test.js"), ACCEPTANCE_TEST) || !fileEquals(join(workspace, "package.json"), PACKAGE_JSON)) {
    throw new Error("Original Mission artifacts or fixture identity could not be verified; refusing to reconstruct them");
  }
  const completedBefore = initial.features.filter((feature) => feature.status === "completed");
  const missionSessionId = basename(initial.missionDir);
  if (!/^[a-f0-9-]{36}$/.test(missionSessionId)) throw new Error("Invalid existing Mission session identity");
  const evidence = join(process.cwd(), "evidence", "local", `e2e-mission-resume-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(process.cwd(), "evidence/e2e-mission-current.txt"), `${evidence}\n`);
  const selection = await resolveSelection();
  let isolated: IsolatedBridge | undefined;
  let captured: CapturedCommand | undefined;
  let launchId: string | undefined;
  let beforeCleanup: RecordValue | undefined;
  let afterCleanup: RecordValue | undefined;
  let unsettledSessions: unknown[] = [];
  let failure: string | undefined;
  const cleanupErrors: string[] = [];
  const started = Date.now();
  let progress: ReturnType<typeof setInterval> | undefined;
  try {
    isolated = await startSdkBridge(0, join(evidence, "bridge-data"), selection, { home: dirname(factoryHome), workspace });
    launchId = await beginFactoryLaunch(isolated);
    const active = isolated;
    progress = setInterval(() => {
      const snapshot = missionSnapshot(factoryHome);
      const row = { at: new Date().toISOString(), elapsedSec: Math.round((Date.now() - started) / 1000),
        totalElapsedSec: Math.round((Date.now() - originalStarted) / 1000), requests: active.app.records.length,
        ...snapshot, nativeRuntime: active.app.runtimeStatus() };
      writeJson(join(evidence, "progress.json"), row);
      console.log(`[e2e-mission-resume] t=${row.elapsedSec}s total=${row.totalElapsedSec}s req=${row.requests} state=${row.missionState}`);
    }, 15_000);
    // --mission creates a fresh orchestrator and cannot be combined with
    // --session-id. Existing session mode and Mission models are restored by
    // Factory's documented session continuation path.
    captured = await runDroid(["exec", "--session-id", missionSessionId, "--output-format", "json",
      "-m", "relay-orchestrator", "--auto", "high",
      "Continue this existing Mission from its recorded state after the test harness time limit interrupted the previous CLI. Keep completed features and passing validations intact; finish only unfinished work using the normal Mission workflow, verify it, and run the Mission to completion. Do not create a new Mission, recreate the plan, fabricate results, or change the existing acceptance tests or package.json."],
    { home: isolated.home, token: isolated.token, cwd: workspace, timeoutMs: remainingMs, launchId });
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally {
    if (progress) clearInterval(progress);
    if (isolated) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
      beforeCleanup = isolated.app.runtimeStatus();
      unsettledSessions = isolated.app.store.list().filter((session) => ["NEW", "GENERATING", "RESUMING", "WAITING_DROID_TOOL"].includes(session.state) || session.pendingToolIds.length)
        .map((session) => ({ bridgeSessionId: session.bridgeSessionId, state: session.state, pendingToolIds: session.pendingToolIds }));
      if (launchId) try { await endFactoryLaunch(isolated, launchId, !captured || captured.code !== 0 || captured.timedOut); } catch (error) { cleanupErrors.push(String(error)); }
      try { await isolated.close(); } catch (error) { cleanupErrors.push(String(error)); }
      afterCleanup = isolated.app.runtimeStatus();
    }
  }
  const snapshot = missionSnapshot(factoryHome);
  const tests = await runE2eCommand("npm", ["test"], { cwd: workspace, timeoutMs: 60_000 });
  const currentUsage = isolated ? readUsageEvents(join(isolated.config.logDir, "usage.jsonl")) : [];
  const previousUsage = readUsageEvents(join(previousDir, "bridge-data/logs/usage.jsonl"));
  const bridgeErrors = isolated ? readBridgeErrors(join(isolated.config.logDir, "bridge.jsonl")) : [];
  const helpers = isolated ? readToolFreeSessionActivity(join(isolated.config.logDir, "requests.jsonl"), join(isolated.config.dataDir, "claude-config"), isolated.app.store.list()) : [];
  let droidResult: RecordValue | undefined;
  try { droidResult = object(JSON.parse(captured?.stdout ?? "")); } catch { /* Failed output is evidence, not success. */ }
  const gates = {
    priorAttemptValidated: previous.threeRoles === true && previous.factoryWorkflowObserved === true,
    droidSuccessful: Boolean(captured && captured.code === 0 && !captured.timedOut && droidResult && droidResult.is_error !== true && droidResult.type !== "error"),
    missionCompleted: snapshot.missionState === "completed" && snapshot.missionDirs.length === 1 && snapshot.missionDir === initial.missionDir && snapshot.errors.length === 0,
    featuresDone: snapshot.features.length > 0 && snapshot.features.every((feature) => feature.status === "completed"),
    completedFeaturesRetained: completedBefore.every((before) => snapshot.features.some((after) => after.id === before.id && after.status === "completed" && after.completedWorkerSessionId === before.completedWorkerSessionId)),
    validationGreen: snapshot.validation.length > 0 && snapshot.validation.every((assertion) => assertion.status === "passed"),
    testsGreen: tests.code === 0 && !tests.timedOut,
    originalTestsPreserved: fileEquals(join(workspace, "sum.test.js"), ACCEPTANCE_TEST) && fileEquals(join(workspace, "package.json"), PACKAGE_JSON),
    nativeRuntimeHealthy: Boolean(beforeCleanup && Array.isArray(beforeCleanup.fatalErrors) && beforeCleanup.fatalErrors.length === 0
      && Array.isArray(object(beforeCleanup.control)?.failures) && (object(beforeCleanup.control)?.failures as unknown[]).length === 0 && bridgeErrors.length === 0),
    toolFreeHelpersRespected: helpers.every((session) => session.transcriptFound && session.nativeToolCalls.every((call) => call.denied)),
    nativeWorkSettled: Boolean(beforeCleanup && beforeCleanup.pendingHostCalls === 0 && beforeCleanup.pendingApprovals === 0 && beforeCleanup.activeNativeTurns === 0 && unsettledSessions.length === 0),
    cleanupSuccessful: cleanupErrors.length === 0 && isolated?.processCleanup?.complete === true && captured?.processCleanup.complete === true && afterCleanup?.activeNativeSessions === 0,
  };
  const status = !failure && Object.values(gates).every(Boolean) ? "PASS_WITH_RECOVERY" : "FAIL";
  const report = { suite: "e2e-mission-resume", workflow: "factory-native-unseeded-recovery", status, resumedFrom: previousDir,
    originalStartedAt: new Date(originalStarted).toISOString(), startedAt: new Date(started).toISOString(),
    durationSec: Math.round((Date.now() - started) / 1000), totalDurationSec: Math.round((Date.now() - originalStarted) / 1000),
    upstream: publicSelection(selection), requestCount: isolated?.app.records.length ?? 0, missionSessionId, workspace, factoryHome,
    droid: captured, droidResult, tests, ...gates, failedGates: Object.entries(gates).filter(([, passed]) => !passed).map(([gate]) => gate),
    ...snapshot, missionHandoffs: readMissionHandoffs(snapshot), completedBefore,
    factoryToolCalls: isolated ? readFactoryToolCalls(join(isolated.config.logDir, "requests.jsonl")) : [],
    runtimeBeforeCleanup: beforeCleanup, runtimeAfterCleanup: afterCleanup, unsettledSessions, bridgeErrors, toolFreeSessions: helpers,
    processCleanup: isolated?.processCleanup, failure, cleanupErrors,
    cache: { ...summarizeUsage([...previousUsage, ...currentUsage]), representativeOfClaudeSubscription: false },
    notes: ["The original 20-minute timeout remains a failed attempt. PASS_WITH_RECOVERY proves one actual Factory Mission completed after official CLI session continuation, not an uninterrupted pass.",
      "This harness never seeds, edits or repairs Mission state, feature, validation or handoff artifacts. Existing completed feature worker identities must remain unchanged.",
      "The previous isolated bridge and owned subprocesses had exited. Recovery uses a fresh isolated native configuration; abandoned native tool callbacks are not replayed."] };
  let sanitized = redactText(JSON.stringify(report));
  for (const secret of [isolated?.token, isolated?.config.adminToken, process.env[selection.provider.tokenEnv]]) if (secret) sanitized = sanitized.replaceAll(secret, "[redacted]");
  writeJson(join(evidence, "result.json"), JSON.parse(sanitized));
  console.log(JSON.stringify({ status, failedGates: report.failedGates, missionState: snapshot.missionState, evidence, failure }, null, 2));
  return status === "PASS_WITH_RECOVERY" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const previous = process.argv[2];
  if (!previous || !existsSync(join(resolve(previous), "result.json"))) throw new Error("Provide the previous owned E2E evidence directory");
  resumeE2eMission(previous).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 1; });
}
