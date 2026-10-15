import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicSelection } from "../src/upstream/providers.js";
import { resolveSelection, rolesSeen, runDroid, seedMissionPack, startDroidDaemon, startSdkBridge } from "./e2e-lib.js";
import { redactText, runCapture, writeJson } from "./lib.js";

export async function runE2eMission(): Promise<number> {
  const evidence = join(process.cwd(), "evidence", `e2e-mission-${stamp()}`);
  mkdirSync(evidence, { recursive: true });
  const selection = await resolveSelection();
  writeJson(join(evidence, "upstream.json"), publicSelection(selection));
  const isolated = await startSdkBridge(18794, join(evidence, "bridge-data"), selection);

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
  const daemon = startDroidDaemon(isolated.home, isolated.token, 18796);
  const seeder = seedMissionPack(isolated.home, repo);

  const captured = await runDroid(
    [
      "exec",
      "--mission",
      "-m",
      "relay-orchestrator",
      "--worker-model",
      "relay-worker",
      "--validator-model",
      "relay-validator",
      "--auto",
      "high",
      "--append-system-prompt",
      "You are the orchestrator. After mission files exist, call StartMissionRun immediately. Do not implement application code yourself.",
      "-f",
      "MISSION.md",
    ],
    { home: isolated.home, token: isolated.token, cwd: repo, timeoutMs: 480_000 },
  );
  const seeded = await seeder;
  daemon.stop();

  const roles = rolesSeen(isolated.app);
  const uniqueRoles = [...new Set(roles)];
  const spawned = isolated.app.records.some((record) => (record.toolNames ?? []).includes("StartMissionRun"));
  const hasOrchestrator = uniqueRoles.includes("orchestrator");
  const hasWorker = uniqueRoles.includes("worker");
  const hasValidator = uniqueRoles.includes("validator");
  const status = hasOrchestrator && hasWorker && hasValidator ? "PASS" : "FAIL";
  const report = {
    suite: "e2e-mission",
    status,
    nonClaudeModel: true,
    provider: selection.provider.id,
    model: selection.provider.model,
    baseUrl: selection.provider.baseUrl,
    tokenEnv: selection.provider.tokenEnv,
    droid: { code: captured.code, stdout: redactText(captured.stdout).slice(0, 40_000), stderr: redactText(captured.stderr).slice(0, 20_000) },
    roles,
    uniqueRoles,
    spawnedStartMissionToolListed: spawned,
    threeRoles: { orchestrator: hasOrchestrator, worker: hasWorker, validator: hasValidator },
    requests: isolated.app.records,
    seededMissionDir: seeded ?? null,
    notes: [
      "PASS requires orchestrator + worker + validator HTTP requests through the bridge.",
      "StartMissionRun is forced only after required mission files exist (Droid precondition).",
      "Claude login unused. Official Anthropic billing unused.",
    ],
  };
  writeJson(join(evidence, "result.json"), report);
  writeJson(join(process.cwd(), "evidence/e2e-mission.json"), report);
  console.log(JSON.stringify({ ...report, requests: report.requests.length }, null, 2));
  await isolated.app.close();
  return status === "PASS" ? 0 : 1;
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
