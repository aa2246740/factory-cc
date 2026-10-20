import { BridgeError } from "../../types.js";
import { CURSOR_MODEL_PREFIX, type BridgeModel, type CursorModelParameter } from "../../models.js";
import { CURSOR_DEFAULT_MODEL_IDS, CURSOR_FIRST_PARTY_IDS, CURSOR_MENU_PINS, standardContextValue } from "./pins.js";

/** Shape of `Cursor.models.list()` (`ModelListItem`). Hand-written fixtures use this; nothing here calls the SDK. */
export interface CursorCatalogParameter {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
}

export interface CursorCatalogItem {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: CursorCatalogParameter[];
  variants?: Array<{ params: CursorModelParameter[]; displayName: string; description?: string; isDefault?: boolean }>;
}

export type CursorMenuRequest =
  | { scope: "default" }
  | { scope: "first-party" }
  | { scope: "explicit"; specs: string[] };

const AUTO_IDS = new Set(["auto", "auto-smart"]);

function splitSpecs(value: string): string[] {
  const specs: string[] = [];
  let current = "";
  let depth = 0;
  for (const char of value) {
    if (char === "," && depth === 0) {
      if (current.trim()) specs.push(current.trim());
      current = "";
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]" && depth > 0) depth -= 1;
    current += char;
  }
  if (current.trim()) specs.push(current.trim());
  return specs;
}

export function parseCursorModelsFlag(value: string): CursorMenuRequest {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "default") return { scope: "default" };
  if (trimmed === "first-party") return { scope: "first-party" };
  if (trimmed === "all") {
    throw new BridgeError(400, "invalid_cursor_models", "The Cursor menu does not expand to the whole catalog. Pass default, first-party, or a comma-separated list.");
  }
  const specs = splitSpecs(trimmed);
  if (!specs.length || new Set(specs).size !== specs.length) {
    throw new BridgeError(400, "invalid_cursor_models", "Cursor model specs must be a comma-separated list of unique ids.");
  }
  return { scope: "explicit", specs };
}

export function cursorMenuFromCatalog(catalog: readonly CursorCatalogItem[], request: string | CursorMenuRequest): BridgeModel[] {
  const parsed = typeof request === "string" ? parseCursorModelsFlag(request) : request;
  const specs = parsed.scope === "default" ? [...CURSOR_DEFAULT_MODEL_IDS]
    : parsed.scope === "first-party" ? [...CURSOR_FIRST_PARTY_IDS]
      : parsed.specs;
  const models = specs.map((spec) => menuEntry(catalog, spec, parsed.scope !== "explicit"));
  if (parsed.scope === "default" && (models.length !== 2
    || models[0]?.displayName !== "Cursor · Composer 2.5"
    || models[1]?.displayName !== "Cursor · Grok 4.7")) {
    throw new BridgeError(400, "invalid_cursor_models", "The default Cursor menu must be Composer 2.5 and Grok 4.7.");
  }
  return models;
}

function menuEntry(catalog: readonly CursorCatalogItem[], spec: string, firstPartyOnly: boolean): BridgeModel {
  const parsed = parseSpec(spec);
  if (AUTO_IDS.has(parsed.id)) {
    throw new BridgeError(400, "invalid_cursor_models", "Auto is not a Cursor menu entry; it can route a request to a third-party model.");
  }
  const item = findItem(catalog, parsed.id);
  if (!item) throw new BridgeError(400, "invalid_cursor_models", `Cursor catalog has no model ${parsed.id}.`);
  if (firstPartyOnly && !isFirstParty(item)) {
    throw new BridgeError(400, "invalid_cursor_models", `${item.id} is not a first-party Cursor model. Name it explicitly to add it.`);
  }
  const canonical = pinParams(item);
  const params = parsed.overrides ? pinParams(item, parsed.overrides) : canonical;
  const id = bridgeId(item.id, params, canonical);
  return {
    id,
    model: item.id,
    displayName: menuLabel(item, params, canonical),
    provider: "cursor",
    cursor: { id: item.id, params },
  };
}

function isFirstParty(item: CursorCatalogItem): boolean {
  const names = [item.id, ...(item.aliases ?? [])];
  return names.some((name) => (CURSOR_FIRST_PARTY_IDS as readonly string[]).includes(name) || /^cursor-grok-4\.[567]$/.test(name));
}

export function findItem(catalog: readonly CursorCatalogItem[], id: string): CursorCatalogItem | undefined {
  const bare = id.startsWith(CURSOR_MODEL_PREFIX) ? id.slice(CURSOR_MODEL_PREFIX.length) : id;
  return catalog.find((item) => item.id === bare || item.aliases?.includes(bare) || item.id === id);
}

/** Fill every published parameter. Unknown parameters are refused instead of taking the SDK's first value. */
export function pinParams(item: CursorCatalogItem, overrides?: Map<string, string>): CursorModelParameter[] {
  const defined = item.parameters ?? [];
  if (overrides) {
    for (const id of overrides.keys()) {
      if (!defined.some((parameter) => parameter.id === id)) {
        throw new BridgeError(400, "invalid_cursor_models", `Cursor model ${item.id} has no parameter ${id}.`);
      }
    }
  }
  return defined.map((parameter) => {
    const value = overrides?.get(parameter.id) ?? pinnedValue(item.id, parameter);
    if (!value || !parameter.values.some((allowed) => allowed.value === value)) {
      throw new BridgeError(400, "invalid_cursor_models", `Cursor model ${item.id} cannot pin ${parameter.id}=${value ?? "(unset)"}.`);
    }
    return { id: parameter.id, value };
  });
}

