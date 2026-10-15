import type { Json, RoleTag, ToolDefinition } from "../types.js";

export const MISSION_SPAWN_TOOLS = ["StartMissionRun", "ProposeMission", "Task"] as const;

export function findMissionSpawnTool(tools: ToolDefinition[] | undefined): ToolDefinition | undefined {
  if (!tools?.length) return undefined;
  return (
    tools.find((tool) => tool.name === "StartMissionRun")
    ?? tools.find((tool) => tool.name === "ProposeMission")
    ?? tools.find((tool) => tool.name === "Task")
  );
}

export function isMissionOrchestratorRequest(role: RoleTag, tools: ToolDefinition[] | undefined): boolean {
  return Boolean(findMissionSpawnTool(tools) || role === "orchestrator");
}

export function spawnToolInput(tool: ToolDefinition, userText: string): Record<string, Json> {
  if (tool.name === "StartMissionRun") {
    return { message: "Start mission workers for the current feature now." };
  }
  if (tool.name === "ProposeMission") {
    return {
      title: "Relay Bridge mission",
      proposal: userText.slice(0, 4000) || "Implement the requested mission and keep scrutiny plus user-testing enabled.",
    };
  }
  if (tool.name === "Task") {
    return {
      subagent_type: "generalPurpose",
      description: "Implement mission work",
      prompt: userText.slice(0, 6000) || "Implement the current mission feature and report results.",
    };
  }
  return {};
}

export function maybeForceMissionSpawn(
  sessionNotes: string[],
  tools: ToolDefinition[] | undefined,
  userText: string,
): { name: string; input: Record<string, Json> } | undefined {
  const spawn = findMissionSpawnTool(tools);
  if (!spawn || sessionNotes.includes("mission-spawned")) return undefined;
  sessionNotes.push("mission-spawned");
  return { name: spawn.name, input: spawnToolInput(spawn, userText) };
}

export function orchestratorAppendix(role: RoleTag, tools: ToolDefinition[] | undefined): string {
  if (!isMissionOrchestratorRequest(role, tools)) return "";
  const names = (tools ?? [])
    .map((tool) => tool.name)
    .filter((name) => MISSION_SPAWN_TOOLS.includes(name as (typeof MISSION_SPAWN_TOOLS)[number]));
  return [
    "You are the Droid Mission orchestrator talking through Relay Bridge.",
    "Do not finish with a plain-text plan.",
    `You must call one of these Droid tools in this turn: ${names.join(", ") || "StartMissionRun"}.`,
    "Prefer StartMissionRun so Factory can spawn Worker and Validator sessions.",
    "Never claim workers already ran unless you invoked those tools.",
  ].join(" ");
}

export function roleAppendix(role: RoleTag): string {
  if (role === "worker") {
    return "You are the Droid Mission worker. Use the provided Droid tools to implement the requested change. Do not claim work is done without calling tools.";
  }
  if (role === "validator") {
    return "You are the Droid Mission validator. Use Droid tools to inspect the workspace, run checks, and report concrete findings.";
  }
  if (role === "chat") {
    return "You are the Droid chat model behind Relay Bridge. Prefer a short direct answer. Use a Droid tool only when the user asks to read or inspect files.";
  }
  return "";
}
