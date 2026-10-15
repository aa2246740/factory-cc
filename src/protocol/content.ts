import type { ContentBlock, Message } from "../types.js";

export function asBlocks(content: string | ContentBlock[] | undefined): ContentBlock[] {
  if (content === undefined) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

export function textFromBlocks(content: string | ContentBlock[] | undefined): string {
  return asBlocks(content)
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return textFromBlocks(messages[i].content);
  }
  return "";
}

export function collectToolResults(messages: Message[]): Array<{
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}> {
  const results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }> = [];
  for (const message of messages) {
    for (const block of asBlocks(message.content)) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        results.push({
          tool_use_id: block.tool_use_id,
          content: (block.content as string | ContentBlock[]) ?? "",
          is_error: Boolean(block.is_error),
        });
      }
    }
  }
  return results;
}

export function collectToolUses(messages: Message[]): Array<{ id: string; name: string; input: unknown }> {
  const uses: Array<{ id: string; name: string; input: unknown }> = [];
  for (const message of messages) {
    for (const block of asBlocks(message.content)) {
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        uses.push({ id: block.id, name: block.name, input: block.input });
      }
    }
  }
  return uses;
}

export function systemText(system: string | ContentBlock[] | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return textFromBlocks(system);
}

export function hasImageBlocks(messages: Message[]): boolean {
  return messages.some((message) => asBlocks(message.content).some((block) => block.type === "image"));
}
