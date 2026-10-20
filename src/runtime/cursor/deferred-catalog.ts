import { textFromBlocks } from "../../protocol/content.js";
import type { Json, Message, ToolDefinition } from "../../types.js";

const DEFERRED_BLOCK = /Deferred tools:\r?\n([\s\S]*?)(?:<\/system-reminder>|\r?\n\s*\r?\n)/g;
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SKIP = new Set(["Read", "LS", "Grep", "Glob", "read", "grep", "glob", "ls", "mcp"]);

/** Names Droid lists under "Deferred tools:" but has not put in request.tools yet. */
export function deferredToolNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(DEFERRED_BLOCK)) {
    for (const line of (match[1] ?? "").split(/\r?\n/)) {
      const name = line.trim();
      if (!TOOL_NAME.test(name) || SKIP.has(name)) continue;
      names.push(name);
    }
  }
  return [...new Set(names)];
}

/**
 * Cursor custom tools are fixed for one send. Register the catalog names up
 * front so a ToolSearch result can be followed by a real call in that same run.
 * Advertised request tools keep their own schemas; these fill in the rest.
 */
export function deferredToolDefinitions(messages: Message[], advertised: ReadonlySet<string>): ToolDefinition[] {
  const text = messages.map((message) => textFromBlocks(message.content)).join("\n");
  return deferredToolNames(text)
    .filter((name) => !advertised.has(name))
    .map((name) => ({ name, description: deferredDescription(name), input_schema: deferredSchema(name) }));
}

function deferredDescription(name: string): string {
  if (name === "WebSearch") return "Search the web. Pass query. Optional numResults and text.";
  if (name === "FetchUrl") return "Fetch a URL. Pass url. Optional text.";
  return "Deferred Factory tool named in Droid's unified catalog. Call it after ToolSearch loads it, with the arguments that tool expects.";
}

function deferredSchema(name: string): Record<string, Json> {
  if (name === "WebSearch") {
    return {
      type: "object",
      properties: { query: { type: "string" }, numResults: { type: "integer" }, text: { type: "boolean" } },
      required: ["query"],
      additionalProperties: true,
    };
  }
  if (name === "FetchUrl") {
    return {
      type: "object",
      properties: { url: { type: "string" }, text: { type: "boolean" } },
      required: ["url"],
      additionalProperties: true,
    };
  }
  return { type: "object", additionalProperties: true };
}
