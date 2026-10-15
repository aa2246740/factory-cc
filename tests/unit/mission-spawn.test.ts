import { afterEach, describe, expect, it } from "vitest";
import { postMessages, startTestBridge } from "../helpers/server.js";
import type { BridgeApp } from "../../src/http/app.js";
import { findMissionDir, isMissionOrchestratorRequest, maybeForceStartWhenReady, missionDirReady, orchestratorAppendix, roleAppendix, syncFactoryArtifact } from "../../src/runtime/mission-tools.js";
import { buildHostContext } from "../../src/runtime/system-prompt.js";
import type { RuntimeRequest } from "../../src/runtime/types.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apps: BridgeApp[] = [];
const tempDirs: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-mission-test-"));
  tempDirs.push(dir);
  return dir;
}

const requiredFiles = ["features.json", "validation-contract.md", "validation-state.json", "AGENTS.md", "services.yaml"];

function createMission(dir: string): void {
  mkdirSync(join(dir, "skills", "current-mission"), { recursive: true });
  for (const name of requiredFiles) writeFileSync(join(dir, name), "{}");
  writeFileSync(join(dir, "skills", "current-mission", "SKILL.md"), "Current mission skill");
}

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
          tools: spawnTools,
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

  it("does not treat file success messages as proof of readiness", () => {
    const notes: string[] = [];
    const blob = [
      "The file /tmp/x/.factory/missions/m/features.json has been created successfully",
      "The file /tmp/x/.factory/missions/m/validation-contract.md has been created successfully",
      "The file /tmp/x/.factory/missions/m/validation-state.json has been updated successfully",
      "The file /tmp/x/.factory/missions/m/AGENTS.md has been created successfully",
      "The file /tmp/x/.factory/missions/m/services.yaml has been created successfully",
    ].join("\n");
    expect(maybeForceStartWhenReady(notes, tools, blob)).toBeUndefined();
    expect(notes.includes("mission-run-started")).toBe(false);
  });

  it("starts the fixture runner once after all current mission files and its skill exist", () => {
    const notes: string[] = [];
    const mission = tempDir();
    createMission(mission);
    const forced = maybeForceStartWhenReady(notes, tools, "", undefined, mission);
    expect(forced?.name).toBe("StartMissionRun");
    expect(notes.includes("mission-run-started")).toBe(true);
    expect(maybeForceStartWhenReady(notes, tools, "", undefined, mission)).toBeUndefined();
  });

  it("does not let old artifact notes start an incomplete mission", () => {
    const mission = tempDir();
    const notes = [...requiredFiles, "SKILL.md"].map((name) => `artifact:${name}`);
    expect(maybeForceStartWhenReady(notes, tools, "", undefined, mission)).toBeUndefined();
    expect(notes.includes("mission-run-started")).toBe(false);
  });
});

