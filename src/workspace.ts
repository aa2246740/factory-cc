import type { BridgeConfig } from "./config.js";
import { BridgeError, type MessagesRequest } from "./types.js";
import { asBlocks } from "./protocol/content.js";
import { header } from "./security/auth.js";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, isAbsolute, relative, sep } from "node:path";
import { hostAllowsAnyTools } from "./runtime/native-tool-policy.js";

/** Resolve aliases before a workspace is used as session or launch identity. */
export function canonicalWorkspacePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Preserve support for synthetic test workspaces and cleanup events after
    // removal. Permissions, symlink loops and other filesystem failures matter.
    if (code === "ENOENT" || code === "ENOTDIR") return absolute;
    throw error;
  }
}


/** Droid opens a compacted conversation with this summary, then its environment reminder. */
export const COMPACTION_SUMMARY = "A previous instance of Droid has summarized the conversation thus far as follows:\n";

/** The host's latest environment reminder owns cwd. Droid sends it leading the
 * first user message; a model switch moves a fresh one before the new prompt,
 * and compaction puts it after its leading summary. Only a user message's leading
 * reminders count: stop at user content, and never read tool results or
 * nested/pasted reminders.
 * This is structural host provenance, not authentication of arbitrary API clients.
 */
export function droidWorkingDirectory(request: MessagesRequest): string | undefined {
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "user") continue;
    for (const [index, block] of asBlocks(message.content).entries()) {
      if (block.type !== "text" || typeof block.text !== "string") break;
      const text = block.text;
      if (index === 0 && text.startsWith(COMPACTION_SUMMARY)) continue;
      if (!text.startsWith("<system-reminder>\n") || !text.endsWith("</system-reminder>")) break;
      if (!/^<system-reminder>\n\s*User system info [^\n]+\n/.test(text)) continue;
      return /(?:^|\n)% pwd\n([^\n]*)\n/.exec(text)?.[1];
    }
  }
  return undefined;
}

type RequestHeaders = Record<string, string | string[] | undefined>;
type WorkspaceConfig = Pick<BridgeConfig, "sdkCwd" | "desktopProfile" | "dataDir">;
export function resolveRequestCwd(headers: RequestHeaders, request: MessagesRequest, config: WorkspaceConfig, source?: NodeJS.ProcessEnv): string;
export function resolveRequestCwd(headers: RequestHeaders, request: MessagesRequest): string | undefined;
export function resolveRequestCwd(
  headers: Record<string, string | string[] | undefined>, request: MessagesRequest,
  config?: WorkspaceConfig,
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!config?.desktopProfile || source.BRIDGE_SDK_CWD) {
    const cwd = source.BRIDGE_SDK_CWD || header(headers, "x-bridge-cwd") || config?.sdkCwd;
    return cwd ? canonicalWorkspacePath(cwd) : undefined;
  }
  // A request that permits no tools cannot touch a workspace, and Droid's
  // compaction summaries carry no environment reminder. Give them an empty one.
  if (!hostAllowsAnyTools(request)) {
    const auxiliary = join(config.dataDir, "auxiliary-cwd");
    mkdirSync(auxiliary, { recursive: true, mode: 0o700 });
    return realpathSync(auxiliary);
  }
  const invalid = () => new BridgeError(400, "invalid_project_directory", "Open a project folder in Droid. Its initial environment reminder must contain a valid project working directory; root and Bridge state directories are refused.");
  const raw = droidWorkingDirectory(request);
  if (!raw || !isAbsolute(raw) || raw.includes("\0")) throw invalid();
  try {
    const cwd = realpathSync(raw), state = realpathSync(resolve(config.dataDir, ".."));
    const data = realpathSync(config.dataDir);
    const inside = (parent: string) => { const rel = relative(parent, cwd); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
    if (!statSync(cwd).isDirectory() || cwd === resolve(cwd, "..") || inside(data) || inside(state)) throw invalid();
    return cwd;
  } catch { throw invalid(); }
}
