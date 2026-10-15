import { afterEach, describe, expect, it } from "vitest";
import { postMessages, startTestBridge } from "../helpers/server.js";
import type { BridgeApp } from "../../src/http/app.js";
import { maybeForceStartWhenReady } from "../../src/runtime/mission-tools.js";

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
