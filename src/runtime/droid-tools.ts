import type { ToolDefinition } from "../types.js";

/** Claude Code built-in names. These stay enabled and execute inside Claude Code. */
export const CLAUDE_CODE_BUILTINS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash",
  "Glob",
  "Grep",
  "LS",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Skill",
  "ExitPlanMode",
  "AskUserQuestion",
  "EnterPlanMode",
]);

/**
 * Factory Droid tools that Claude Code cannot run. Exposed only via the
 * in-process MCP server; handlers wait on the mailbox for Droid to execute.
 */
export const DROID_EXCLUSIVE_TOOLS = new Set([
  "StartMissionRun",
  "ProposeMission",
  "EndFeatureRun",
  "DismissHandoffItems",
  "TaskOutput",
  "TaskStop",
]);

/** Droid names that Claude Code already covers. Do not MCP these. */
export const COVERED_BY_CLAUDE = new Set([
  "Read",
  "Edit",
  "Write",
  "Create",
  "LS",
  "Grep",
  "Glob",
  "Execute",
  "Bash",
  "ToolSearch",
  "Skill",
  "Task",
]);

const READ_ONLY_BUILTINS = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "TodoWrite"]);

export function isDroidExclusive(name: string): boolean {
  return DROID_EXCLUSIVE_TOOLS.has(name);
}

export function isClaudeBuiltin(name: string): boolean {
  return CLAUDE_CODE_BUILTINS.has(name) || name.startsWith("mcp__");
}

export function isReadOnlyBuiltin(name: string): boolean {
  const bare = name.replace(/^mcp__droid__/, "");
  return READ_ONLY_BUILTINS.has(bare);
}

export function selectDroidMcpTools(tools: ToolDefinition[] | undefined): ToolDefinition[] {
  if (!tools?.length) return [];
  return tools.filter((tool) => isDroidExclusive(tool.name));
}

export function isDroidMcpName(name: string): boolean {
  return name.startsWith("mcp__droid__");
}

export function mapPermissionToDroidTool(claudeTool: string, advertised: string[]): string | undefined {
  const aliases: Record<string, string[]> = {
    Bash: ["Execute", "Bash"],
    Edit: ["Edit"],
    Write: ["Create", "Write", "Edit"],
    MultiEdit: ["Edit"],
    NotebookEdit: ["Edit"],
    Read: ["Read"],
  };
  const bare = claudeTool.replace(/^mcp__droid__/, "");
  return (aliases[bare] ?? [bare]).find((name) => advertised.includes(name));
}

export function claudeToolTraceDetail(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return name;
  const rec = input as Record<string, unknown>;
  const path = rec.file_path ?? rec.path ?? rec.command ?? rec.pattern ?? rec.query;
  return typeof path === "string" ? `${name} ${path.slice(0, 180)}` : name;
}
