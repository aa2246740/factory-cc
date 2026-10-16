import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasCompletedWorkerHandoffs, readMissionHandoffs, runE2eMission, type MissionSnapshot } from "../../scripts/e2e-mission.js";

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("full Mission acceptance evidence", () => {
  it("rejects a green ledger without a matching real worker completion", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-mission-proof-"));
    owned.push(dir);
    const snapshot: MissionSnapshot = { missionDir: dir, missionDirs: [dir], missionState: "completed", errors: [],
      validation: [{ id: "VAL-1", status: "passed" }], features: [{ id: "fix", status: "completed", completedWorkerSessionId: "real-worker" }] };
    expect(hasCompletedWorkerHandoffs(snapshot, readMissionHandoffs(snapshot))).toBe(false);
    writeFileSync(join(dir, "worker-transcripts.jsonl"), JSON.stringify({ workerSessionId: "other-worker", featureId: "fix",
      skeleton: "## Tool: EndFeatureRun\n{\"status\":\"success\"}" }));
    expect(hasCompletedWorkerHandoffs(snapshot, readMissionHandoffs(snapshot))).toBe(false);
    writeFileSync(join(dir, "worker-transcripts.jsonl"), JSON.stringify({ workerSessionId: "real-worker", featureId: "fix",
      skeleton: "## Tool: EndFeatureRun\n{\"status\":\"success\"}" }));
    expect(hasCompletedWorkerHandoffs(snapshot, readMissionHandoffs(snapshot))).toBe(true);
  });

  it("preserves an earlier failed attempt before any bridge or model can start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-mission-summary-"));
    owned.push(dir);
    mkdirSync(join(dir, "proof"));
    const summary = join(dir, "proof/failed.json");
    writeFileSync(summary, '{"status":"FAIL"}\n');
    await expect(runE2eMission({ summaryPath: summary, updateLegacyPointers: false })).rejects.toThrow("already exists");
  });
});
