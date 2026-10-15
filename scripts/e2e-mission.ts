import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicSelection } from "../src/upstream/providers.js";
import { resolveSelection, rolesSeen, runDroid, seedMissionPack, startDroidDaemon, startSdkBridge } from "./e2e-lib.js";
import { redactText, runCapture, writeJson } from "./lib.js";

export async function runE2eMission(): Promise<number> {
  const startedAt = Date.now();
  const evidence = join(process.cwd(), "evidence", `e2e-mission-${stamp()}`);
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(process.cwd(), "evidence/e2e-mission-current.txt"), `${evidence}\n`);
  const selection = await resolveSelection();
  writeJson(join(evidence, "upstream.json"), publicSelection(selection));
  const isolated = await startSdkBridge(18797, join(evidence, "bridge-data"), selection);

  const repo = join(isolated.workspace, "tiny-tasks");
  cpSync(join(process.cwd(), "fixtures/tiny-tasks"), repo, {
    recursive: true,
    filter: (src) => !src.includes("node_modules") && !src.includes("dist"),
  });
  cpSync(join(process.cwd(), "fixtures/tiny-tasks-broken/src/store.ts"), join(repo, "src/store.ts"));
  writeFileSync(
    join(repo, "MISSION.md"),
    [
      "# Tiny Tasks completed-filter defect",
      "",
      "The completed filter in `src/store.ts` incorrectly includes active tasks.",
      "Fix `visibleTasks` and `counts` so completed shows only completed tasks.",
      "Keep existing tests in `tests/acceptance.test.ts` passing.",
      "Do not skip scrutiny or user-testing.",
      "",
    ].join("\n"),
  );
  await runCapture("git", ["init"], { cwd: repo, timeoutMs: 10_000 });
  await runCapture("git", ["add", "."], { cwd: repo, timeoutMs: 10_000 });
  await runCapture("git", ["-c", "user.email=relay@example.invalid", "-c", "user.name=Relay", "commit", "-m", "seed broken tiny-tasks"], {
    cwd: repo,
    timeoutMs: 10_000,
  });

  process.env.BRIDGE_DROID_HOME = isolated.home;
  process.env.BRIDGE_WAIT_FOR_MISSION_DIR = "1";
  const daemon = startDroidDaemon(isolated.home, isolated.token, 18798);
  const seeder = seedMissionPack(isolated.home, repo);

  const droidArgs = [
    "exec",
    "--mission",
    "-m",
    "relay-orchestrator",
    "--worker-model",
    "relay-worker",
    "--validator-model",
    "relay-validator",
    "--skip-permissions-unsafe",
    "--append-system-prompt",
    "You are the orchestrator. After mission files exist, call StartMissionRun immediately. Do not implement application code yourself. Let Worker and Validator finish, including scrutiny and user-testing.",
    "-f",
    "MISSION.md",
  ];

  let lastRequestCount = 0;
  let lastProgressAt = Date.now();
  const progressTimer = setInterval(() => {
    const snapshot = missionSnapshot(isolated.home, repo, isolated.app.records.map((r) => r.role));
    if (isolated.app.records.length !== lastRequestCount) {
      lastRequestCount = isolated.app.records.length;
      lastProgressAt = Date.now();
    }
    const progress = {
      at: new Date().toISOString(),
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      requests: isolated.app.records.length,
      uniqueRoles: snapshot.uniqueRoles,
      validation: snapshot.validation,
      features: snapshot.features,
      missionState: snapshot.missionState,
      stallSec: Math.round((Date.now() - lastProgressAt) / 1000),
      provider: isolated.app.records.length ? undefined : selection.provider.id,
      model: selection.provider.model,
    };
    writeJson(join(evidence, "progress.json"), progress);
    writeJson(join(process.cwd(), "evidence/e2e-mission-live.json"), progress);
    console.log(`[e2e-mission] t=${progress.elapsedSec}s req=${progress.requests} roles=${progress.uniqueRoles.join(",")} state=${progress.missionState} val=${JSON.stringify(progress.validation)}`);
  }, 15_000);

  const captured = await runDroid(droidArgs, {
    home: isolated.home,
    token: isolated.token,
    cwd: repo,
    timeoutMs: 0,
  });
  clearInterval(progressTimer);
  const seeded = await seeder;
  daemon.stop();

  const tests = await runCapture("npm", ["test"], { cwd: repo, timeoutMs: 120_000 });
  const snapshot = missionSnapshot(isolated.home, repo, rolesSeen(isolated.app));
  const validationGreen = snapshot.validation.length > 0 && snapshot.validation.every((item) => item.status === "passed");
  const featuresDone = snapshot.features.length > 0 && snapshot.features.every((item) => item.status === "completed");
  const testsGreen = tests.code === 0;
  const threeRoles = snapshot.uniqueRoles.includes("orchestrator") && snapshot.uniqueRoles.includes("worker") && snapshot.uniqueRoles.includes("validator");
  const status = threeRoles && validationGreen && testsGreen ? "PASS" : "FAIL";
  const report = {
    suite: "e2e-mission",
    status,
    nonClaudeModel: true,
    provider: selection.provider.id,
    model: selection.provider.model,
    baseUrl: selection.provider.baseUrl,
    tokenEnv: selection.provider.tokenEnv,
    durationSec: Math.round((Date.now() - startedAt) / 1000),
    requestCount: isolated.app.records.length,
    droid: { code: captured.code, stdout: redactText(captured.stdout).slice(0, 40_000), stderr: redactText(captured.stderr).slice(0, 20_000) },
    tests: { code: tests.code, stdout: tests.stdout.slice(0, 8_000), stderr: tests.stderr.slice(0, 4_000) },
    roles: snapshot.roles,
    uniqueRoles: snapshot.uniqueRoles,
    threeRoles,
    validationGreen,
    featuresDone,
    testsGreen,
    validation: snapshot.validation,
    features: snapshot.features,
    missionState: snapshot.missionState,
    seededMissionDir: seeded ?? snapshot.missionDir,
    notes: [
      "PASS requires three roles, validation-state all passed, and npm test green.",
      "No short exec timeout; droid runs until it exits.",
      "Claude login unused. Official Anthropic billing unused.",
    ],
  };
  writeJson(join(evidence, "result.json"), report);
  writeJson(join(process.cwd(), "evidence/e2e-mission.json"), report);
  console.log(JSON.stringify({ ...report, roles: report.roles.length }, null, 2));
  await isolated.app.close();
  return status === "PASS" ? 0 : 1;
}

