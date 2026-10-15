export interface UpstreamProvider {
  id: "minimax" | "glm" | "openrouter";
  label: string;
  baseUrl: string;
  model: string;
  tokenEnv: string;
  authHeader: "authorization" | "x-api-key";
}

export interface UpstreamSelection {
  provider: UpstreamProvider;
  modelSlots: {
    ANTHROPIC_MODEL: string;
    ANTHROPIC_DEFAULT_OPUS_MODEL: string;
    ANTHROPIC_DEFAULT_SONNET_MODEL: string;
    ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
    CLAUDE_CODE_SUBAGENT_MODEL: string;
  };
}

export interface ProbeAttempt {
  provider: UpstreamProvider["id"];
  label: string;
  baseUrl: string;
  model: string;
  tokenEnv: string;
  ok: boolean;
  status: number;
  stopReason?: string;
  toolName?: string;
  error?: string;
}

// Region-specific keys never participate in another region's auto-discovery.
// Official endpoint references (checked 2026-10-15):
// https://platform.minimax.cn/docs/m-plan/claude-code
// https://platform.minimax.io/docs/m-plan/claude-code
// https://docs.bigmodel.cn/cn/coding-plan/tool/claude
// https://docs.z.ai/devpack/tool/claude
const CANDIDATES: Array<Omit<UpstreamProvider, "tokenEnv"> & { tokenEnvs: string[] }> = [
  {
    id: "minimax",
    label: "MiniMax China Anthropic-compatible",
    baseUrl: "https://api.minimax.cn/anthropic",
    model: "MiniMax-M2.5",
    tokenEnvs: ["MINIMAXCN_API_KEY"],
    authHeader: "authorization",
  },
  {
    id: "minimax",
    label: "MiniMax International Anthropic-compatible",
    baseUrl: "https://api.minimax.io/anthropic",
    model: "MiniMax-M2.5",
    tokenEnvs: ["MINIMAX_INTL_API_KEY"],
    authHeader: "authorization",
  },
  {
    id: "glm",
    label: "Zhipu China GLM Anthropic-compatible x-api-key",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    model: "glm-4.7",
    tokenEnvs: ["GLM_CN_API_KEY"],
    authHeader: "x-api-key",
  },
  {
    id: "glm",
    label: "Zhipu China GLM Anthropic-compatible bearer",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    model: "glm-4.7",
    tokenEnvs: ["GLM_CN_API_KEY"],
    authHeader: "authorization",
  },
  {
    id: "glm",
    label: "Z.AI International GLM Anthropic-compatible",
    baseUrl: "https://api.z.ai/api/anthropic",
    model: "glm-4.7",
    tokenEnvs: ["ZAI_CODING_PLAN_KEY"],
    authHeader: "authorization",
  },
  {
    id: "openrouter",
    label: "OpenRouter free-only Anthropic-compatible",
    baseUrl: "https://openrouter.ai/api",
    model: "qwen/qwen3-coder:free",
    tokenEnvs: ["OPENROUTER_ONLYUSE_FREEMODEL_API_KEY"],
    authHeader: "authorization",
  },
];

const MINIMAX_MODELS = [
  "MiniMax-M2.5",
  "MiniMax-M2.7",
  "MiniMax-M2.5-highspeed",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.1",
  "MiniMax-M2",
  "MiniMax-M3",
];
const GLM_MODELS = ["glm-4.7", "glm-4.6", "glm-4.5", "glm-4.7-flash", "glm-5.2"];
const OPENROUTER_MODELS = [
  "qwen/qwen3-coder:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-3-27b-it:free",
];

export function tokenPresent(name: string): boolean {
  const value = process.env[name];
  return Boolean(value && value.length > 0);
}

export function hasByokSecrets(): boolean {
  return (
    tokenPresent("MINIMAXCN_API_KEY")
    || tokenPresent("MINIMAX_INTL_API_KEY")
    || tokenPresent("GLM_CN_API_KEY")
    || tokenPresent("ZAI_CODING_PLAN_KEY")
    || tokenPresent("OPENROUTER_ONLYUSE_FREEMODEL_API_KEY")
  );
}

export function listUsableProviders(): UpstreamProvider[] {
  const out: UpstreamProvider[] = [];
  for (const candidate of CANDIDATES) {
    const tokenEnv = candidate.tokenEnvs.find(tokenPresent);
    if (!tokenEnv) continue;
    out.push({
      id: candidate.id,
      label: candidate.label,
      baseUrl: candidate.baseUrl,
      model: candidate.model,
      tokenEnv,
      authHeader: candidate.authHeader,
    });
  }
  return out;
}

export function headersFor(provider: UpstreamProvider): Record<string, string> {
  const token = process.env[provider.tokenEnv] ?? "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (provider.authHeader === "authorization") headers.authorization = `Bearer ${token}`;
  else headers["x-api-key"] = token;
  return headers;
}

