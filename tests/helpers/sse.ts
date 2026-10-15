import type { ContentBlock } from "../../src/types.js";

/** Reconstruct the public Anthropic stream content, without bridge internals. */
export function contentFromSse(raw: string): ContentBlock[] {
  const content: ContentBlock[] = [];
  const toolJson = new Map<number, string>();
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6)) as {
      type: string;
      index: number;
      content_block?: ContentBlock;
      delta?: { type: string; text?: string; partial_json?: string };
    };
    if (event.type === "content_block_start" && event.content_block) {
      content[event.index] = event.content_block;
    } else if (event.type === "content_block_delta") {
      if (event.delta?.type === "text_delta") {
        const block = content[event.index] as { type: "text"; text: string };
        block.text += event.delta.text ?? "";
      } else if (event.delta?.type === "input_json_delta") {
        toolJson.set(event.index, (toolJson.get(event.index) ?? "") + (event.delta.partial_json ?? ""));
      }
    } else if (event.type === "content_block_stop" && toolJson.has(event.index)) {
      const block = content[event.index] as Extract<ContentBlock, { type: "tool_use" }>;
      block.input = JSON.parse(toolJson.get(event.index)!);
    }
  }
  return content;
}
