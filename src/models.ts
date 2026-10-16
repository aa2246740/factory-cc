import type { BridgeConfig } from "./config.js";
import { BridgeError } from "./types.js";
import type { AuthMode } from "./upstream/auth-env.js";
import { selectionFromConfig, type UpstreamSelection } from "./upstream/providers.js";

/** A model is an inference choice. Factory roles are not model identifiers. */
export interface BridgeModel {
  id: string;
  model: string;
  displayName: string;
}

export interface RequestModel {
  id: string;
  model?: string;
  displayName: string;
  selection?: UpstreamSelection;
  routeKey: string;
}

const names: Record<string, string> = { sonnet: "Claude Sonnet", opus: "Claude Opus", haiku: "Claude Haiku" };
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(value);

export function parseModelIds(value: string): string[] {
  const ids = value.split(",").map((id) => id.trim());
  if (!ids.length || ids.some((id) => !validId(id)) || new Set(ids).size !== ids.length) {
    throw new BridgeError(400, "invalid_model_catalog", "Model IDs must be nonempty, unique, comma-separated identifiers.");
  }
  return ids;
}

export function modelsFromIds(ids: string[], authMode: AuthMode = "byok"): BridgeModel[] {
  const friendly = authMode === "subscription" || authMode === "anthropic-api";
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
    seen.add(item.id);
    return { id: item.id, model: item.model, displayName: item.displayName.trim() };
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
  return {
    id: profile?.id ?? requestedModel,
    model,
    displayName: profile?.displayName ?? model ?? "Claude Code default",
    selection,
    routeKey: JSON.stringify({ authMode: config.authMode, model: model ?? null,
      baseUrl: selection?.provider.baseUrl ?? null, tokenEnv: selection?.provider.tokenEnv ?? null }),
  };
}