export function modelSlots(model: string): UpstreamSelection["modelSlots"] {
  return {
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

export async function probeProvider(
  provider: UpstreamProvider,
  model = provider.model,
): Promise<{ ok: boolean; status: number; stopReason?: string; toolName?: string; error?: string; model: string }> {
  const body = {
    model,
    max_tokens: 256,
    tools: [
      {
        name: "relay_probe",
        description: "Echo a nonce. Do not answer in plain text.",
        input_schema: {
          type: "object",
          properties: { nonce: { type: "string" } },
          required: ["nonce"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "relay_probe" },
    messages: [{ role: "user", content: "Call relay_probe with nonce hello-bridge" }],
  };
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      // A discovery probe must not follow a regional endpoint elsewhere.
      redirect: "error",
      headers: headersFor(provider),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    let parsed: { stop_reason?: string; content?: Array<{ type?: string; name?: string }>; error?: { message?: string } };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return { ok: false, status: res.status, error: `non-json ${text.slice(0, 180)}`, model };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: parsed.error?.message ?? `http ${res.status}`, model };
    }
    const tool = parsed.content?.find((block) => block.type === "tool_use");
    return {
      ok: Boolean(tool),
      status: res.status,
      stopReason: parsed.stop_reason,
      toolName: tool?.name,
      model,
      error: tool ? undefined : "no tool_use in probe response",
    };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error), model };
  }
}

function modelsFor(id: UpstreamProvider["id"], fallback: string): string[] {
  if (id === "minimax") return MINIMAX_MODELS;
  if (id === "glm") return GLM_MODELS;
  if (id === "openrouter") return OPENROUTER_MODELS;
  return [fallback];
}

export async function selectUpstream(exclude: { providerIds?: string[]; tokenEnvs?: string[] } = {}): Promise<{ selection?: UpstreamSelection; attempts: ProbeAttempt[] }> {
  const attempts: ProbeAttempt[] = [];
  for (const provider of listUsableProviders()) {
    if (exclude.providerIds?.includes(provider.id)) continue;
    if (exclude.tokenEnvs?.includes(provider.tokenEnv)) continue;
    for (const model of modelsFor(provider.id, provider.model)) {
      const result = await probeProvider(provider, model);
      attempts.push({
        provider: provider.id,
        label: provider.label,
        baseUrl: provider.baseUrl,
        model,
        tokenEnv: provider.tokenEnv,
        ok: result.ok,
        status: result.status,
        stopReason: result.stopReason,
        toolName: result.toolName,
        error: result.error,
      });
      if (result.ok) {
        return {
          selection: { provider: { ...provider, model }, modelSlots: modelSlots(model) },
          attempts,
        };
      }
      if (result.status === 401 || result.status === 403) break;
    }
  }
  return { selection: undefined, attempts };
}

export function selectionFromConfig(input: {
  baseUrl?: string;
  model?: string;
  tokenEnv?: string;
}): UpstreamSelection | undefined {
  if (!input.baseUrl || !input.model || !input.tokenEnv || !tokenPresent(input.tokenEnv)) return undefined;
  const hostname = new URL(input.baseUrl).hostname;
  const id: UpstreamProvider["id"] = /bigmodel|zhipu|glm/i.test(hostname) || /(?:^|\.)z\.ai$/i.test(hostname)
    ? "glm"
    : /openrouter/i.test(hostname)
      ? "openrouter"
      : "minimax";
  return {
    provider: {
      id,
      label: input.baseUrl,
      baseUrl: input.baseUrl,
      model: input.model,
      tokenEnv: input.tokenEnv,
      authHeader: /(?:^|\.)bigmodel\.cn$/i.test(hostname) ? "x-api-key" : "authorization",
    },
    modelSlots: modelSlots(input.model),
  };
}

export function publicSelection(selection: UpstreamSelection): Record<string, string> {
  return {
    provider: selection.provider.id,
    label: selection.provider.label,
    baseUrl: selection.provider.baseUrl,
    model: selection.provider.model,
    tokenEnv: selection.provider.tokenEnv,
    authHeader: selection.provider.authHeader,
  };
}

export function sdkEnv(
  selection: UpstreamSelection | undefined,
  bridgeListen: string,
  authMode: "byok" | "subscription" = "byok",
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "1";
  env.API_TIMEOUT_MS = env.API_TIMEOUT_MS ?? "600000";
  env.CLAUDE_AGENT_SDK_CLIENT_APP = env.CLAUDE_AGENT_SDK_CLIENT_APP ?? "relay-bridge/0.1.0";

  if (authMode === "subscription") {
    // Leave ANTHROPIC_BASE_URL / AUTH_TOKEN / API_KEY exactly as the host
    // process provided them so Claude Code can use its local login.
    const existing = env.ANTHROPIC_BASE_URL ?? "";
    if (existing.includes(bridgeListen) || /127\.0\.0\.1:1878/.test(existing)) {
      throw new Error("refusing to point Claude Code ANTHROPIC_BASE_URL at Relay Bridge");
    }
    return env;
  }

  if (!selection) {
    throw new Error("BYOK sdkEnv requires an upstream selection");
  }
  const token = process.env[selection.provider.tokenEnv] ?? "";
  env.ANTHROPIC_BASE_URL = selection.provider.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = token;
  env.ANTHROPIC_API_KEY = "";
  Object.assign(env, selection.modelSlots);
  if (env.ANTHROPIC_BASE_URL.includes(bridgeListen) || /127\.0\.0\.1:1878/.test(env.ANTHROPIC_BASE_URL)) {
    throw new Error("refusing to point Claude Code ANTHROPIC_BASE_URL at Relay Bridge");
  }
  return env;
}
