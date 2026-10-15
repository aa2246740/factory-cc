import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

export function findMissionDir(droidHome?: string): string | undefined {
  if (!droidHome) return undefined;
  const root = join(droidHome, ".factory/missions");
  if (!existsSync(root)) return undefined;
  let fallback: string | undefined;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    fallback ??= dir;
    const required = [
      "features.json",
      "validation-contract.md",
      "validation-state.json",
      "AGENTS.md",
      "services.yaml",
    ];
    if (required.every((file) => existsSync(join(dir, file)))) return dir;
  }
  return fallback;
}

export function missionDirReady(droidHome?: string): boolean {
  const dir = findMissionDir(droidHome);
  if (!dir) return false;
  const skills = join(dir, "skills");
  return existsSync(skills) && skillMarkdownExists(skills);
}

const FACTORY_ARTIFACTS = new Set(["validation-state.json", "features.json"]);

export function syncFactoryArtifact(sourcePath: string, missionDir?: string): boolean {
  if (!missionDir || !existsSync(sourcePath)) return false;
  const base = basename(sourcePath);
  if (!FACTORY_ARTIFACTS.has(base)) return false;
  try {
    const raw = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
    if (base === "validation-state.json" && !raw.assertions) return false;
    if (base === "features.json" && !Array.isArray(raw.features)) return false;
    const dest = join(missionDir, base);
    copyFileSync(sourcePath, dest);
    return existsSync(dest);
  } catch {
    return false;
  }
}

export function pathFromToolInput(input: unknown): string | undefined {
  return candidateArtifactPaths(input)[0];
}

export function candidateArtifactPaths(input: unknown, cwd?: string): string[] {
  const out = new Set<string>();
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    for (const key of ["file_path", "path", "filePath"]) {
      if (typeof rec[key] === "string" && rec[key]) out.add(rec[key] as string);
    }
    const command = typeof rec.command === "string" ? rec.command : "";
    for (const match of command.match(/(?:\/[\w.+\-/@]+)+(?:validation-state|features)\.json/g) ?? []) {
      out.add(match);
    }
  }
  if (cwd) {
    for (const name of FACTORY_ARTIFACTS) out.add(join(cwd, name));
  }
  return [...out];
}

export function harvestFactoryArtifacts(cwd?: string, missionDir?: string): string[] {
  if (!cwd || !missionDir) return [];
  const copied: string[] = [];
  for (const name of FACTORY_ARTIFACTS) {
    const source = join(cwd, name);
    if (syncFactoryArtifact(source, missionDir)) copied.push(source);
  }
  return copied;
}

/** Copy assertion-shaped Factory files after Claude Code Write/Edit/Bash. */
export function syncFactoryArtifactsFromTool(input: unknown, cwd?: string, missionDir?: string): string[] {
  if (!missionDir) return [];
  const copied = new Set<string>();
  for (const source of candidateArtifactPaths(input, cwd)) {
    if (syncFactoryArtifact(source, missionDir)) copied.add(source);
    for (const extra of harvestFactoryArtifacts(dirname(source), missionDir)) copied.add(extra);
  }
  for (const extra of harvestFactoryArtifacts(cwd, missionDir)) copied.add(extra);
  return [...copied];
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
    "Write the required mission files with Claude Code built-in Write/Edit: features.json, validation-contract.md, validation-state.json, AGENTS.md, services.yaml, and skills/<name>/SKILL.md.",
    "Only after those files exist, call the Droid MCP tool StartMissionRun so Factory can spawn Worker and Validator sessions.",
    `Available Droid mission tools: ${names.join(", ") || "StartMissionRun"}.`,
    "Never claim workers already ran unless StartMissionRun succeeded.",
  ].join(" ");
}

export function roleAppendix(role: RoleTag): string {
  if (role === "worker") {
    return "You are the Droid Mission worker. Use Claude Code built-in tools to implement the change. Call Droid MCP tools only for Factory-specific actions such as EndFeatureRun.";
  }
  if (role === "validator") {
    return "You are the Droid Mission validator. Use Claude Code built-in tools to inspect the workspace and run checks. Write Factory validation-state.json with an assertions object (VAL-FILTER-001 and VAL-COUNTS-001) into the Factory mission directory from the workspace appendix, not a leftover /tmp folder, then call the Droid MCP tool EndFeatureRun.";
  }
  if (role === "chat") {
    return "You are answering a Droid chat turn. Prefer a short direct answer. Use Claude Code built-in tools only when the user asks to read or inspect files.";
  }
  return "";
}
