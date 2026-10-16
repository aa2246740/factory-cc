import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { modelsFromIds, parseModelIds, validateModels, type BridgeModel } from "../src/models.js";
import { controlBaseUrl } from "./control.js";

interface CustomModel extends Record<string, unknown> { model: string; displayName?: string }
interface ManagedModel { id: string; signature: string }
const legacyRoles = new Map([
  ["relay-probe", ["Relay Probe", "chat"]], ["relay-chat", ["Relay Chat", "chat"]],
  ["relay-orchestrator", ["Relay Orchestrator", "orchestrator"]], ["relay-worker", ["Relay Worker", "worker"]], ["relay-validator", ["Relay Validator", "validator"]],
]);
const help = `Usage: npm run configure-droid -- [options]
  --settings <path>    Droid settings file (or --home <directory>)
  --base-url <URL>     Local Bridge URL
  --models <IDs>      Comma-separated actual model IDs, e.g. glm-5.2,glm-4.7
  --model <ID>        Default model, selected from --models
  --auth byok|subscription  BYOK needs explicit model IDs; subscription defaults to sonnet,opus,haiku
  --manifest <path>   Private script manifest
  --revert            Restore original settings and remove managed-model metadata
BRIDGE_CLIENT_TOKEN is required. BRIDGE_UPSTREAM_MODEL can supply the BYOK default.
Existing user custom models and valid Mission model choices are preserved.`;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === "--help" || flag === "-h") { out.help = "1"; continue; }
    if (flag === "--revert") { out.revert = "1"; continue; }
    if (!["--settings", "--home", "--base-url", "--manifest", "--models", "--model", "--auth"].includes(flag)) throw new Error("Unknown configuration option; use --help.");
    if (out[flag.slice(2)] !== undefined) throw new Error(`Duplicate option ${flag}.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    out[flag.slice(2)] = value;
  }
  if (out.auth !== undefined && !["byok", "subscription"].includes(out.auth)) throw new Error("--auth must be byok or subscription.");
  return out;
}

function writePrivateFile(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

/** Match an owned entry without persisting its API key in metadata. */
function signature(model: CustomModel): string {
  // Droid persists derived IDs/positions and the false image-support default.
  // These are not user edits to the model connection and must not duplicate it
  // on the next launch. A nondefault image flag remains part of the identity.
  const fields = Object.fromEntries(Object.entries(model).filter(([key, value]) => !["apiKey", "id", "index"].includes(key)
    && !(key === "noImageSupport" && value === false)).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function managedModels(path: string): ManagedModel[] {
  if (!existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; models?: unknown };
    if (value.version !== 1 || !Array.isArray(value.models) || !value.models.every((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && /^[a-f0-9]{64}$/.test(entry.signature))) throw new Error();
    return value.models as ManagedModel[];
  } catch { throw new Error("Invalid managed-model metadata; settings were not changed."); }
}

function isLegacy(model: CustomModel): boolean {
  const legacy = legacyRoles.get(model.model);
  if (!legacy || model.displayName !== legacy[0] || model.provider !== "anthropic" || model.authMode !== "bearer"
      || typeof model.baseUrl !== "string" || typeof model.apiKey !== "string") return false;
  try { controlBaseUrl(model.baseUrl); } catch { return false; }
  const headers = model.extraHeaders;
  return !!headers && typeof headers === "object" && !Array.isArray(headers) && (headers as Record<string, unknown>)["X-Bridge-Role"] === legacy[1];
}

/** Factory numbers duplicate display names, not positions in customModels. */
function selectionIds(models: CustomModel[]): string[] {
  const counts = new Map<string, number>();
  return models.map((model) => {
    const label = (model.displayName ?? model.model).trim().replace(/\s+/g, "-");
    const index = counts.get(label) ?? 0; counts.set(label, index + 1);
    return `custom:${label}-${index}`;
  });
}

export function configureDroid(argv: string[], env: NodeJS.ProcessEnv = process.env, catalog?: BridgeModel[]): Record<string, unknown> {
  const args = parseArgs(argv);
  if (args.help === "1") return { help };
  const settingsPath = args.settings ?? join(args.home ?? env.HOME ?? ".", ".factory/settings.json");
  const backup = `${settingsPath}.relay-bridge.bak`, absentMarker = `${backup}.absent`;
  const metadataPath = `${settingsPath}.relay-bridge.models.json`;
  if (args.revert === "1") {
    if (existsSync(absentMarker)) rmSync(settingsPath, { force: true });
    else { if (!existsSync(backup)) throw new Error("No backup to revert."); writePrivateFile(settingsPath, readFileSync(backup, "utf8")); }
    rmSync(metadataPath, { force: true });
    return { reverted: true, settingsPath };
  }
  const token = env.BRIDGE_CLIENT_TOKEN;
  if (!token?.trim()) throw new Error("BRIDGE_CLIENT_TOKEN is required; settings were not changed.");
  const baseUrl = controlBaseUrl(args["base-url"] ?? "http://127.0.0.1:18787");
  const auth = args.auth ?? env.BRIDGE_AUTH ?? "byok";
  if (auth !== "byok" && auth !== "subscription") throw new Error("Authentication must be byok or subscription.");
  const requestedIds = args.models ? parseModelIds(args.models) : undefined;
  const selectedId = args.model ?? (auth === "byok" ? env.BRIDGE_UPSTREAM_MODEL : undefined);
  if (selectedId && parseModelIds(selectedId).length !== 1) throw new Error("--model must select one model ID.");
  const ids = requestedIds ?? (selectedId ? [selectedId] : auth === "subscription" ? ["sonnet", "opus", "haiku"] : []);
  if (!catalog && !ids.length) throw new Error("BYOK requires explicit actual model IDs: pass --models, --model, or BRIDGE_UPSTREAM_MODEL.");
  const configured = catalog ? validateModels(catalog) : modelsFromIds(ids, auth);
  if (requestedIds && (requestedIds.length !== configured.length || requestedIds.some((id) => !configured.some((model) => model.id === id)))) throw new Error("--models must match the configured catalog.");
  const defaultId = selectedId ?? configured[0]!.id;
  if (!configured.some((model) => model.id === defaultId)) throw new Error("The default model must be included in --models.");

  let current: Record<string, unknown> & { customModels?: CustomModel[] } = {}, original: string | undefined;
  if (existsSync(settingsPath)) {
    original = readFileSync(settingsPath, "utf8");
    try {
      current = JSON.parse(original) as typeof current;
      if (!current || Array.isArray(current) || typeof current !== "object" || (current.customModels !== undefined
        && (!Array.isArray(current.customModels) || !current.customModels.every((item) => item && typeof item === "object" && !Array.isArray(item) && typeof item.model === "string" && (item.displayName === undefined || typeof item.displayName === "string"))))) throw new Error();
    } catch { throw new Error("Invalid Droid settings JSON; settings were not changed."); }
  }
  const previous = managedModels(metadataPath), existing = current.customModels ?? [];
  const owned = new Set(existing.filter((item) => isLegacy(item) || previous.some((entry) => entry.id === item.model && entry.signature === signature(item))));
  const kept = existing.filter((item) => !owned.has(item));
  const incoming: CustomModel[] = configured.map((model) => ({ model: model.id, displayName: model.displayName, baseUrl, apiKey: token,
    provider: "anthropic", authMode: "bearer", maxOutputTokens: 4096 }));
  const combined = [...kept, ...incoming], oldIds = selectionIds(existing), newIds = selectionIds(combined);
  const defaultSelection = newIds[kept.length + configured.findIndex((model) => model.id === defaultId)]!;
  const canonicalForModel = new Map(configured.map((model, index) => [model.id, newIds[kept.length + index]!]));
  const migrate = (value: unknown): string => {
    if (typeof value !== "string") return defaultSelection;
    const oldIndex = oldIds.indexOf(value);
    if (oldIndex >= 0) {
      const old = existing[oldIndex]!, keptIndex = kept.indexOf(old);
      return keptIndex >= 0 ? newIds[keptIndex]! : canonicalForModel.get(old.model) ?? defaultSelection;
    }
    if (newIds.includes(value)) return value;
    if (canonicalForModel.has(value)) return canonicalForModel.get(value)!;
    const keptIndex = kept.findIndex((item) => item.model === value);
    return keptIndex >= 0 ? newIds[keptIndex]! : defaultSelection;
  };
  current.customModels = combined;
  const priorDefaults = current.sessionDefaultSettings;
  if (priorDefaults !== undefined && (!priorDefaults || typeof priorDefaults !== "object" || Array.isArray(priorDefaults))) throw new Error("Invalid session default settings; settings were not changed.");
  const defaults = (priorDefaults ?? {}) as Record<string, unknown>;
  const sessionDefaults: Record<string, unknown> = { ...defaults,
    model: args.model ? defaultSelection : migrate(Object.hasOwn(defaults, "model") ? defaults.model : current.model) };
  if (defaults.specModeModel !== undefined || current.specModeModel !== undefined) {
    const specModel = Object.hasOwn(defaults, "specModeModel") ? defaults.specModeModel : current.specModeModel;
    sessionDefaults.specModeModel = typeof specModel === "string" ? migrate(specModel) : specModel;
    delete current.specModeModel;
  }
  current.sessionDefaultSettings = sessionDefaults;
  delete current.model;
  current.missionOrchestratorModel = migrate(current.missionOrchestratorModel);
  const priorMission = current.missionModelSettings;
  if (priorMission !== undefined && (!priorMission || typeof priorMission !== "object" || Array.isArray(priorMission))) throw new Error("Invalid Mission settings; settings were not changed.");
  const mission = (priorMission ?? {}) as Record<string, unknown>;
  current.missionModelSettings = { skipScrutiny: false, skipUserTesting: false, ...mission, workerModel: migrate(mission.workerModel), validationWorkerModel: migrate(mission.validationWorkerModel) };
  mkdirSync(dirname(settingsPath), { recursive: true });
  if (!existsSync(backup) && !existsSync(absentMarker)) {
    if (original === undefined) writePrivateFile(absentMarker, "original settings did not exist\n"); else writePrivateFile(backup, original);
  }
  if (existsSync(backup)) chmodSync(backup, 0o600);
  if (existsSync(absentMarker)) chmodSync(absentMarker, 0o600);
  writePrivateFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
  writePrivateFile(metadataPath, `${JSON.stringify({ version: 1, models: incoming.map((model) => ({ id: model.model, signature: signature(model) })) }, null, 2)}\n`);
  const manifestPath = args.manifest ?? join(process.cwd(), "tmp/bridge-data/manifest.env");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writePrivateFile(manifestPath, [
    `DROID_MODEL_IDS=${configured.map((model) => canonicalForModel.get(model.id)).join(",")}`,
    `DROID_DEFAULT_MODEL_ID=${defaultSelection}`,
    ...["CHAT", "ORCHESTRATOR", "WORKER", "VALIDATOR", "PROBE"].map((role) => `DROID_${role}_MODEL_ID=${defaultSelection}`),
  ].join("\n") + "\n");
  return { settingsPath, backup, metadataPath, baseUrl, defaultModelId: defaultId, defaultSelectionId: defaultSelection,
    modelIds: configured.map((model) => model.id), models: configured.map((model) => ({ ...model, selectionId: canonicalForModel.get(model.id) })),
    notes: ["The model menu contains actual models; Mission roles select from the same list.", "Legacy manifest role variables remain compatibility aliases for the default model.", "apiKey contains the literal local BRIDGE_CLIENT_TOKEN; settings, backup and metadata permissions are 0600."] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const result = configureDroid(process.argv.slice(2)); console.log(typeof result.help === "string" ? result.help : JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "Failed to configure Droid."); process.exitCode = 1; }
}