describe("mission directory selection", () => {
  it("selects the only complete mission", () => {
    const home = tempDir();
    const mission = join(home, ".factory", "missions", "current");
    createMission(mission);
    expect(findMissionDir(home)).toBe(mission);
    expect(missionDirReady(home)).toBe(true);
  });

  it.each(requiredFiles)("requires %s even if a skill exists", (missing) => {
    const home = tempDir();
    const mission = join(home, ".factory", "missions", "incomplete");
    createMission(mission);
    rmSync(join(mission, missing));
    expect(findMissionDir(home)).toBeUndefined();
    expect(missionDirReady(undefined, mission)).toBe(false);
  });

  it("requires an actual skill file and does not follow skill symlinks", () => {
    const mission = tempDir();
    createMission(mission);
    const skill = join(mission, "skills", "current-mission", "SKILL.md");
    rmSync(skill);
    mkdirSync(skill);
    expect(missionDirReady(undefined, mission)).toBe(false);
    rmSync(skill, { recursive: true });
    symlinkSync(join(mission, "AGENTS.md"), skill);
    expect(missionDirReady(undefined, mission)).toBe(false);
  });

  it("does not select an old mission when another mission exists", () => {
    const home = tempDir();
    const oldMission = join(home, ".factory", "missions", "old");
    const currentMission = join(home, ".factory", "missions", "current");
    createMission(oldMission);
    mkdirSync(currentMission);
    expect(findMissionDir(home)).toBeUndefined();
    createMission(currentMission);
    expect(findMissionDir(home)).toBeUndefined();
    expect(findMissionDir(home, currentMission)).toBe(currentMission);
  });

  it("never falls back from an explicitly selected incomplete mission", () => {
    const home = tempDir();
    const oldMission = join(home, ".factory", "missions", "old");
    createMission(oldMission);
    expect(findMissionDir(home, join(home, "new-mission"))).toBeUndefined();
  });

  it("returns not ready for missing or non-directory mission roots", () => {
    expect(missionDirReady()).toBe(false);
    const home = tempDir();
    mkdirSync(join(home, ".factory"));
    writeFileSync(join(home, ".factory", "missions"), "not a directory");
    expect(missionDirReady(home)).toBe(false);
  });
});

