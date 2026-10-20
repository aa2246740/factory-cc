import type { CursorModelParameter } from "../models.js";
import type { MessagesRequest } from "../types.js";

/**
 * Droid 0.236.0 with baseModelId claude-sonnet-5-5 (captured on port 18797).
 * Every selector level sends both fields. `off` does not send effort "off":
 * thinking becomes `{ type: "between_tools" }` and effort stays the base
 * model's default, which is `high`. The other levels keep adaptive thinking
 * and set `output_config.effort`. No flag still sends effort `high`, because
 * that is Sonnet 5's default. A request that omits both signals has no level.
 */
const EFFORT_PARAMETER_IDS = new Set(["reasoning_effort", "effort"]);
const CLAUDE_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
/** Low to high. Equidistant catalog values pick the lower rank. */
const RANK = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface CursorParameterSpec {
  id: string;
  values: Array<{ value: string }>;
}

export interface ClaudeReasoningOptions {
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinking?: { type: "disabled" } | { type: "adaptive"; display: "summarized" };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The selector level, or undefined when the request does not carry one. */
export function droidReasoningLevel(request: Pick<MessagesRequest, "thinking" | "output_config">): string | undefined {
  if (object(request.thinking)?.type === "between_tools") return "off";
  const effort = object(request.output_config)?.effort;
  return typeof effort === "string" && effort.trim() ? effort.trim() : undefined;
}

function rankOf(value: string): number {
  return RANK.indexOf(value);
}

function lowest(allowed: readonly string[]): string {
  const ranked = allowed.filter((value) => rankOf(value) >= 0);
  if (!ranked.length) return allowed[0] ?? "";
  return [...ranked].sort((left, right) => rankOf(left) - rankOf(right))[0]!;
}

/** Map a Droid level onto one published catalog value. `off` and `none` are the lowest. */
export function mapReasoningValue(level: string, allowed: readonly string[]): string {
  if (!allowed.length) return level;
  const normalized = level === "none" ? "off" : level;
  if (normalized === "off") return lowest(allowed);
  if (allowed.includes(normalized)) return normalized;
  const target = rankOf(normalized);
  const ranked = allowed.filter((value) => rankOf(value) >= 0);
  if (target < 0 || !ranked.length) return lowest(allowed);
  return [...ranked].sort((left, right) => Math.abs(rankOf(left) - target) - Math.abs(rankOf(right) - target) || rankOf(left) - rankOf(right))[0]!;
}

/**
 * Replace only the effort-like parameter. `fast` and `context` stay on the pin.
 * No level keeps the pin. A model that does not publish `reasoning_effort` or
 * `effort` is unchanged, including when Cursor adds that parameter later.
 */
export function applyCursorReasoning(
  params: readonly CursorModelParameter[],
  parameters: readonly CursorParameterSpec[] | undefined,
  level: string | undefined,
): CursorModelParameter[] {
  if (!level) return params.map((param) => ({ ...param }));
  const spec = parameters?.find((parameter) => EFFORT_PARAMETER_IDS.has(parameter.id));
  if (!spec) return params.map((param) => ({ ...param }));
  const allowed = spec.values.map((value) => value.value).filter((value) => value);
  if (!allowed.length) return params.map((param) => ({ ...param }));
  const mapped = mapReasoningValue(level, allowed);
  return params.map((param) => param.id === spec.id ? { id: param.id, value: mapped } : { ...param });
}

/**
 * SDK 0.3.300 `query` options. No level returns undefined so the call stays
 * the same as before. `off` disables thinking and does not forward the leftover
 * effort `high`. Other levels set `effort` and adaptive thinking.
 */
export function claudeReasoningOptions(level: string | undefined): ClaudeReasoningOptions | undefined {
  if (!level) return undefined;
  if (level === "off" || level === "none") return { thinking: { type: "disabled" } };
  if (level === "minimal") return { effort: "low", thinking: { type: "adaptive", display: "summarized" } };
  if (CLAUDE_EFFORT.has(level)) return { effort: level as ClaudeReasoningOptions["effort"], thinking: { type: "adaptive", display: "summarized" } };
  return undefined;
}

export function claudeReasoningKey(request: Pick<MessagesRequest, "thinking" | "output_config">): string {
  return JSON.stringify(claudeReasoningOptions(droidReasoningLevel(request)) ?? null);
}

/** Hash input for a request whose selector level is the one already stored on the session. */
export function requestAtReasoningLevel(request: MessagesRequest, level: string): MessagesRequest {
  const thinking = level === "off" || level === "none" ? { type: "between_tools" } : { type: "adaptive", display: "summarized" };
  const effort = level === "off" || level === "none" ? "high" : level;
  const output = { ...(object(request.output_config) ?? {}), effort };
  return { ...request, thinking: thinking as MessagesRequest["thinking"], output_config: output as MessagesRequest["output_config"] };
}

/**
 * Drop the selector so the hash matches a session recorded before a level was
 * stored. `between_tools` becomes the adaptive shape Droid sends for every
 * other level; that is the only thinking change the selector makes.
 */
export function requestWithoutReasoningLevel(request: MessagesRequest): MessagesRequest {
  const output = { ...(object(request.output_config) ?? {}) };
  delete output.effort;
  const thinking = object(request.thinking)?.type === "between_tools" ? { type: "adaptive", display: "summarized" } : request.thinking;
  return {
    ...request,
    thinking: thinking as MessagesRequest["thinking"],
    output_config: Object.keys(output).length ? output as MessagesRequest["output_config"] : undefined,
  };
}
