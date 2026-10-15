import { asBlocks, systemText, textFromBlocks } from "../protocol/content.js";
import type { RuntimeRequest } from "./types.js";
import { orchestratorAppendix, roleAppendix } from "./mission-tools.js";
import { BridgeError, type ContentBlock } from "../types.js";
import { isAbsolute } from "node:path";

/**
 * Stable suffix appended to Claude Code's own system prompt.
 * Must stay byte-stable across roles and turns so the prompt-cache prefix hits.
 * Dynamic role / host / user text goes in {@link buildDynamicUserPrompt}, after this prefix.
 */
export const STABLE_DROID_APPEND = [
  "Factory Droid is the host UI and Mission runner for this session.",
  "Use Claude Code built-in tools (Read, Edit, Write, Bash, Glob, Grep) for files and shell. Execute those yourself.",
  "Factory-owned skills, subagents, plugins, and Mission lifecycle remain under Droid control. Use the advertised mcp__droid__ tools for these actions, including Skill, Task, TaskOutput, TaskStop, ToolSearch, ExitSpecMode, StartMissionRun, ProposeMission, EndFeatureRun, and DismissHandoffItems.",
  "Factory Skill names and Factory task IDs belong to Droid, not to Claude Code's native Skill or subagent registry. Activate a Factory skill with mcp__droid__Skill and follow its returned full instructions; use mcp__droid__Task for Factory subagents and the corresponding Droid tools for their task IDs. Native Claude Code skills and subagents remain separate.",
  "Use mcp__droid__ToolSearch for deferred Factory tools. The host may update its advertised MCP tools after discovery; use only the tools currently available.",
  "Never invent a Droid tool name that is not in the current MCP list.",
  "When a Droid MCP tool is required, call it and wait; Droid will execute it and return the result.",
].join(" ");

export interface PresetSystemPrompt {
  type: "preset";
  preset: "claude_code";
  append: string;
}

export function buildPresetSystemPrompt(): PresetSystemPrompt {
  return {
    type: "preset",
    preset: "claude_code",
    append: STABLE_DROID_APPEND,
  };
}

export function buildWorkspaceAppendix(cwd: string, missionDir?: string): string {
  if (missionDir && !isAbsolute(missionDir)) {
    throw new BridgeError(400, "invalid_mission_directory", "X-Bridge-Mission-Dir must be an absolute path");
  }
  return [
    `Working directory (Claude Code cwd): ${cwd}`,
    missionDir ? `Factory mission directory: ${missionDir}` : "",
    missionDir
      ? "Use this explicit Factory mission directory for the current task. Follow its validation contract and existing state; do not overwrite other missions."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** This context belongs in user input, never in the native system/tool prefix. */
export function buildHostContext(input: RuntimeRequest, cwd?: string): string {
  const host = systemText(input.request.system);
  const header = input.headers["x-bridge-mission-dir"];
  const missionDir = Array.isArray(header) ? header[0] : header;
  // X-Bridge-Role identifies a model configuration, which Factory Task subagents
  // can inherit. The host's actual instructions own roles, skills and workflow.
  const roleContext = host.trim()
    ? [`Host context (dynamic):\n${host}`]
    : [
      input.role !== "unknown" ? `Droid role: ${input.role}.` : "",
      roleAppendix(input.role),
      orchestratorAppendix(input.role, input.request.tools),
    ];
  return [
    ...roleContext,
    cwd ? buildWorkspaceAppendix(cwd, missionDir) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function userBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return asBlocks(content).flatMap((block): ContentBlock[] => {
    // The CLI owns cache placement and tool-result delivery. Never replay an MCP result as user input.
    if (block.type === "tool_result") return [];
    if (block.type !== "text" && block.type !== "image" && block.type !== "document") {
      throw new BridgeError(422, "unsupported_user_content", `Unsupported user content block: ${block.type}`);
    }
    const copy = { ...block };
    delete (copy as { cache_control?: unknown }).cache_control;
    return [copy as ContentBlock];
  });
}

/** Append only the new user content; Claude Code retains the earlier native transcript. */
export function buildDynamicUserContent(
  input: RuntimeRequest,
  cwd?: string,
  options: { includeContext?: boolean } = {},
): ContentBlock[] {
  const latest = [...input.request.messages].reverse().find((message) => message.role === "user");
  const blocks = latest ? userBlocks(latest.content) : [];
  const context = options.includeContext === false ? "" : buildHostContext(input, cwd);
  if (!context) return blocks;
  // Claude Code recognizes native slash commands only in the last text block.
  // Preserve that protocol when the host context is introduced or changes.
  const lastText = [...blocks].reverse().find((block) => block.type === "text");
  if (lastText?.type === "text" && typeof lastText.text === "string" && lastText.text.startsWith("/")) {
    return [{ type: "text", text: context }, ...blocks];
  }
  return [...blocks, { type: "text", text: context }];
}

/**
 * Cold imports have no native session to resume. Preserve their supplied history as
 * reference material, not executable tool messages or a fabricated SDK transcript.
 */
export function buildInitialUserContent(input: RuntimeRequest, cwd?: string): ContentBlock[] {
  if (input.request.messages.length === 1) return buildDynamicUserContent(input, cwd);
  let latestIndex = -1;
  for (let i = input.request.messages.length - 1; i >= 0; i -= 1) {
    if (input.request.messages[i]?.role === "user") { latestIndex = i; break; }
  }
  const blocks: ContentBlock[] = [{
    type: "text",
    text: "Imported conversation history follows as reference context. Previous tool calls are historical records, not requests to execute them again. The final user message is the current task.",
  }];
  for (let i = 0; i < input.request.messages.length; i += 1) {
    if (i === latestIndex) continue;
    const message = input.request.messages[i]!;
    blocks.push({ type: "text", text: `Prior ${message.role} message ${i + 1}:` });
    for (const block of asBlocks(message.content)) {
      if (block.type === "text" || block.type === "image" || block.type === "document") {
        blocks.push(...userBlocks([block]));
      } else if (block.type === "tool_result") {
        blocks.push({ type: "text", text: `Historical tool result ${block.tool_use_id}:` });
        blocks.push(...userBlocks((block.content as string | ContentBlock[] | undefined) ?? ""));
      } else if (block.type === "tool_use") {
        blocks.push({ type: "text", text: `Historical tool call ${block.name}: ${JSON.stringify(block.input)}` });
      } else {
        // Signed thinking cannot be recreated in a different provider/session.
        blocks.push({ type: "text", text: `[Prior ${block.type} block omitted from the imported reference.]` });
      }
    }
  }
  blocks.push({ type: "text", text: "Current user message:" });
  blocks.push(...buildDynamicUserContent(input, cwd));
  return blocks;
}

/** Text-only compatibility helper for diagnostics and mock fixtures. */
export function buildDynamicUserPrompt(input: RuntimeRequest, cwd?: string): string {
  return textFromBlocks(buildDynamicUserContent(input, cwd));
}

export function describePromptLayout(): Record<string, string> {
  return {
    systemPrompt: "preset:claude_code + stable append",
    dynamicPlacement: "user input on initial turn or context change",
    tools: "preset:claude_code built-ins + Droid-exclusive MCP",
  };
}
