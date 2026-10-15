import { lastUserText, systemText, textFromBlocks, collectToolResults } from "../protocol/content.js";
import type { RuntimeRequest } from "./types.js";
import { findMissionDir, orchestratorAppendix, roleAppendix } from "./mission-tools.js";

/**
 * Stable suffix appended to Claude Code's own system prompt.
 * Must stay byte-stable across roles and turns so the prompt-cache prefix hits.
 * Dynamic role / host / user text goes in {@link buildDynamicUserPrompt}, after this prefix.
 */
export const STABLE_DROID_APPEND = [
  "Factory Droid is the host UI and Mission runner for this session.",
  "Use Claude Code built-in tools (Read, Edit, Write, Bash, Glob, Grep) for files and shell. Execute those yourself.",
  "Call Droid MCP tools only for Factory-specific actions that Claude Code cannot run: StartMissionRun, ProposeMission, EndFeatureRun, DismissHandoffItems.",
  "Never invent a Droid tool name that is not in the current MCP list.",
  "When a Droid MCP tool is required, call it and wait; Droid will execute it and return the result.",
].join(" ");

export interface PresetSystemPrompt {
  type: "preset";
  preset: "claude_code";
  append: string;
  snapshot: true;
  excludeDynamicSections: true;
}

export function buildPresetSystemPrompt(): PresetSystemPrompt {
  return {
    type: "preset",
    preset: "claude_code",
    append: STABLE_DROID_APPEND,
    snapshot: true,
    excludeDynamicSections: true,
  };
}

export function buildWorkspaceAppendix(cwd: string, droidHome?: string): string {
  const missionDir = findMissionDir(droidHome);
  return [
    `Working directory (Claude Code cwd): ${cwd}`,
    missionDir ? `Factory mission directory: ${missionDir}` : "",
    missionDir
      ? "Write Factory validation-state.json (must contain an assertions object with VAL-* keys) and features.json only inside that mission directory. Do not write Factory bookkeeping into leftover /tmp directories from other sessions."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Dynamic host/role/user content. Always placed after the stable Claude Code prefix. */
export function buildDynamicUserPrompt(input: RuntimeRequest, cwd?: string): string {
  const user = lastUserText(input.request.messages);
  const results = collectToolResults(input.request.messages);
  const resultText = results
    .map((result) => {
      const body = typeof result.content === "string" ? result.content : textFromBlocks(result.content);
      return `${result.tool_use_id}: ${body}`;
    })
    .join("\n");
  const host = systemText(input.request.system);
  return [
    user,
    resultText ? `Prior Droid tool results:\n${resultText}` : "",
    input.role !== "unknown" ? `Droid role: ${input.role}.` : "",
    roleAppendix(input.role),
    orchestratorAppendix(input.role, input.request.tools),
    host ? `Host context (dynamic):\n${host}` : "",
    cwd ? buildWorkspaceAppendix(cwd, process.env.BRIDGE_DROID_HOME) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function describePromptLayout(): Record<string, string> {
  return {
    systemPrompt: "preset:claude_code + stable append",
    previousLayout: "custom full-replace (disabled Claude Code default prompt)",
    dynamicPlacement: "end of user prompt",
    tools: "preset:claude_code built-ins + Droid-exclusive MCP",
  };
}
