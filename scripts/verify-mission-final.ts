#!/usr/bin/env -S node --import tsx
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runE2eMission } from "./e2e-mission.js";

/** Hash actual runtime sources: Git HEAD can lag unpublished working-tree fixes. */
export function missionRuntimeFingerprint(root: string): { sha256: string; files: Array<{ path: string; sha256: string }> } {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(directory, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".ts")) paths.push(join(directory, entry.name));
    }
  };
  visit(join(root, "src"));
  for (const name of ["package.json", "package-lock.json", "scripts/e2e-mission.ts", "scripts/e2e-lib.ts",
    "scripts/e2e-processes.ts", "scripts/factory-hook.ts"]) paths.push(join(root, name));
  const files = paths.sort().map((path) => ({ path: relative(root, path),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }));
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}

export async function verifyMissionFinal(summaryPath: string): Promise<number> {
  const summary = resolve(summaryPath);
  if (existsSync(summary)) throw new Error("Mission summary already exists; select a new file so failed attempts survive");
  const root = realpathSync(process.cwd());
  const localRoot = join(root, "evidence/local");
  mkdirSync(localRoot, { recursive: true });
  const evidence = mkdtempSync(join(localRoot, "mission-final-summary-"));
  const attemptPath = join(evidence, "attempt.json");
  const startedAt = new Date().toISOString();
  const before = missionRuntimeFingerprint(root);
  console.log(JSON.stringify({ suite: "mission-final-validation", startedAt, runtimeSourceSha256: before.sha256,
    summary, evidence, timeoutMs: Number(process.env.BRIDGE_E2E_MISSION_TIMEOUT_MS ?? 3_600_000) }));
  const code = await runE2eMission({ summaryPath: attemptPath, updateLegacyPointers: false });
  const after = missionRuntimeFingerprint(root);
  const attempt = JSON.parse(readFileSync(attemptPath, "utf8")) as Record<string, unknown>;
  const runtimeSourcesStable = before.sha256 === after.sha256;
  const uninterruptedMissionPass = code === 0 && attempt.status === "PASS" && runtimeSourcesStable;
  const report = {
    ...attempt,
    suite: "mission-final-validation",
    status: uninterruptedMissionPass ? "PASS" : "FAIL",
    startedAt,
    recordedAt: new Date().toISOString(),
    uninterruptedMissionPass,
    runtimeSourcesStable,
    failedGates: [...(Array.isArray(attempt.failedGates) ? attempt.failedGates : []),
      ...(!runtimeSourcesStable ? ["runtimeSourcesStable"] : [])],
    sourceScope: { before, after, includesUncommittedWorkingTree: true },
    authorization: { mode: "isolated-byok", realClaudeSubscriptionUsed: false,
      provider: "Configured explicit BRIDGE_UPSTREAM_BASE_URL; see upstream", preservesProxyAndCA: true },
    evidence: relative(root, evidence),
    recoveryUsed: false,
    notes: [...(Array.isArray(attempt.notes) ? attempt.notes : []),
      "This is one fresh, uninterrupted invocation. No previous Factory home, workspace, Mission or SDK session is reused.",
      "Both scrutiny-validator and user-testing-validator must complete. Every completed feature requires a matching real EndFeatureRun worker transcript.",
      "The summary is written exclusively; prior attempts and legacy summaries are retained. Owned processes are drained; isolated fixture directories are retained for failure diagnosis or explicit recovery.",
      "A changed runtime source fingerprint invalidates the final acceptance claim, even if the underlying Mission completed."],
  };
  mkdirSync(dirname(summary), { recursive: true });
  writeFileSync(summary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ status: report.status, uninterruptedMissionPass, failedGates: report.failedGates, summary }, null, 2));
  return uninterruptedMissionPass ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--summary") {
    console.error("Usage: node --import tsx scripts/verify-mission-final.ts --summary <new-evidence.json>");
    process.exitCode = 2;
  } else {
    verifyMissionFinal(args[1]!).then((code) => { process.exitCode = code; }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
