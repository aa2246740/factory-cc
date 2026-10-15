import type { Json, ToolDefinition } from "../types.js";

const SAFE_NAMES = /^(read|read_file|readfile|ls|glob|grep|list_dir|listfiles|list_files|view|cat|get_file|getfilecontents)$/i;

export interface SafeToolPlan {
  tool: ToolDefinition;
  input: Record<string, Json>;
  reason: string;
}

export function pickSafeReadonlyTool(
  tools: ToolDefinition[] | undefined,
  preferredPath: string,
): { plan?: SafeToolPlan; schemas: ToolDefinition[]; error?: string } {
  const schemas = tools ?? [];
  if (schemas.length === 0) return { schemas, error: "no tools provided" };

  const candidates = schemas.filter((tool) => SAFE_NAMES.test(tool.name) || readOnlyHint(tool));
  if (candidates.length === 0) {
    return { schemas, error: "no recognized readonly tool; refusing to guess" };
  }

  for (const tool of candidates) {
    const input = fillReadonlyInput(tool, preferredPath);
    if (input) {
      return {
        plan: { tool, input, reason: `selected readonly tool ${tool.name}` },
        schemas,
      };
    }
  }

  return { schemas, error: "recognized a readonly tool but could not safely fill required fields" };
}

function readOnlyHint(tool: ToolDefinition): boolean {
  const desc = `${tool.description ?? ""}`.toLowerCase();
  if (/\b(write|edit|delete|remove|patch|exec|bash|shell|run)\b/.test(desc)) return false;
  return /\b(read|list|search|glob|grep|view)\b/.test(desc);
}

function fillReadonlyInput(tool: ToolDefinition, preferredPath: string): Record<string, Json> | undefined {
  const schema = tool.input_schema ?? {};
  const properties = (schema.properties ?? {}) as Record<string, Record<string, Json>>;
  const required = Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : [];
  const input: Record<string, Json> = {};

  for (const key of required) {
    const prop = properties[key] ?? {};
    const name = key.toLowerCase();
    if (/(path|file|filename|target|uri)/.test(name)) {
      input[key] = preferredPath;
      continue;
    }
    if (/(pattern|query|glob|search|needle)/.test(name)) {
      input[key] = "*";
      continue;
    }
    if (prop.enum && Array.isArray(prop.enum) && typeof prop.enum[0] === "string") {
      input[key] = prop.enum[0];
      continue;
    }
    if (prop.type === "boolean") {
      input[key] = false;
      continue;
    }
    if (prop.type === "number" || prop.type === "integer") {
      input[key] = 0;
      continue;
    }
    if (prop.type === "string") {
      input[key] = preferredPath;
      continue;
    }
    return undefined;
  }

  if (required.length === 0) {
    for (const [key, prop] of Object.entries(properties)) {
      if (/(path|file|filename)/.test(key.toLowerCase()) && (prop.type === "string" || !prop.type)) {
        input[key] = preferredPath;
        break;
      }
    }
  }

  return input;
}
