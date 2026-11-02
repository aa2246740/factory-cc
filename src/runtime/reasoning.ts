import type { CursorModelParameter } from "../models.js";
import { BridgeError, type MessagesRequest } from "../types.js";

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
  thinking?: { type: "disabled" } | { type: "adaptive"; display: "summarized" } | { type: "enabled"; budgetTokens: number };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

type ReasoningRequest = Pick<MessagesRequest, "thinking" | "output_config" | "reasoning_effort">;

function namedEffort(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || !RANK.includes(value.trim())) {
    throw new BridgeError(400, "invalid_reasoning", "Reasoning effort must be off, none, minimal, low, medium, high, xhigh or max.");
  }
  return value.trim();
}

function fixedBudget(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1024) {
    throw new BridgeError(400, "invalid_reasoning", "Enabled thinking requires an integer budget_tokens of at least 1024.");
  }
  return value;
}

function budgetFromLevel(level: string): number | undefined {
  const match = /^budget:(\d+)$/.exec(level);
  return match ? fixedBudget(Number(match[1])) : undefined;
}

/** A named effort or an exact budget:<tokens> key, never an inferred effort. */
export function droidReasoningLevel(request: ReasoningRequest): string | undefined {
  const thinking = object(request.thinking);
  const output = namedEffort(object(request.output_config)?.effort);
  const root = namedEffort(request.reasoning_effort);
  if (output !== undefined && root !== undefined && output !== root) {
    throw new BridgeError(400, "conflicting_reasoning", "output_config.effort and reasoning_effort disagree.");
  }
  // Sonnet's off encoding can retain a valid output_config.effort=high.
  if (thinking?.type === "between_tools" || thinking?.type === "disabled") return "off";
  // GPT-over-Messages includes a fallback token budget alongside its named effort.
  const effort = output ?? root;
  if (effort !== undefined) return effort;
  if (thinking?.type === "enabled") return `budget:${fixedBudget(thinking.budget_tokens)}`;
  return undefined;
}

/**
 * Droid 1.1.0's default Anthropic thinking budgets per selector level. High and
 * xhigh share 24576 and max sends no thinking at all, so neither xhigh nor max
 * can be recovered from a budget.
 */
const BUDGET_EFFORTS: ReadonlyArray<readonly [number, string]> = [[4096, "low"], [12288, "medium"], [24576, "high"]];

/** Nearest Droid default level by token ratio; ties pick the lower level. */
export function effortForBudget(tokens: number): string {
  const distance = (budget: number) => Math.abs(Math.log(tokens / budget));
  return BUDGET_EFFORTS.reduce((best, entry) => distance(entry[0]) < distance(best[0]) ? entry : best)[1];
}

/** Non-Claude native APIs take named efforts only, so an exact budget maps to the nearest level. */
export function droidReasoningEffort(request: ReasoningRequest): string | undefined {
  const level = droidReasoningLevel(request);
  const budget = level === undefined ? undefined : budgetFromLevel(level);
  return budget === undefined ? level : effortForBudget(budget);
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
  const budgetTokens = budgetFromLevel(level);
  if (budgetTokens !== undefined) return { thinking: { type: "enabled", budgetTokens } };
  if (level === "off" || level === "none") return { thinking: { type: "disabled" } };
  if (level === "minimal") return { effort: "low", thinking: { type: "adaptive", display: "summarized" } };
  if (CLAUDE_EFFORT.has(level)) return { effort: level as ClaudeReasoningOptions["effort"], thinking: { type: "adaptive", display: "summarized" } };
  return undefined;
}

export function claudeReasoningKey(request: ReasoningRequest): string {
  return JSON.stringify(claudeReasoningOptions(droidReasoningLevel(request)) ?? null);
}

/** Synthetic hash input only; never send this reconstructed selection upstream. */
export function requestAtReasoningLevel(request: MessagesRequest, level: string): MessagesRequest {
  const output = { ...(object(request.output_config) ?? {}) };
  delete output.effort;
  const budgetTokens = budgetFromLevel(level);
  return {
    ...request,
    thinking: budgetTokens !== undefined ? { type: "enabled", budget_tokens: budgetTokens } : undefined,
    reasoning_effort: budgetTokens === undefined ? level : undefined,
    output_config: Object.keys(output).length ? output as MessagesRequest["output_config"] : undefined,
  };
}

/** Remove known reasoning encodings for comparison with an unselected session. */
export function requestWithoutReasoningLevel(request: MessagesRequest): MessagesRequest {
  const output = { ...(object(request.output_config) ?? {}) };
  delete output.effort;
  const type = object(request.thinking)?.type;
  const thinking = type === "between_tools" ? { type: "adaptive", display: "summarized" }
    : type === "enabled" || type === "disabled" ? undefined : request.thinking;
  return {
    ...request,
    thinking: thinking as MessagesRequest["thinking"],
    reasoning_effort: undefined,
    output_config: Object.keys(output).length ? output as MessagesRequest["output_config"] : undefined,
  };
}
