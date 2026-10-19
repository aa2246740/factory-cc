import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installFactoryHooks, removeFactoryHooks } from "../src/control/factory-hooks.js";

/** The hook config holds the hook token, so it lives with the bridge, not in the project being hooked. */
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
export const defaultHookConfigPath = join(repository, "tmp", "bridge-data", "factory-hooks.json");

export interface HooksPlan { hooksPath: string; configPath: string; baseUrl: string; remove: boolean }

/** Resolve through symlinks even when the tail does not exist yet. */
function physicalPath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  while (!existsSync(current) && dirname(current) !== current) { missing.unshift(basename(current)); current = dirname(current); }
  return join(realpathSync(current), ...missing);
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function planHooksConfiguration(argv: string[], cwd = process.cwd()): HooksPlan {
  const values = new Map<string, string>();
  let remove = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === "--remove") { remove = true; continue; }
    if (!["--hooks", "--config", "--base-url"].includes(flag)) throw new Error(`Unknown option ${flag}; use --hooks, --config, --base-url or --remove.`);
    if (values.has(flag)) throw new Error(`Duplicate option ${flag}.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    values.set(flag, value);
  }
  const hooksPath = resolve(cwd, values.get("--hooks") ?? ".factory/hooks.json");
  const configPath = resolve(cwd, values.get("--config") ?? defaultHookConfigPath);
  // hooks.json normally sits in <project>/.factory/; anything else is treated as living at the project root.
  const project = basename(dirname(hooksPath)) === ".factory" ? dirname(dirname(hooksPath)) : dirname(hooksPath);
  // Removal must still reach a configuration an older version left inside the project.
  if (!remove && inside(physicalPath(project), physicalPath(configPath))) {
    throw new Error("Refusing to keep the private hook configuration (it holds the hook token) inside the project it hooks, where it could be committed or synced; choose a --config path outside the project.");
  }
  return { hooksPath, configPath, baseUrl: values.get("--base-url") ?? "http://127.0.0.1:18787", remove };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const plan = planHooksConfiguration(process.argv.slice(2));
    const result = plan.remove
      ? removeFactoryHooks({ hooksPath: plan.hooksPath, configPath: plan.configPath })
      : installFactoryHooks({ hooksPath: plan.hooksPath, configPath: plan.configPath, url: plan.baseUrl, hookToken: process.env.BRIDGE_HOOK_TOKEN ?? "" });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to configure Factory lifecycle hooks");
    process.exitCode = 1;
  }
}
