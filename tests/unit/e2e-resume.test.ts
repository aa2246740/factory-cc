import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startSdkBridge } from "../../scripts/e2e-lib.js";
import { resumeE2eMission } from "../../scripts/e2e-mission-resume.js";
import { modelSlots, type UpstreamSelection } from "../../src/upstream/providers.js";

const dirs: string[] = [];
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Mission recovery ownership", () => {
  it("refuses an arbitrary existing home before writing configuration or starting the SDK", async () => {
    const home = temp("unrelated-existing-home-");
    const workspace = temp("relay-e2e-ws-");
    const sentinel = join(home, "settings.json");
    writeFileSync(sentinel, "untouched user settings");
    const selection: UpstreamSelection = { provider: { id: "glm", label: "unused", baseUrl: "https://invalid.example",
      model: "unused", tokenEnv: "UNUSED_TEST_KEY", authHeader: "x-api-key" }, modelSlots: modelSlots("unused") };
    await expect(startSdkBridge(0, temp("relay-unused-data-"), selection, { home, workspace }))
      .rejects.toThrow("explicitly owned E2E temporary");
    expect(readFileSync(sentinel, "utf8")).toBe("untouched user settings");
  });

  it("never turns a prior native failure into a recovery pass", async () => {
    const evidence = temp("relay-recovery-report-");
    writeFileSync(join(evidence, "result.json"), JSON.stringify({ suite: "e2e-mission", workflow: "factory-native-unseeded",
      droid: { timedOut: true }, baselineFailedAsExpected: true, originalTestsPreserved: true,
      nativeRuntimeHealthy: false, toolFreeHelpersRespected: true, cleanupSuccessful: true,
      factoryHome: "/unowned/.factory", workspace: "/unowned/workspace" }));
    await expect(resumeE2eMission(evidence)).rejects.toThrow("healthy, isolated, unseeded Mission timeout");
  });
});
