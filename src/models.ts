import type { BridgeConfig } from "./config.js";
import { BridgeError } from "./types.js";
import type { AuthMode } from "./upstream/auth-env.js";
import { selectionFromConfig, type UpstreamSelection } from "./upstream/providers.js";

/** Which runtime owns a menu entry or a session. Absent means Claude, including records written before Cursor existed. */
export type ModelProvider = "claude" | "cursor";

/** One Cursor parameter pinned to an allowed value. Omitting these makes the SDK use each parameter's first allowed value. */
export interface CursorModelParameter {
  id: string;
  value: string;
}

/** A model is an inference choice. Factory roles are not model identifiers. */
export interface BridgeModel {
  id: string;
  model: string;
  displayName: string;
  /** Set for Cursor menu entries. Claude entries leave this unset so older catalogs stay identical. */
  provider?: ModelProvider;
  /** Full explicit Cursor selection. Required when provider is cursor. */
  cursor?: { id: string; params: CursorModelParameter[]; parameters?: CursorParameterValues[] };
}

/** Allowed values copied from the catalog so a later request can map a reasoning level. */
export interface CursorParameterValues {
  id: string;
  values: Array<{ value: string }>;
}

/** Menu ids use this prefix so they cannot collide with Claude model ids. `:` is inside validId; brackets are not. */
export const CURSOR_MODEL_PREFIX = "cursor:";

export function providerFromModelId(id: string): ModelProvider {
  return id.startsWith(CURSOR_MODEL_PREFIX) ? "cursor" : "claude";
}

export interface RequestModel {
  id: string;
  model?: string;
  displayName: string;
  selection?: UpstreamSelection;
  provider: ModelProvider;
  cursor?: { id: string; params: CursorModelParameter[]; parameters?: CursorParameterValues[] };
  routeKey: string;
}

const names: Record<string, string> = { sonnet: "Claude Sonnet", opus: "Claude Opus", haiku: "Claude Haiku", fable: "Claude Fable" };
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(value);

export function parseModelIds(value: string): string[] {
  const ids = value.split(",").map((id) => id.trim());
  if (!ids.length || ids.some((id) => !validId(id)) || new Set(ids).size !== ids.length) {
    throw new BridgeError(400, "invalid_model_catalog", "Model IDs must be nonempty, unique, comma-separated identifiers.");
  }
  return ids;
}

export function modelsFromIds(ids: string[], authMode: AuthMode = "byok"): BridgeModel[] {
  const friendly = authMode === "claude-config" || authMode === "subscription" || authMode === "anthropic-api";
  return validateModels(ids.map((id) => ({ id, model: id,
    displayName: friendly && names[id] ? names[id]! : /^glm-/i.test(id) ? id.toUpperCase() : id,
  })));
}

export function validateModels(models: BridgeModel[]): BridgeModel[] {
  if (!Array.isArray(models) || !models.length || models.length > 100) throw new BridgeError(400, "invalid_model_catalog", "Configure between one and 100 models.");
  const seen = new Set<string>();
  return models.map((item) => {
    if (!item || !validId(item.id) || !validId(item.model) || typeof item.displayName !== "string"
      || !item.displayName.trim() || item.displayName.length > 160 || /[\x00-\x1f\x7f]/.test(item.displayName) || seen.has(item.id)) {
      throw new BridgeError(400, "invalid_model_catalog", "Each model needs a unique ID, an actual model ID and a readable display name.");
    }
    if (item.provider !== undefined && item.provider !== "claude" && item.provider !== "cursor") {
      throw new BridgeError(400, "invalid_model_catalog", "Each model provider must be claude or cursor.");
    }
    const cursor = item.provider === "cursor" ? normalizeCursorSelection(item.cursor) : undefined;
    seen.add(item.id);
    return { id: item.id, model: item.model, displayName: item.displayName.trim(),
      ...(item.provider === "cursor" ? { provider: "cursor" as const, cursor } : item.provider === "claude" ? { provider: "claude" as const } : {}) };
  });
}

