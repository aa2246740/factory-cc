export interface ToolNameMap {
  toMcp(original: string): string;
  toOriginal(mcp: string): string | undefined;
  originals(): string[];
}

const MCP_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function sanitizeMcpName(original: string): string {
  let value = original.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!/^[a-zA-Z]/.test(value)) value = `t_${value}`;
  if (value.length > 48) value = value.slice(0, 48);
  if (!MCP_NAME.test(value)) value = `tool_${Math.abs(hash(original)).toString(16)}`;
  return value;
}

export function createToolNameMap(names: string[]): ToolNameMap {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const used = new Set<string>();

  for (const original of names) {
    let candidate = sanitizeMcpName(original);
    let n = 2;
    while (used.has(candidate)) {
      const suffix = `_${n}`;
      candidate = `${sanitizeMcpName(original).slice(0, 48 - suffix.length)}${suffix}`;
      n += 1;
    }
    used.add(candidate);
    forward.set(original, candidate);
    reverse.set(candidate, original);
  }

  return {
    toMcp: (original) => forward.get(original) ?? sanitizeMcpName(original),
    toOriginal: (mcp) => reverse.get(mcp),
    originals: () => [...forward.keys()],
  };
}

export function mcpQualifiedName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return h;
}
