import { constants, copyFileSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
  // This is only a no-host-context fallback. Model role headers can be inherited
  // by ordinary Task subagents, so an orchestrator tag alone is insufficient.
  if (role !== "unknown" && role !== "orchestrator") return false;
  return Boolean(tools?.some((tool) => tool.name === "StartMissionRun" || tool.name === "ProposeMission"));
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

const REQUIRED_START_FILES = [
  "features.json",
  "validation-contract.md",
  "validation-state.json",
  "AGENTS.md",
  "services.yaml",
];

export function noteMissionArtifacts(sessionNotes: string[], blob: string): void {
  for (const marker of ARTIFACT_MARKERS) {
    if (marker.pattern.test(blob) && !sessionNotes.includes(marker.note)) {
      sessionNotes.push(marker.note);
    }
  }
}

/** Fixture discovery only. Production requests must supply their own mission directory. */
export function findMissionDir(droidHome?: string, explicitMissionDir?: string): string | undefined {
  if (explicitMissionDir) {
    const dir = resolve(explicitMissionDir);
    return completeMissionDir(dir) ? dir : undefined;
  }
  if (!droidHome) return undefined;
  try {
    const root = join(droidHome, ".factory/missions");
    const candidates = readdirSync(root)
      .map((name) => join(root, name))
      .filter((dir) => lstatSync(dir).isDirectory());
    // An old complete mission beside a new incomplete one is still ambiguous.
    if (candidates.length !== 1) return undefined;
    return completeMissionDir(candidates[0]!) ? candidates[0] : undefined;
  } catch {
    return undefined;
  }
}

export function missionDirReady(droidHome?: string, explicitMissionDir?: string): boolean {
  return findMissionDir(droidHome, explicitMissionDir) !== undefined;
}

function completeMissionDir(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory()
      && REQUIRED_START_FILES.every((file) => lstatSync(join(dir, file)).isFile())
      && skillMarkdownExists(join(dir, "skills"));
  } catch {
    return false;
  }
}

const FACTORY_ARTIFACTS = new Set(["validation-state.json", "features.json"]);

/** Explicit fixture import only; never infer a source or destination from model output. */
export function syncFactoryArtifact(sourcePath: string, missionDir?: string): boolean {
  if (!missionDir) return false;
  const base = basename(sourcePath);
  if (!FACTORY_ARTIFACTS.has(base)) return false;
  try {
    if (!lstatSync(sourcePath).isFile() || !lstatSync(missionDir).isDirectory()) return false;
    const raw = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    if (base === "validation-state.json"
      && (!raw.assertions || typeof raw.assertions !== "object" || Array.isArray(raw.assertions))) return false;
    if (base === "features.json" && !Array.isArray(raw.features)) return false;
    const dest = join(missionDir, base);
    // A fixture import may create a missing ledger, never replace a current one.
    // COPYFILE_EXCL also protects against a destination created between checks.
    copyFileSync(sourcePath, dest, constants.COPYFILE_EXCL);
    return true;
  } catch {
    return false;
  }
}

function skillMarkdownExists(dir: string): boolean {
  if (!lstatSync(dir).isDirectory()) return false;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const entry = lstatSync(full);
    if (entry.isDirectory() && skillMarkdownExists(full)) return true;
    if (entry.isFile() && name === "SKILL.md") return true;
  }
  return false;
}

/** Deterministic fixture helper; SDK runtime must obtain real tool calls from Claude Code. */
export function maybeForceStartWhenReady(
  sessionNotes: string[],
  tools: ToolDefinition[] | undefined,
  blob: string,
  droidHome?: string,
  explicitMissionDir?: string,
): { name: string; input: Record<string, Json> } | undefined {
  noteMissionArtifacts(sessionNotes, blob);
  // Tool-result text and old notes cannot prove that the current files exist.
  if (!missionDirReady(droidHome, explicitMissionDir)) return undefined;
  for (const file of [...REQUIRED_START_FILES, "SKILL.md"]) {
    const note = `artifact:${file}`;
    if (!sessionNotes.includes(note)) sessionNotes.push(note);
  }
  if (!tools?.some((tool) => tool.name === "StartMissionRun")) return undefined;
  if (sessionNotes.includes("mission-run-started")) return undefined;
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
    .filter((name) => name === "StartMissionRun" || name === "ProposeMission" || name === "DismissHandoffItems");
  return [
    "You are the Droid Mission orchestrator talking through Relay Bridge.",
    "Follow the current Droid host context, activated skills, and user instructions for the Mission workflow, required artifacts, and approval gates.",
    "Use the current mission directory supplied in that context or an explicit workspace binding. If it is missing or conflicting, report the missing context instead of choosing another mission.",
    `Advertised Factory Mission controls: ${names.join(", ")}.`,
    "When the workflow requires a Factory action, call its advertised Droid MCP tool and wait for the result. Report a required capability that is unavailable.",
    "Only report Mission or worker progress supported by actual tool results and current task evidence.",
  ].join(" ");
}

export function roleAppendix(role: RoleTag): string {
  if (role === "worker") {
    return "You are the Droid Mission worker. Use Claude Code built-in tools to implement the change. Call Droid MCP tools only for Factory-specific actions such as EndFeatureRun.";
  }
  if (role === "validator") {
    return "You are the Droid Mission validator. Use Claude Code built-in tools to inspect the workspace and run checks. Read the current mission's validation-contract.md and validation-state.json. Record evidence and results against that contract's assertion identifiers while preserving existing results. Write validation-state.json only into the explicitly selected Factory mission directory, then call the Droid MCP tool EndFeatureRun. If the current mission directory or contract is unavailable, report the missing context instead of guessing.";
  }
  if (role === "chat") {
    return "You are answering a Droid chat turn. Prefer a short direct answer. Use Claude Code built-in tools only when the user asks to read or inspect files.";
  }
  return "";
}