function missionSnapshot(home: string, repo: string, roles: string[]): {
  roles: string[];
  uniqueRoles: string[];
  validation: Array<{ id: string; status: string }>;
  features: Array<{ id: string; status: string }>;
  missionState: string;
  missionDir?: string;
} {
  const missionDir = findMissionDir(home);
  let validation: Array<{ id: string; status: string }> = [];
  let features: Array<{ id: string; status: string }> = [];
  let missionState = "unknown";
  if (missionDir) {
    const statePath = join(missionDir, "state.json");
    const valPath = join(missionDir, "validation-state.json");
    const featPath = join(missionDir, "features.json");
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, "utf8")) as { state?: string };
      missionState = state.state ?? "unknown";
    }
    if (existsSync(valPath)) {
      const raw = JSON.parse(readFileSync(valPath, "utf8")) as { assertions?: Record<string, { status?: string }> };
      validation = Object.entries(raw.assertions ?? {}).map(([id, value]) => ({ id, status: value.status ?? "unknown" }));
    }
    if (existsSync(featPath)) {
      const raw = JSON.parse(readFileSync(featPath, "utf8")) as { features?: Array<{ id?: string; status?: string }> };
      features = (raw.features ?? []).map((item) => ({ id: item.id ?? "unknown", status: item.status ?? "unknown" }));
    }
  }
  void repo;
  return {
    roles,
    uniqueRoles: [...new Set(roles)],
    validation,
    features,
    missionState,
    missionDir,
  };
}

function findMissionDir(home: string): string | undefined {
  const root = join(home, ".factory/missions");
  if (!existsSync(root)) return undefined;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (statSync(dir).isDirectory()) return dir;
  }
  return undefined;
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
