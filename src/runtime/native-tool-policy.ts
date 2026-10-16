import type { MessagesRequest } from "../types.js";

/** Only concrete file/shell equivalents inherit the host's advertised authority.
 * Task/Agent, Skill, planning, search and plugin registries belong to their host;
 * an identically named native tool must not silently acquire that authority. */
const nativeAliases: Readonly<Record<string, readonly string[]>> = {
  Read: ["Read"],
  Glob: ["Glob", "LS"],
  Grep: ["Grep"],
  LS: ["LS"],
  Write: ["Write", "Create"],
  Edit: ["Edit", "MultiEdit"],
  MultiEdit: ["MultiEdit", "Edit"],
  NotebookEdit: ["NotebookEdit"],
  Bash: ["Bash", "Execute"],
  // These manage native Bash background jobs, not Factory Task jobs.
  TaskOutput: ["Bash", "Execute"],
  TaskStop: ["Bash", "Execute"],
  KillShell: ["Bash", "Execute"],
};

export function hostAllowsAnyTools(request: Pick<MessagesRequest, "tools" | "tool_choice"> | undefined): boolean {
  const choice = request?.tool_choice;
  return Boolean(request?.tools?.length) && !(choice && typeof choice === "object" && !Array.isArray(choice) && choice.type === "none");
}

export function nativeToolAllowed(name: string | undefined, request: Pick<MessagesRequest, "tools" | "tool_choice"> | undefined): boolean {
  if (!name || !hostAllowsAnyTools(request)) return false;
  const aliases = nativeAliases[name];
  return Boolean(aliases?.some((alias) => request!.tools!.some((tool) => tool.name === alias)));
}

export function allowedNativeToolNames(request: Pick<MessagesRequest, "tools" | "tool_choice"> | undefined, factoryPermissionMode?: string): string[] {
  return Object.keys(nativeAliases).filter((name) => nativeToolAllowed(name, request)
    && (factoryPermissionMode !== "spec" || ["Read", "Glob", "Grep", "LS"].includes(name)));
}