function pinnedValue(modelId: string, parameter: CursorCatalogParameter): string | undefined {
  if (parameter.id === "fast") return CURSOR_MENU_PINS.fast;
  // Live Grok 4.7 names this `reasoning_effort`. Older Grok rows name it `effort`.
  if (parameter.id === "effort" || parameter.id === "reasoning_effort") return CURSOR_MENU_PINS.effort;
  if (parameter.id === "context") return standardContextValue(parameter.values);
  throw new BridgeError(400, "invalid_cursor_models", `Cursor model ${modelId} has parameter ${parameter.id}, which has no pin. Refusing the SDK's first allowed value.`);
}

function menuLabel(item: CursorCatalogItem, params: CursorModelParameter[], canonical: CursorModelParameter[]): string {
  if (sameParams(params, canonical) && item.id === "composer-2.5") return "Cursor · Composer 2.5";
  if (sameParams(params, canonical) && item.id === "grok-4.7") return "Cursor · Grok 4.7";
  if (sameParams(params, canonical)) return `Cursor · ${item.displayName}`;
  const detail = [...params].sort((left, right) => left.id.localeCompare(right.id)).map((param) => `${param.id}=${param.value}`).join(", ");
  return `Cursor · ${item.displayName} (${detail})`;
}

function bridgeId(sdkId: string, params: CursorModelParameter[], canonical: CursorModelParameter[]): string {
  if (sameParams(params, canonical)) return `${CURSOR_MODEL_PREFIX}${sdkId}`;
  const suffix = [...params].sort((left, right) => left.id.localeCompare(right.id))
    .map((param) => `${param.id}-${param.value.replace(/[^A-Za-z0-9._+-]/g, "-")}`).join(".");
  return `${CURSOR_MODEL_PREFIX}${sdkId}.${suffix}`;
}

function sameParams(left: readonly CursorModelParameter[], right: readonly CursorModelParameter[]): boolean {
  const key = (params: readonly CursorModelParameter[]) => [...params].sort((a, b) => a.id.localeCompare(b.id)).map((param) => `${param.id}=${param.value}`).join("\n");
  return key(left) === key(right);
}

/** `id` or `id[key=value,key=value]`. `composer-2.5-fast` is the one discrete alias the SDK docs define. */
function parseSpec(spec: string): { id: string; overrides?: Map<string, string> } {
  const trimmed = spec.trim();
  if (trimmed === "composer-2.5-fast") return { id: "composer-2.5", overrides: new Map([["fast", "true"]]) };
  const match = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)(?:\[([^\]]*)\])?$/.exec(trimmed);
  if (!match?.[1]) throw new BridgeError(400, "invalid_cursor_models", `Cannot parse Cursor model spec ${spec}.`);
  if (!match[2]) return { id: match[1].startsWith(CURSOR_MODEL_PREFIX) ? match[1].slice(CURSOR_MODEL_PREFIX.length) : match[1] };
  const overrides = new Map<string, string>();
  for (const part of match[2].split(",")) {
    const separator = part.indexOf("=");
    const id = separator >= 0 ? part.slice(0, separator).trim() : "";
    const value = separator >= 0 ? part.slice(separator + 1).trim() : "";
    if (!id || !value || overrides.has(id)) throw new BridgeError(400, "invalid_cursor_models", `Bad parameter list in ${spec}.`);
    overrides.set(id, value);
  }
  return { id: match[1], overrides };
}

/** Keep catalog fields the menu can pin. Drop anything else the SDK attached, including credentials. */
export function coerceCursorCatalog(value: unknown): CursorCatalogItem[] {
  if (!Array.isArray(value)) throw new Error("Cursor catalog response is not a list.");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Cursor catalog row ${index} is invalid.`);
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || typeof row.displayName !== "string" || !row.displayName) {
      throw new Error(`Cursor catalog row ${index} is invalid.`);
    }
    const item: CursorCatalogItem = { id: row.id, displayName: row.displayName };
    if (typeof row.description === "string") item.description = row.description;
    if (Array.isArray(row.aliases)) item.aliases = row.aliases.filter((alias): alias is string => typeof alias === "string");
    if (Array.isArray(row.parameters)) item.parameters = row.parameters as CursorCatalogItem["parameters"];
    if (Array.isArray(row.variants)) item.variants = row.variants as CursorCatalogItem["variants"];
    return item;
  });
}

export function formatCursorCatalog(catalog: readonly CursorCatalogItem[], filter?: string): string {
  const query = filter?.trim().toLowerCase();
  const rows = catalog.filter((item) => !query || item.id.toLowerCase().includes(query) || item.displayName.toLowerCase().includes(query) || item.aliases?.some((alias) => alias.toLowerCase().includes(query)));
  if (!rows.length) return "No Cursor models match.\n";
  return rows.map((item) => {
    const params = (item.parameters ?? []).map((parameter) => `${parameter.id}=${parameter.values.map((value) => value.value).join("|")}`).join(" ");
    return `${item.id}\t${item.displayName}${params ? `\t${params}` : ""}`;
  }).join("\n") + "\n";
}
