import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

function models(baseUrl: string): CustomModel[] {
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
    apiKey: "${BRIDGE_CLIENT_TOKEN}",
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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const settingsPath = args.settings ?? join(args.home ?? process.env.HOME ?? ".", ".factory/settings.json");
  const baseUrl = args["base-url"] ?? "http://127.0.0.1:18787";
  const revert = args.revert === "1";

  mkdirSync(dirname(settingsPath), { recursive: true });
  const backup = `${settingsPath}.relay-bridge.bak`;

  if (revert) {
    if (!existsSync(backup)) {
      console.error("No backup to revert.");
      process.exit(1);
    }
    copyFileSync(backup, settingsPath);
    console.log(`Reverted ${settingsPath} from backup.`);
    return;
  }

  let current: { customModels?: CustomModel[] } = {};
  if (existsSync(settingsPath)) {
    current = JSON.parse(readFileSync(settingsPath, "utf8")) as { customModels?: CustomModel[] };
    if (!existsSync(backup)) copyFileSync(settingsPath, backup);
  } else {
    writeFileSync(backup, "{}\n");
  }

  const incoming = models(baseUrl);
  const existing = current.customModels ?? [];
  const kept = existing.filter((item) => !incoming.some((m) => m.model === item.model));
  current.customModels = [...kept, ...incoming];
  writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`);

  const manifest = {
    settingsPath,
    backup,
    baseUrl,
    modelIds: incoming.map((m) => m.model),
    notes: [
      "model is the Messages API model field.",
      "CLI selection IDs must be confirmed from the installed droid /model and exec --help output.",
      "apiKey uses official ${BRIDGE_CLIENT_TOKEN} expansion in settings.json.",
    ],
  };
  const manifestPath = args.manifest ?? join(process.cwd(), "tmp/bridge-data/manifest.env");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
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
  console.log(JSON.stringify(manifest, null, 2));
}

main();
