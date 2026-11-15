import type { ContentBlock, MessagesRequest } from "../types.js";
import { asBlocks } from "./content.js";

const MAX_RETAINED_ALIASES = 1024;
export type ToolUseAliases = Readonly<Record<string, string>>;

export function nativeToolUseId(id: string, aliases?: ToolUseAliases): string {
  return aliases && Object.hasOwn(aliases, id) ? aliases[id]! : id;
}

export function retainToolUseAliases(known: ToolUseAliases, pendingToolIds: readonly string[]): Record<string, string> {
  const aliases = { ...known };
  const pending = new Set(pendingToolIds);
  let retained = Object.keys(aliases).length;
  for (const id of Object.keys(aliases)) {
    if (retained <= MAX_RETAINED_ALIASES) break;
    if (!pending.has(aliases[id]!)) { delete aliases[id]; retained--; }
  }
  return aliases;
}

/** Translate only protocol identities. Tool arguments and real result contents stay exact. */
export function requestWithNativeToolIds(request: MessagesRequest, aliases?: ToolUseAliases): MessagesRequest {
  if (!aliases || !Object.keys(aliases).length) return request;
  return { ...request, messages: request.messages.map((message) => ({ ...message, content: asBlocks(message.content).map((block): ContentBlock => {
    if (block.type === "tool_use" && typeof block.id === "string") return { ...block, id: nativeToolUseId(block.id, aliases) };
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") return { ...block, tool_use_id: nativeToolUseId(block.tool_use_id, aliases) };
    return block;
  }) })) };
}
