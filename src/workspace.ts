import { realpathSync } from "node:fs";
import { resolve } from "node:path";

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
