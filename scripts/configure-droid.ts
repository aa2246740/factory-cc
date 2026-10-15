import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface CustomModel {
  model: string;
  displayName: string;
  baseUrl: string;
  apiKey?: string;
  provider: "anthropic";
  authMode?: "bearer" | "provider-default";
  maxOutputTokens: number;
  extraHeaders?: Record<string, string>;
}

function models(baseUrl: string, token: string): CustomModel[] {
  const roles = [
    ["relay-probe", "Relay Probe", "chat"],
    ["relay-chat", "Relay Chat", "chat"],
    ["relay-orchestrator", "Relay Orchestrator", "orchestrator"],
    ["relay-worker", "Relay Worker", "worker"],
    ["relay-validator", "Relay Validator", "validator"],
  ] as const;
  return roles.map(([model, displayName, role]) => ({
    model,
    displayName,
    baseUrl,
    apiKey: token,
    provider: "anthropic",
    authMode: "bearer",
    maxOutputTokens: 4096,
    extraHeaders: { "X-Bridge-Role": role },
  }));
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key?.startsWith("--")) {
      out[key.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "1";
    }
  }
  return out;
}

function writePrivateFile(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function configureDroid(argv: string[], env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const args = parseArgs(argv);
  const settingsPath = args.settings ?? join(args.home ?? env.HOME ?? ".", ".factory/settings.json");
  const baseUrl = args["base-url"] ?? "http://127.0.0.1:18787";
  const revert = args.revert === "1";

  const backup = `${settingsPath}.relay-bridge.bak`;
  const absentMarker = `${backup}.absent`;

  if (revert) {
    if (existsSync(absentMarker)) {
      rmSync(settingsPath, { force: true });
    } else {
      if (!existsSync(backup)) throw new Error("No backup to revert.");
      writePrivateFile(settingsPath, readFileSync(backup, "utf8"));
    }
    return { reverted: true, settingsPath };
  }

  const token = env.BRIDGE_CLIENT_TOKEN;
  if (!token?.trim()) throw new Error("BRIDGE_CLIENT_TOKEN is required; settings were not changed.");

  let current: Record<string, unknown> & { customModels?: CustomModel[] } = {};
  let original: string | undefined;
  if (existsSync(settingsPath)) {
    original = readFileSync(settingsPath, "utf8");
    try {
      current = JSON.parse(original) as typeof current;
      if (!current || Array.isArray(current) || typeof current !== "object"
          || (current.customModels !== undefined && !Array.isArray(current.customModels))) throw new Error();
    } catch {
      throw new Error("Invalid Droid settings JSON; settings were not changed.");
    }
  }

  const incoming = models(baseUrl, token);
  const existing = current.customModels ?? [];
  const kept = existing.filter((item) => !incoming.some((m) => m.model === item.model));
  current.customModels = [...kept, ...incoming];
  mkdirSync(dirname(settingsPath), { recursive: true });
  if (!existsSync(backup) && !existsSync(absentMarker)) {
    if (original === undefined) writePrivateFile(absentMarker, "original settings did not exist\n");
    else writePrivateFile(backup, original);
  }
  if (existsSync(backup)) chmodSync(backup, 0o600);
  if (existsSync(absentMarker)) chmodSync(absentMarker, 0o600);
  writePrivateFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`);

  const manifest = {
    settingsPath,
    backup,
    baseUrl,
    modelIds: incoming.map((m) => m.model),
    notes: [
      "model is the Messages API model field.",
      "CLI selection IDs must be confirmed from the installed droid /model and exec --help output.",
      "apiKey contains the literal BRIDGE_CLIENT_TOKEN value; settings and backup permissions are 0600.",
    ],
  };
  const manifestPath = args.manifest ?? join(process.cwd(), "tmp/bridge-data/manifest.env");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writePrivateFile(
    manifestPath,
    incoming
      .map((m) => `DROID_${m.extraHeaders?.["X-Bridge-Role"]?.toUpperCase() ?? "CHAT"}_MODEL_ID=${m.model}`)
      .concat([
        `DROID_CHAT_MODEL_ID=relay-chat`,
        `DROID_ORCHESTRATOR_MODEL_ID=relay-orchestrator`,
        `DROID_WORKER_MODEL_ID=relay-worker`,
        `DROID_VALIDATOR_MODEL_ID=relay-validator`,
        `DROID_PROBE_MODEL_ID=relay-probe`,
      ])
      .join("\n") + "\n",
  );
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(configureDroid(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Failed to configure Droid.");
    process.exitCode = 1;
  }
}
