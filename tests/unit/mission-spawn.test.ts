import { afterEach, describe, expect, it } from "vitest";
import { postMessages, startTestBridge } from "../helpers/server.js";
import type { BridgeApp } from "../../src/http/app.js";
import { maybeForceStartWhenReady, syncFactoryArtifact, syncFactoryArtifactsFromTool } from "../../src/runtime/mission-tools.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apps: BridgeApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const spawnTools = [
  {
    name: "StartMissionRun",
    description: "Start worker and validator",
    input_schema: { type: "object", properties: { message: { type: "string" } } },
  },
  {
    name: "Read",
    description: "Read a file",
    input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  },
];

for (const mode of ["mock", "fake"] as const) {
  describe(`mission spawn (${mode})`, () => {
    it("returns native StartMissionRun on the first orchestrator request", async () => {
      const { app, token } = await startTestBridge({ mode });
      apps.push(app);
      const first = await postMessages(
        app.url,
        token,
        {
          model: "relay-orchestrator",
          max_tokens: 64,
          messages: [{ role: "user", content: "Implement the completed-filter fix." }],
          tools: spawnTools,
        },
        { "X-Bridge-Role": "orchestrator" },
      );
      expect(first.status).toBe(200);
      expect(first.json.stop_reason).toBe("tool_use");
      const use = (first.json.content as Array<{ type: string; id: string; name: string }>)[0];
      expect(use.type).toBe("tool_use");
      expect(use.name).toBe("StartMissionRun");
      expect(app.store.list()[0]?.state).toBe("WAITING_DROID_TOOL");

      const second = await postMessages(
        app.url,
        token,
        {
          model: "relay-orchestrator",
          max_tokens: 64,
          messages: [
            { role: "user", content: "Implement the completed-filter fix." },
            { role: "assistant", content: [use] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "mission-run started" }] },
          ],
        },
        { "X-Bridge-Session": first.session ?? "", "X-Bridge-Role": "orchestrator" },
      );
      expect(second.status).toBe(200);
      expect(second.json.stop_reason).toBe("end_turn");
    });
  });
}

describe("maybeForceStartWhenReady", () => {
  const tools = [{ name: "StartMissionRun", input_schema: { type: "object", properties: {} } }];

  it("does not start the runner before mission files exist", () => {
    const notes: string[] = [];
    expect(maybeForceStartWhenReady(notes, tools, "planning only")).toBeUndefined();
    expect(notes.includes("mission-run-started")).toBe(false);
  });

  it("starts the runner after the required artifacts are written", () => {
    const notes: string[] = [];
    const blob = [
      "The file /tmp/x/.factory/missions/m/features.json has been created successfully",
      "The file /tmp/x/.factory/missions/m/validation-contract.md has been created successfully",
      "The file /tmp/x/.factory/missions/m/validation-state.json has been updated successfully",
      "The file /tmp/x/.factory/missions/m/AGENTS.md has been created successfully",
      "The file /tmp/x/.factory/missions/m/services.yaml has been created successfully",
    ].join("\n");
    const forced = maybeForceStartWhenReady(notes, tools, blob);
    expect(forced?.name).toBe("StartMissionRun");
    expect(notes.includes("mission-run-started")).toBe(true);
    expect(maybeForceStartWhenReady(notes, tools, blob)).toBeUndefined();
  });
});

describe("factory artifact sync", () => {
  it("copies assertion validation-state.json into the mission dir and ignores other schemas", () => {
    const mission = mkdtempSync(join(tmpdir(), "relay-mission-"));
    const other = mkdtempSync(join(tmpdir(), "relay-other-"));
    const good = join(other, "validation-state.json");
    const wrongDir = mkdtempSync(join(tmpdir(), "relay-wrong-"));
    const wrongSchema = join(wrongDir, "validation-state.json");
    writeFileSync(good, JSON.stringify({ assertions: { "VAL-FILTER-001": { status: "passed" } } }));
    writeFileSync(wrongSchema, JSON.stringify({ status: "passed" }));
    expect(syncFactoryArtifact(good, mission)).toBe(true);
    expect(syncFactoryArtifact(wrongSchema, mission)).toBe(false);
    const copied = JSON.parse(readFileSync(join(mission, "validation-state.json"), "utf8"));
    expect(copied.assertions["VAL-FILTER-001"].status).toBe("passed");
  });

  it("harvests assertion files from a leftover Write/Bash path after the mission dir exists", () => {
    const mission = mkdtempSync(join(tmpdir(), "relay-mission-"));
    const leftover = mkdtempSync(join(tmpdir(), "relay-left-"));
    writeFileSync(
      join(leftover, "validation-state.json"),
      JSON.stringify({ assertions: { "VAL-COUNTS-001": { status: "passed" } } }),
    );
    const copied = syncFactoryArtifactsFromTool(
      { file_path: join(leftover, "validation-state.json") },
      "/tmp/does-not-exist",
      mission,
    );
    expect(copied.length).toBeGreaterThan(0);
    const bashCopied = syncFactoryArtifactsFromTool(
      { command: `cat > ${join(leftover, "validation-state.json")}` },
      undefined,
      mission,
    );
    expect(bashCopied.length).toBeGreaterThan(0);
    const parsed = JSON.parse(readFileSync(join(mission, "validation-state.json"), "utf8"));
    expect(parsed.assertions["VAL-COUNTS-001"].status).toBe("passed");
  });
});
