import type { BridgeConfig } from "./config.js";
import { BridgeError, type MessagesRequest } from "./types.js";
import { asBlocks } from "./protocol/content.js";
import { header } from "./security/auth.js";
import { realpathSync, statSync } from "node:fs";
import { resolve, isAbsolute, relative, sep } from "node:path";

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


/** Only the host's leading environment reminder in the first user message owns cwd.
 * Stop at user content, and never search later messages or nested/pasted reminders.
 * This is structural host provenance, not authentication of arbitrary API clients.
 */
export function droidWorkingDirectory(request: MessagesRequest): string | undefined {
  const first = request.messages[0];
  if (first?.role !== "user") return undefined;
  for (const block of asBlocks(first.content)) {
    if (block.type !== "text" || typeof block.text !== "string") break;
    const text = block.text;
    if (!text.startsWith("<system-reminder>\n") || !text.endsWith("</system-reminder>")) break;
    if (!/^<system-reminder>\n\s*User system info [^\n]+\n/.test(text)) continue;
    return /(?:^|\n)% pwd\n([^\n]*)\n/.exec(text)?.[1];
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
