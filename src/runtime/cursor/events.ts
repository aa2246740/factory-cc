import { canonicalToolUseId } from "../../protocol/content.js";
import type { ContentBlock, Json } from "../../types.js";
import { outboundDroidToolName } from "./tools.js";

export interface CursorToolCall {
  type: string;
  args?: {
    toolName?: string;
    providerIdentifier?: string;
    args?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export type CursorUpdate =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-completed"; thinkingDurationMs?: number }
  | { type: "tool-call-started" | "partial-tool-call" | "tool-call-completed"; callId: string; toolCall: CursorToolCall }
  | { type: "shell-output-delta"; event?: Record<string, unknown> }
  | { type: "step-completed" | "turn-ended" }
  | { type: string; [key: string]: unknown };

export interface CursorTurnDraft {
  blocks: ContentBlock[];
  events: Array<{ type: string; data?: Record<string, unknown> }>;
  text: string;
  thinking: string;
}

export function emptyCursorDraft(): CursorTurnDraft {
  return { blocks: [], events: [], text: "", thinking: "" };
}

/** Map one SDK interaction update onto Anthropic content. Unknown types are ignored. */
export function applyCursorUpdate(draft: CursorTurnDraft, update: CursorUpdate): void {
  if (update.type === "text-delta" && typeof update.text === "string") {
    draft.text += update.text;
    appendText(draft, update.text);
    draft.events.push({ type: "text-delta" });
    return;
  }
  if (update.type === "thinking-delta" && typeof update.text === "string") {
    draft.thinking += update.text;
    appendThinking(draft, update.text);
    draft.events.push({ type: "thinking-delta" });
    return;
  }
  if (update.type === "thinking-completed") {
    draft.events.push({ type: "thinking-completed" });
    return;
  }
  if (update.type === "tool-call-started" || update.type === "tool-call-completed" || update.type === "partial-tool-call") {
    const call = asToolCall(update.toolCall);
    const callId = typeof update.callId === "string" ? canonicalToolUseId(update.callId) : "";
    if (!call || !callId) return;
    draft.events.push({ type: update.type, data: { callId, tool: call.type, name: toolLabel(call) } });
    if (update.type === "tool-call-started" && call.type === "mcp") {
      const name = typeof call.args?.toolName === "string" ? call.args.toolName : "";
      if (!name || draft.blocks.some((block) => block.type === "tool_use" && block.id === callId)) return;
      const args = call.args?.args;
      const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
      draft.blocks.push({ type: "tool_use", id: callId, name: outboundDroidToolName(name), input: input as Json });
    }
    return;
  }
  if (update.type === "shell-output-delta") {
    draft.events.push({ type: "shell-output-delta" });
    return;
  }
  if (update.type === "step-completed" || update.type === "turn-ended") {
    draft.events.push({ type: update.type });
  }
}

function asToolCall(value: unknown): CursorToolCall | undefined {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") return undefined;
  return value as CursorToolCall;
}

function toolLabel(call: CursorToolCall): string {
  return typeof call.args?.toolName === "string" ? call.args.toolName : call.type;
}

function appendText(draft: CursorTurnDraft, text: string): void {
  const last = draft.blocks.at(-1);
  if (last?.type === "text" && typeof last.text === "string") last.text += text;
  else draft.blocks.push({ type: "text", text });
}

function appendThinking(draft: CursorTurnDraft, text: string): void {
  const last = draft.blocks.at(-1);
  if (last?.type === "thinking" && typeof last.thinking === "string") last.thinking += text;
  else draft.blocks.push({ type: "thinking", thinking: text });
}