describe("explicit factory fixture artifact import", () => {
  it("copies only the specified assertion ledger into the explicit destination", () => {
    const mission = tempDir();
    const other = tempDir();
    const good = join(other, "validation-state.json");
    writeFileSync(good, JSON.stringify({ assertions: { "VAL-CURRENT-001": { status: "passed" } } }));
    writeFileSync(join(other, "features.json"), JSON.stringify({ features: [{ id: "unrelated" }] }));
    expect(syncFactoryArtifact(good)).toBe(false);
    expect(syncFactoryArtifact(good, mission)).toBe(true);
    const copied = JSON.parse(readFileSync(join(mission, "validation-state.json"), "utf8"));
    expect(copied.assertions["VAL-CURRENT-001"].status).toBe("passed");
    expect(existsSync(join(mission, "features.json"))).toBe(false);
  });

  it.each(["validation-state.json", "features.json"])("never overwrites an existing %s", (name) => {
    const mission = tempDir();
    const leftover = tempDir();
    const existing = name === "validation-state.json"
      ? { assertions: { "VAL-CURRENT-001": { status: "failed" } } }
      : { features: [{ id: "current", status: "in_progress" }] };
    const stale = name === "validation-state.json"
      ? { assertions: { "VAL-OLD-001": { status: "passed" } } }
      : { features: [{ id: "old", status: "completed" }] };
    writeFileSync(join(mission, name), JSON.stringify(existing));
    writeFileSync(join(leftover, name), JSON.stringify(stale));
    expect(syncFactoryArtifact(join(leftover, name), mission)).toBe(false);
    expect(JSON.parse(readFileSync(join(mission, name), "utf8"))).toEqual(existing);
    expect(syncFactoryArtifact(join(mission, name), mission)).toBe(false);
  });

  it.each([null, [], { status: "passed" }, { assertions: true }, { assertions: [] }])("rejects invalid assertion schemas: %j", (raw) => {
    const mission = tempDir();
    const source = join(tempDir(), "validation-state.json");
    writeFileSync(source, JSON.stringify(raw));
    expect(syncFactoryArtifact(source, mission)).toBe(false);
    expect(existsSync(join(mission, "validation-state.json"))).toBe(false);
  });

  it("does not overwrite a symlink destination", () => {
    const mission = tempDir();
    const other = tempDir();
    const source = join(other, "validation-state.json");
    const target = join(other, "current.json");
    writeFileSync(source, JSON.stringify({ assertions: {} }));
    writeFileSync(target, "current ledger");
    symlinkSync(target, join(mission, "validation-state.json"));
    expect(syncFactoryArtifact(source, mission)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("current ledger");
  });
});

describe("mission validator instructions", () => {
  it("uses the current contract and does not inject fixture assertion IDs", () => {
    const prompt = roleAppendix("validator");
    expect(prompt).toContain("validation-contract.md");
    expect(prompt).toContain("preserving existing results");
    expect(prompt).toContain("explicitly selected Factory mission directory");
    expect(prompt).not.toContain("VAL-FILTER-001");
    expect(prompt).not.toContain("VAL-COUNTS-001");
  });
});

describe("Mission role and workflow context", () => {
  const tool = (name: string) => ({ name, input_schema: { type: "object", properties: {} } });

  it.each(["worker", "validator", "chat"] as const)("keeps the explicit %s role when Task or Mission controls are advertised", (role) => {
    for (const tools of [[tool("Task")], [tool("Task"), tool("StartMissionRun"), tool("ProposeMission")]]) {
      expect(isMissionOrchestratorRequest(role, tools)).toBe(false);
      expect(orchestratorAppendix(role, tools)).toBe("");
    }
  });

  it("does not impose an orchestrator workflow from a model tag without Mission controls", () => {
    expect(isMissionOrchestratorRequest("orchestrator", undefined)).toBe(false);
    expect(isMissionOrchestratorRequest("orchestrator", [tool("Task")])).toBe(false);
    expect(orchestratorAppendix("orchestrator", [tool("Task")])).toBe("");
  });

  it("does not infer an orchestrator from a generic Task or worker tool", () => {
    expect(isMissionOrchestratorRequest("unknown", undefined)).toBe(false);
    expect(isMissionOrchestratorRequest("unknown", [tool("Task"), tool("EndFeatureRun")])).toBe(false);
    expect(orchestratorAppendix("unknown", [tool("Task")])).toBe("");
  });

  it.each(["StartMissionRun", "ProposeMission"])("can infer an unknown role from %s without inventing another tool", (name) => {
    const tools = [tool(name), tool("Task")];
    expect(isMissionOrchestratorRequest("unknown", tools)).toBe(true);
    const appendix = orchestratorAppendix("unknown", tools);
    expect(appendix).toContain(`Advertised Factory Mission controls: ${name}.`);
    expect(appendix).not.toContain(name === "StartMissionRun" ? "ProposeMission" : "StartMissionRun");
  });

  it("defers artifact and approval requirements to the current host workflow", () => {
    const appendix = orchestratorAppendix("orchestrator", [tool("ProposeMission")]);
    expect(appendix).toContain("current Droid host context, activated skills, and user instructions");
    expect(appendix).toContain("approval gates");
    expect(appendix).not.toContain("features.json");
    expect(appendix).not.toContain("Do not implement application code yourself");
    expect(appendix).not.toContain("Do not finish with a plain-text plan");
  });

  it.each(["worker", "validator"] as const)("preserves the real %s host instructions and Mission path without adding an orchestrator workflow", (role) => {
    const missionDir = "/workspace/current-mission";
    const host = `Current ${role} instructions: read ${missionDir}/skills/current-role/SKILL.md and follow the current contract.`;
    const input: RuntimeRequest = {
      role,
      headers: { "x-bridge-mission-dir": missionDir },
      session: {
        bridgeSessionId: "role-regression", role, state: "NEW", model: "relay", toolNames: ["Task", "EndFeatureRun"],
        createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [],
        usage: { input_tokens: 0, output_tokens: 0, estimated: true },
      },
      request: {
        model: "relay", max_tokens: 100, messages: [{ role: "user", content: "Continue this Mission role." }],
        system: host, tools: [tool("Task"), tool("EndFeatureRun")],
      },
    };
    const context = buildHostContext(input, "/workspace/project");
    expect(context).not.toContain("Droid role:");
    expect(context).toContain(host);
    expect(context).toContain(`Factory mission directory: ${missionDir}`);
    expect(context).not.toContain("Mission orchestrator");
    expect(context).not.toContain("StartMissionRun");
    expect(context).not.toContain("Do not implement application code yourself");
  });
});
