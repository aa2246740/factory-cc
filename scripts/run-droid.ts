import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCapture } from "./lib.js";

function parseArgs(argv: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (key.startsWith("--") && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      flags[key.slice(2)] = argv[++i]!;
    } else if (key.startsWith("--")) {
      flags[key.slice(2)] = "1";
    } else {
      rest.push(key);
    }
  }
  return { flags, rest };
}

async function main(): Promise<void> {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  const home = flags.home ?? mkdtempSync(join(tmpdir(), "relay-droid-home-"));
  mkdirSync(join(home, ".factory"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    FACTORY_AIRGAP_ENABLED: flags.airgap === "0" ? undefined : process.env.FACTORY_AIRGAP_ENABLED ?? flags.airgap,
    BRIDGE_CLIENT_TOKEN: flags.token ?? process.env.BRIDGE_CLIENT_TOKEN,
    FACTORY_API_KEY: flags["factory-key"] === "keep" ? process.env.FACTORY_API_KEY : undefined,
  };
  if (flags.airgap === "1") env.FACTORY_AIRGAP_ENABLED = "1";
  if (flags.airgap === "0") delete env.FACTORY_AIRGAP_ENABLED;

  const args = rest.length ? rest : ["exec", "--help"];
  const result = await runCapture("droid", args, { cwd: flags.cwd ?? process.cwd(), env, timeoutMs: Number(flags.timeout ?? 45_000) });
  const out = {
    home,
    args,
    code: result.code,
    stdout: result.stdout.slice(0, 50_000),
    stderr: result.stderr.slice(0, 50_000),
  };
  if (flags.out) {
    writeFileSync(flags.out, `${JSON.stringify(out, null, 2)}\n`);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}

main();