function normalizeCursorSelection(selection: BridgeModel["cursor"]): { id: string; params: CursorModelParameter[]; parameters?: CursorParameterValues[] } {
  if (!selection || !validId(selection.id) || !Array.isArray(selection.params)) {
    throw new BridgeError(400, "invalid_model_catalog", "A Cursor model needs an explicit SDK id and parameter list.");
  }
  const params = selection.params.map((param) => {
    if (!param || !validId(param.id) || typeof param.value !== "string" || !param.value || param.value.length > 64 || /[\x00-\x1f\x7f]/.test(param.value)) {
      throw new BridgeError(400, "invalid_model_catalog", "Each Cursor parameter needs an id and a value.");
    }
    return { id: param.id, value: param.value };
  });
  const parameters = normalizeCursorParameters(selection.parameters);
  return { id: selection.id, params, ...(parameters ? { parameters } : {}) };
}

function normalizeCursorParameters(parameters: CursorParameterValues[] | undefined): CursorParameterValues[] | undefined {
  if (parameters === undefined) return undefined;
  if (!Array.isArray(parameters)) throw new BridgeError(400, "invalid_model_catalog", "Cursor parameter specs must be a list.");
  return parameters.map((parameter) => {
    if (!parameter || !validId(parameter.id) || !Array.isArray(parameter.values) || !parameter.values.length) {
      throw new BridgeError(400, "invalid_model_catalog", "Each Cursor parameter spec needs an id and allowed values.");
    }
    const values = parameter.values.map((value) => {
      if (!value || typeof value.value !== "string" || !value.value || value.value.length > 64 || /[\x00-\x1f\x7f]/.test(value.value)) {
        throw new BridgeError(400, "invalid_model_catalog", "Each Cursor parameter value must be a short string.");
      }
      return { value: value.value };
    });
    return { id: parameter.id, values };
  });
}

export function configuredModels(config: Pick<BridgeConfig, "models" | "authMode" | "upstreamModel">): BridgeModel[] {
  if (config.models !== undefined) return validateModels(config.models);
  if (config.authMode === "subscription" || config.authMode === "anthropic-api") return modelsFromIds(["sonnet", "opus", "haiku"], config.authMode);
  // byok uses the explicit upstream model. cloud and inherit stay empty unless BRIDGE_MODELS is set,
  // so a cloud process can still follow ANTHROPIC_MODEL from its own environment.
  return config.upstreamModel ? modelsFromIds([config.upstreamModel]) : [];
}

export function resolveRequestModel(config: BridgeConfig, requestedModel: string): RequestModel {
  const profile = configuredModels(config).find((item) => item.id === requestedModel);
  if (config.models !== undefined && !profile) {
    throw new BridgeError(400, "unknown_model", "This model is not configured. Select a model from this Bridge's model list.");
  }
  // Old, manually configured clients and verification fixtures retain their
  // fixed-upstream protocol until migrated. New launchers always set models.
  const model = profile?.model ?? (config.authMode === "byok" ? config.upstreamModel : undefined);
  const selection = config.authMode === "byok"
    ? selectionFromConfig({ baseUrl: config.upstreamBaseUrl, model, tokenEnv: config.upstreamTokenEnv })
    : undefined;
  if (config.authMode === "byok" && !selection) throw new BridgeError(401, "blocked_auth", "BYOK requires an explicit endpoint, model and key environment variable.");
  const provider = profile?.provider ?? providerFromModelId(profile?.id ?? requestedModel);
  return {
    id: profile?.id ?? requestedModel,
    model,
    displayName: profile?.displayName ?? model ?? "Claude Code default",
    selection,
    provider,
    ...(profile?.cursor ? { cursor: profile.cursor } : {}),
    // Claude route keys stay the historical shape. Cursor keys also pin the parameter list.
    routeKey: JSON.stringify({ authMode: config.authMode, model: model ?? null,
      baseUrl: selection?.provider.baseUrl ?? null, tokenEnv: selection?.provider.tokenEnv ?? null,
      ...(provider === "cursor" ? { provider, cursor: profile?.cursor ?? null } : {}) }),
  };
}
