import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

const ARTIFACT_MARKERS: Array<{ note: string; pattern: RegExp }> = [
  { note: "artifact:features.json", pattern: /features\.json has been (created|updated) successfully/i },
  { note: "artifact:validation-contract.md", pattern: /validation-contract\.md has been (created|updated) successfully/i },
  { note: "artifact:validation-state.json", pattern: /validation-state\.json has been (created|updated) successfully/i },
  { note: "artifact:AGENTS.md", pattern: /AGENTS\.md has been (created|updated) successfully/i },
  { note: "artifact:services.yaml", pattern: /services\.yaml has been (created|updated) successfully/i },
  { note: "artifact:SKILL.md", pattern: /SKILL\.md has been (created|updated) successfully/i },
];

const REQUIRED_START_ARTIFACTS = [
  "artifact:features.json",
  "artifact:validation-contract.md",
  "artifact:validation-state.json",
  "artifact:AGENTS.md",
  "artifact:services.yaml",
];

export function noteMissionArtifacts(sessionNotes: string[], blob: string): void {
  for (const marker of ARTIFACT_MARKERS) {
    if (marker.pattern.test(blob) && !sessionNotes.includes(marker.note)) {
      sessionNotes.push(marker.note);
    }
  }
}

export function missionDirReady(droidHome?: string): boolean {
  if (!droidHome) return false;
  const root = join(droidHome, ".factory/missions");
  if (!existsSync(root)) return false;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    const required = [
      "features.json",
      "validation-contract.md",
      "validation-state.json",
      "AGENTS.md",
      "services.yaml",
    ];
    if (!required.every((file) => existsSync(join(dir, file)))) continue;
    const skills = join(dir, "skills");
    if (existsSync(skills) && skillMarkdownExists(skills)) return true;
  }
  return false;
}

function skillMarkdownExists(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory() && skillMarkdownExists(full)) return true;
    if (name === "SKILL.md") return true;
  }
  return false;
}

export function maybeForceStartWhenReady(
  sessionNotes: string[],
  tools: ToolDefinition[] | undefined,
  blob: string,
  droidHome?: string,
): { name: string; input: Record<string, Json> } | undefined {
  noteMissionArtifacts(sessionNotes, blob);
  if (missionDirReady(droidHome)) {
    for (const note of [...REQUIRED_START_ARTIFACTS, "artifact:SKILL.md"]) {
      if (!sessionNotes.includes(note)) sessionNotes.push(note);
    }
  }
  if (!tools?.some((tool) => tool.name === "StartMissionRun")) return undefined;
  if (sessionNotes.includes("mission-run-started")) return undefined;
  if (/must exist with at least one feature before starting/i.test(blob) && !sessionNotes.includes("artifact:features.json")) {
    return undefined;
  }
  if (!REQUIRED_START_ARTIFACTS.every((note) => sessionNotes.includes(note))) return undefined;
  sessionNotes.push("mission-run-started");
  sessionNotes.push("mission-spawned");
  return {
    name: "StartMissionRun",
    input: { message: "Mission files are ready. Start workers and the validator now." },
  };
}

export function orchestratorAppendix(role: RoleTag, tools: ToolDefinition[] | undefined): string {
  if (!isMissionOrchestratorRequest(role, tools)) return "";
  const names = (tools ?? [])
    .map((tool) => tool.name)
    .filter((name) => MISSION_SPAWN_TOOLS.includes(name as (typeof MISSION_SPAWN_TOOLS)[number]));
  return [
    "You are the Droid Mission orchestrator talking through Relay Bridge.",
    "Do not implement application code yourself. Do not finish with a plain-text plan.",
    "First write the required mission files with Droid Create/Edit: features.json, validation-contract.md, validation-state.json, AGENTS.md, services.yaml, and skills/<name>/SKILL.md.",
    "Only after those files exist, call StartMissionRun so Factory can spawn Worker and Validator sessions.",
    `Available mission tools: ${names.join(", ") || "StartMissionRun"}.`,
    "Never claim workers already ran unless StartMissionRun succeeded.",
  ].join(" ");
}

export function roleAppendix(role: RoleTag): string {
  if (role === "worker") {
    return "You are the Droid Mission worker. Use the provided Droid tools to implement the requested change. Do not claim work is done without calling tools.";
  }
  if (role === "validator") {
    return "You are the Droid Mission validator. Use Droid tools to inspect the workspace, run checks, update validation-state.json, and call EndFeatureRun when the feature is finished. Do not loop on the same read.";
  }
  if (role === "chat") {
    return "You are the Droid chat model behind Relay Bridge. Prefer a short direct answer. Use a Droid tool only when the user asks to read or inspect files.";
  }
  return "";
}
