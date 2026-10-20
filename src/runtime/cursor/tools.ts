import { BridgeError, type ContentBlock, type ToolDefinition } from "../../types.js";

/** Desktop profile equivalent: reads stay native, everything else is a Droid custom tool. "mcp" keeps custom tools alive. */
export const CURSOR_NATIVE_TOOLS = ["read", "grep", "glob", "ls", "mcp"] as const;

export function assertCursorNativeTools(tools: readonly string[]): string[] {
  if (!tools.includes("mcp")) {
    throw new BridgeError(400, "cursor_tools_rejected", 'Cursor custom tools require "mcp" in the native tool allowlist; without it the SDK drops them.');
  }
  return [...tools];
}

export function bareDroidToolName(name: string): string {
  return name.startsWith("mcp__droid__") ? name.slice("mcp__droid__".length) : name;
}

/** Name Droid sees. The SDK custom-tool key is the bare name. */
export function outboundDroidToolName(name: string): string {
  return name.startsWith("mcp__droid__") ? name : `mcp__droid__${name}`;
}

export interface CursorCustomToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType?: string }>;
  isError?: boolean;
}

export function toCursorToolResult(content: string | ContentBlock[], isError?: boolean): CursorCustomToolResult {
  const blocks: CursorCustomToolResult["content"] = [];
  if (typeof content === "string") blocks.push({ type: "text", text: content });
  else for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
    else {
      const image = base64Image(block);
      blocks.push(image ? { type: "image", data: image.data, mimeType: image.mimeType } : { type: "text", text: JSON.stringify(block) });
    }
  }
  return { content: blocks, ...(isError ? { isError: true } : {}) };
}

export function base64Image(block: ContentBlock): { data: string; mimeType: string } | undefined {
  if (block.type !== "image" || !block.source || typeof block.source !== "object") return undefined;
  const source = block.source as { type?: unknown; data?: unknown; media_type?: unknown };
  if (source.type !== "base64" || typeof source.data !== "string" || typeof source.media_type !== "string") return undefined;
  return { data: source.data, mimeType: source.media_type };
}

export function customToolDefinitions(tools: ToolDefinition[] | undefined): Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> {
  const used = new Set<string>();
  const definitions = [];
  for (const tool of tools ?? []) {
    const name = bareDroidToolName(tool.name);
    if (!name || used.has(name)) throw new BridgeError(400, "invalid_tool_catalog", `Cursor custom tool name ${tool.name} is empty or duplicated.`);
    used.add(name);
    definitions.push({ name, description: tool.description, inputSchema: tool.input_schema });
  }
  return definitions;
}
