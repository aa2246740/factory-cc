import { describe, expect, it } from "vitest";
import {
  isDroidExclusive,
  mapPermissionToDroidTool,
  selectDroidMcpTools,
} from "../../src/runtime/droid-tools.js";

describe("droid tool split", () => {
  it("exposes only Factory-exclusive tools over MCP", () => {
    const selected = selectDroidMcpTools([
      { name: "Read", input_schema: { type: "object", properties: {} } },
      { name: "Edit", input_schema: { type: "object", properties: {} } },
      { name: "Execute", input_schema: { type: "object", properties: {} } },
      { name: "StartMissionRun", input_schema: { type: "object", properties: {} } },
      { name: "ProposeMission", input_schema: { type: "object", properties: {} } },
      { name: "EndFeatureRun", input_schema: { type: "object", properties: {} } },
    ]);
    expect(selected.map((tool) => tool.name)).toEqual([
      "StartMissionRun",
      "ProposeMission",
      "EndFeatureRun",
    ]);
    expect(isDroidExclusive("Read")).toBe(false);
    expect(isDroidExclusive("StartMissionRun")).toBe(true);
  });

  it("maps Claude Code write/shell approvals onto advertised Droid tools", () => {
    expect(mapPermissionToDroidTool("Bash", ["Execute", "Read"])).toBe("Execute");
    expect(mapPermissionToDroidTool("Write", ["Create", "Edit"])).toBe("Create");
    expect(mapPermissionToDroidTool("Edit", ["Read"])).toBeUndefined();
  });

  it("keeps Factory registries and discovered plugins distinct from native tools with matching names", () => {
    const names = ["Read", "Create", "Execute", "Skill", "Task", "TaskOutput", "TaskStop", "ToolSearch", "ExitSpecMode", "Loop", "MCP:example/query"];
    const selected = selectDroidMcpTools(names.map((name) => ({ name, input_schema: { type: "object", properties: {} } })));
    expect(selected.map(({ name }) => name)).toEqual(names.slice(3));
    expect(isDroidExclusive("Skill")).toBe(true);
    expect(isDroidExclusive("Loop")).toBe(true);
  });

  it("desktop profile routes Droid writes and shells over MCP but keeps native reads", () => {
    const names = ["Read", "LS", "Grep", "Glob", "Create", "Edit", "Execute", "ApplyPatch", "Skill", "ToolSearch"];
    const selected = selectDroidMcpTools(names.map((name) => ({ name, input_schema: { type: "object", properties: {} } })), true);
    expect(selected.map(({ name }) => name)).toEqual(["Create", "Edit", "Execute", "ApplyPatch", "Skill", "ToolSearch"]);
  });
});
