import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Usage } from "../types.js";

export interface UsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export function emptyUsage(): UsageSnapshot {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

export function cacheHitRatio(usage: UsageSnapshot): number {
  const denom =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  if (denom <= 0) return 0;
  return usage.cache_read_input_tokens / denom;
}

export function subtractUsage(current: UsageSnapshot, previous: UsageSnapshot): UsageSnapshot {
  return {
    input_tokens: Math.max(0, current.input_tokens - previous.input_tokens),
    output_tokens: Math.max(0, current.output_tokens - previous.output_tokens),
    cache_creation_input_tokens: Math.max(
      0,
      current.cache_creation_input_tokens - previous.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: Math.max(0, current.cache_read_input_tokens - previous.cache_read_input_tokens),
  };
}

export function addUsage(left: UsageSnapshot, right: UsageSnapshot): UsageSnapshot {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    cache_creation_input_tokens: left.cache_creation_input_tokens + right.cache_creation_input_tokens,
    cache_read_input_tokens: left.cache_read_input_tokens + right.cache_read_input_tokens,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function extractUsage(message: Record<string, unknown>): UsageSnapshot | undefined {
  const usage = message.usage as Record<string, unknown> | undefined;
  const modelUsage = message.modelUsage as Record<string, Record<string, unknown>> | undefined;
  if (modelUsage && typeof modelUsage === "object") {
    const summed = emptyUsage();
    let saw = false;
    for (const row of Object.values(modelUsage)) {
      if (!row || typeof row !== "object") continue;
      saw = true;
      summed.input_tokens += num(row.inputTokens ?? row.input_tokens);
      summed.output_tokens += num(row.outputTokens ?? row.output_tokens);
      summed.cache_creation_input_tokens += num(row.cacheCreationInputTokens ?? row.cache_creation_input_tokens);
      summed.cache_read_input_tokens += num(row.cacheReadInputTokens ?? row.cache_read_input_tokens);
    }
    if (saw) return summed;
  }
  if (usage && typeof usage === "object") {
    return {
      input_tokens: num(usage.input_tokens ?? usage.inputTokens),
      output_tokens: num(usage.output_tokens ?? usage.outputTokens),
      cache_creation_input_tokens: num(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens),
      cache_read_input_tokens: num(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens),
    };
  }
  const event = message.event as { usage?: Record<string, unknown>; message?: { usage?: Record<string, unknown> } } | undefined;
  const nested = event?.usage ?? event?.message?.usage;
  if (nested) {
    return {
      input_tokens: num(nested.input_tokens),
      output_tokens: num(nested.output_tokens),
      cache_creation_input_tokens: num(nested.cache_creation_input_tokens),
      cache_read_input_tokens: num(nested.cache_read_input_tokens),
    };
  }
  return undefined;
}

export function toResponseUsage(snapshot: UsageSnapshot, estimated = false): Usage {
  return {
    input_tokens: snapshot.input_tokens,
    output_tokens: snapshot.output_tokens,
    cache_creation_input_tokens: snapshot.cache_creation_input_tokens,
    cache_read_input_tokens: snapshot.cache_read_input_tokens,
    estimated,
  };
}

export function writeUsageLine(
  file: string,
  row: UsageSnapshot & { sessionId: string; model?: string; provider?: string; role?: string },
): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${JSON.stringify({
      at: new Date().toISOString(),
      ...row,
      cache_hit_ratio: Number(cacheHitRatio(row).toFixed(4)),
    })}\n`,
  );
}

export function summarizeUsage(rows: UsageSnapshot[]): UsageSnapshot & { cache_hit_ratio: number; requests: number } {
  const total = rows.reduce(addUsage, emptyUsage());
  return { ...total, cache_hit_ratio: Number(cacheHitRatio(total).toFixed(4)), requests: rows.length };
}
