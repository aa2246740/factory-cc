import { join, resolve } from "node:path";
import { installFactoryHooks, removeFactoryHooks } from "../src/control/factory-hooks.js";

const args = process.argv.slice(2);
function value(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
const hooksPath = resolve(value("--hooks") ?? join(process.cwd(), ".factory/hooks.json"));
const configPath = resolve(value("--config") ?? join(process.cwd(), "tmp/bridge-data/factory-hooks.json"));
try {
  const result = args.includes("--remove")
    ? removeFactoryHooks({ hooksPath, configPath })
    : installFactoryHooks({ hooksPath, configPath, url: value("--base-url") ?? "http://127.0.0.1:18787", adminToken: process.env.BRIDGE_ADMIN_TOKEN ?? "" });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to configure Factory lifecycle hooks");
  process.exitCode = 1;
}
