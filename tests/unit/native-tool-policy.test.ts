import { describe, expect, it } from "vitest";
import { nativeToolAllowed } from "../../src/runtime/native-tool-policy.js";
const request = (...names: string[]) => ({ tools: names.map((name) => ({ name, input_schema: { type: "object" } })) });

describe("host native tool authority", () => {
  it("keeps a Read-only request read-only even when agent, shell and plugin tools exist natively", () => {
    expect(nativeToolAllowed("Read", request("Read"))).toBe(true);
    for (const name of ["Write", "Edit", "Bash", "Agent", "Task", "Skill", "TaskOutput", "TaskStop", "WebSearch", "mcp__other__run", "mcp__droid__Read"]) {
      expect(nativeToolAllowed(name, request("Read"))).toBe(false);
    }
  });
  it("maps only concrete equivalents and keeps Factory controls out of native registries", () => {
    expect(nativeToolAllowed("Write", request("Create"))).toBe(true);
    expect(nativeToolAllowed("Write", request("Edit"))).toBe(false);
    expect(nativeToolAllowed("MultiEdit", request("Edit"))).toBe(true);
    expect(nativeToolAllowed("Glob", request("LS"))).toBe(true);
    expect(nativeToolAllowed("Bash", request("LS"))).toBe(false);
    for (const name of ["Bash", "TaskOutput", "TaskStop", "KillShell"]) expect(nativeToolAllowed(name, request("Execute"))).toBe(true);
    for (const name of ["Agent", "Task", "Skill", "TodoWrite", "TaskOutput", "TaskStop", "ToolSearch", "WebSearch", "WebFetch"]) {
      expect(nativeToolAllowed(name, request(name))).toBe(false);
    }
  });
  it("does not inherit permissions from omitted or explicitly disabled tools", () => {
    expect(nativeToolAllowed("Bash", undefined)).toBe(false);
    expect(nativeToolAllowed("Bash", {})).toBe(false);
    expect(nativeToolAllowed("Bash", request())).toBe(false);
    expect(nativeToolAllowed("Bash", { ...request("Execute"), tool_choice: { type: "none" } })).toBe(false);
    expect(nativeToolAllowed(undefined, request("Execute"))).toBe(false);
  });
});
