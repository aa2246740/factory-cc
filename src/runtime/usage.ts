import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appendLogLine } from "../logging.js";
import type { Usage } from "../types.js";

export interface UsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

const COUNTERS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const;
type Counter = (typeof COUNTERS)[number];
type PartialUsage = Partial<UsageSnapshot>;

export interface LedgerUsage extends UsageSnapshot {
  /** Provider-reported counters, never independently measured tokens. */
  status: "reported" | "unknown";
  coverage: "complete" | "partial" | "unknown";
  knownFields: Counter[];
  scope: "provider_messages";
  estimated: boolean;
  /** Newly observed provider message IDs; excludes unexposed auxiliary requests. */
  modelRequests: number;
}

export interface BillingSnapshot extends UsageSnapshot {
  [key: string]: unknown;
  status: "reported";
  scope: "sdk_session_cumulative";
  estimated: true;
  coverage: "complete" | "partial";
  knownFields: Counter[];
  models: Record<string, PartialUsage>;
  sdkSessionId?: string;
  totalCostUSD?: number;
}

/** Only whitelisted IDs and numeric usage are retained; prompts, content and headers never enter this record. */
export interface UsageLedgerEvent {
  source: "provider_message" | "sdk_result";
  eventType: string;
  status: "reported" | "unknown";
  sdkSessionId?: string;
  messageId?: string;
  requestId?: string;
  parentToolUseId?: string;
  model?: string;
  usage?: PartialUsage;
  mainAgentTurnUsage?: PartialUsage;
  modelUsage?: Record<string, PartialUsage>;
  totalCostUSD?: number;
  billingScope?: "sdk_session_cumulative";
  reason?: "missing_message_id" | "missing_stream_start" | "no_numeric_usage";
}

interface ProviderMessage {
  usage: PartialUsage;
}

/**
 * Keep two distinct ledgers:
 * - Messages usage is cumulative within ONE provider message ID. Partial stream
 *   deltas merge with its start, and assistant blocks with the same ID dedupe.
 * - SDK result.modelUsage is a running SDK session/query snapshot, including
 *   subagents and compaction. It may include resumed history or reset on /clear.
 *   Never add it to Messages counters or sum snapshots across results.
 *
 * SDK 0.3.300's SDKResultSuccess/SDKResultError document result.usage separately
 * as main-agent, per-turn usage. It is retained as evidence, not used as fallback
 * for unidentified provider messages.
 */
export class UsageLedger {
  private readonly messages = new Map<string, ProviderMessage>();
  private readonly streams = new Map<string, { key: string; messageId: string; model?: string }>();
  private billing?: BillingSnapshot;
  private drained = emptyUsage();
  private drainedRequests = 0;
  private readonly dirty = new Set<string>();

  ingest(message: Record<string, unknown>): UsageLedgerEvent | undefined {
    const sdkSessionId = label(message.session_id);
    const parentToolUseId = label(message.parent_tool_use_id);
    const lane = JSON.stringify([sdkSessionId ?? null, parentToolUseId ?? null]);
    const identity = { sdkSessionId, parentToolUseId, requestId: label(message.request_id) };

    if (message.type === "result") {
      const modelUsage: Record<string, PartialUsage> = {};
      for (const [model, value] of Object.entries(record(message.modelUsage) ?? {})) {
        const usage = numericUsage(value);
        const name = label(model);
        if (name && Object.keys(usage).length) modelUsage[name] = usage;
      }
      const mainAgentTurnUsage = numericUsage(message.usage);
      const totalCostUSD = finiteNonnegative(message.total_cost_usd);
      // Missing/empty result usage is unknown, not evidence that the last
      // successful snapshot still describes this result (e.g. startup error).
      this.billing = undefined;
      if (Object.keys(modelUsage).length) {
        const knownFields = COUNTERS.filter((key) => Object.values(modelUsage).every((usage) => usage[key] !== undefined));
        this.billing = {
          ...Object.values(modelUsage).reduce<UsageSnapshot>((sum, usage) => addUsage(sum, completeUsage(usage)), emptyUsage()),
          status: "reported", scope: "sdk_session_cumulative", estimated: true,
          coverage: knownFields.length === COUNTERS.length ? "complete" : "partial", knownFields,
          models: modelUsage, sdkSessionId, totalCostUSD,
        };
      }
      return {
        source: "sdk_result", eventType: `result:${label(message.subtype) ?? "unknown"}`, ...identity,
        status: Object.keys(modelUsage).length || Object.keys(mainAgentTurnUsage).length ? "reported" : "unknown",
        mainAgentTurnUsage, modelUsage, totalCostUSD, billingScope: "sdk_session_cumulative",
      };
    }

    let rawUsage: unknown;
    let messageId: string | undefined;
    let model: string | undefined;
    let key: string | undefined;
    let eventType: string;
    let reason: UsageLedgerEvent["reason"];
    if (message.type === "assistant") {
      const assistant = record(message.message);
      rawUsage = assistant?.usage;
      if (!record(rawUsage)) return undefined;
      messageId = label(assistant?.id);
      model = label(assistant?.model);
      eventType = "assistant";
      if (messageId) key = JSON.stringify([lane, messageId]);
      else reason = "missing_message_id";
    } else if (message.type === "stream_event") {
      const event = record(message.event);
      eventType = `stream:${label(event?.type) ?? "unknown"}`;
      if (event?.type === "message_stop") {
        this.streams.delete(lane);
        return undefined;
      }
      if (event?.type === "message_start") {
        this.streams.delete(lane);
        const start = record(event.message);
        rawUsage = start?.usage;
        messageId = label(start?.id);
        model = label(start?.model);
        if (messageId) {
          key = JSON.stringify([lane, messageId]);
          this.streams.set(lane, { key, messageId, model });
        } else reason = "missing_message_id";
      } else if (event?.type === "message_delta") {
        rawUsage = event.usage;
        const stream = this.streams.get(lane);
        if (stream) ({ key, messageId, model } = stream);
        else reason = "missing_stream_start";
      } else return undefined;
    } else return undefined;

    const usage = numericUsage(rawUsage);
    const hasUsage = Object.keys(usage).length > 0;
    if (key && hasUsage) {
      const existing = this.messages.get(key);
      const merged = { ...existing?.usage };
      let changed = !existing;
      for (const counter of COUNTERS) {
        const value = usage[counter];
        // Counters are cumulative within a message. Later duplicate assistant
        // blocks may repeat an earlier snapshot; they must not undo usage.
        if (value !== undefined && (merged[counter] === undefined || value > merged[counter]!)) {
          merged[counter] = value;
          changed = true;
        }
      }
      this.messages.set(key, { usage: merged });
      if (changed) this.dirty.add(key);
    }
    return {
      source: "provider_message", eventType, ...identity, messageId, model, usage,
      status: key && hasUsage ? "reported" : "unknown",
      ...(reason || !hasUsage ? { reason: reason ?? "no_numeric_usage" } : {}),
    };
  }

  providerTotals(): UsageSnapshot {
    return [...this.messages.values()].reduce((sum, row) => addUsage(sum, completeUsage(row.usage)), emptyUsage());
  }

  billingSnapshot(): BillingSnapshot | undefined {
    return this.billing ? structuredClone(this.billing) : undefined;
  }

  /** Consume only newly observed provider usage since the previous HTTP reply. */
  drainTurnUsage(): LedgerUsage {
    const total = this.providerTotals();
    const knownFields = COUNTERS.filter((key) => this.dirty.size > 0
      && [...this.dirty].every((id) => this.messages.get(id)?.usage[key] !== undefined));
    const coverage = this.dirty.size === 0 ? "unknown" : knownFields.length === COUNTERS.length ? "complete" : "partial";
    const result: LedgerUsage = {
      ...subtractUsage(total, this.drained),
      status: this.dirty.size ? "reported" : "unknown",
      coverage, knownFields, scope: "provider_messages", estimated: coverage !== "complete",
      modelRequests: this.messages.size - this.drainedRequests,
    };
    this.drained = total;
    this.drainedRequests = this.messages.size;
    this.dirty.clear();
    return result;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function label(value: unknown): string | undefined {
  // Model IDs such as claude-sonnet-4-6 are identifiers, not secret-shaped
  // prose. Generic string redaction would collapse distinct Claude models.
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/.test(value)) return undefined;
  if (/^(?:sk-|fk-|ant-|Bearer)/i.test(value)) return undefined;
  return value;
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function numericUsage(value: unknown): PartialUsage {
  const source = record(value);
  if (!source) return {};
  const aliases = ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"];
  const usage: PartialUsage = {};
  COUNTERS.forEach((key, index) => {
    const n = finiteNonnegative(source[key] ?? source[aliases[index]!]);
    if (n !== undefined) usage[key] = n;
  });
  return usage;
}

function completeUsage(usage: PartialUsage): UsageSnapshot {
  return { ...emptyUsage(), ...usage };
}

export function writeUsageEvent(
  file: string,
  event: UsageLedgerEvent,
  context: { sessionId: string; provider?: string; model?: string; role?: string },
): void {
  mkdirSync(dirname(file), { recursive: true });
  appendLogLine(file, JSON.stringify({
    at: new Date().toISOString(),
    context: Object.fromEntries(Object.entries(context).map(([key, value]) => [key, label(value)])),
    ...event,
  }));
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

/** Read ONE usage payload. Do not difference heterogeneous payloads; use UsageLedger for event streams. */
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
  appendLogLine(
    file,
    JSON.stringify({
      at: new Date().toISOString(),
      ...row,
      cache_hit_ratio: Number(cacheHitRatio(row).toFixed(4)),
    }),
  );
}

export function summarizeUsage(rows: Array<UsageSnapshot | UsageLedgerEvent>): UsageSnapshot & {
  cache_hit_ratio: number | null;
  requests: number;
  requestCountKnown: boolean;
  status: "reported" | "unknown";
  source: "provider_messages" | "legacy_unscoped";
  coverage: "complete" | "partial" | "unknown";
  eventRows: number;
} {
  // Legacy JSONL mixed SDK cumulative snapshots and partial events. Its sums
  // remain readable for historical comparisons, but its rows are NOT requests
  // and neither the totals nor the derived cache ratio have a verified scope.
  const events = rows.filter((row): row is UsageLedgerEvent => "source" in row);
  if (events.length !== rows.length) {
    const total = rows.reduce<UsageSnapshot>((sum, row) => addUsage(sum, completeUsage(numericUsage(row))), emptyUsage());
    return { ...total, cache_hit_ratio: null, requests: 0,
      requestCountKnown: false, status: "unknown", source: "legacy_unscoped", coverage: "unknown", eventRows: rows.length };
  }
  const ledger = new UsageLedger();
  for (const event of events) {
    if (event.source !== "provider_message" || event.status !== "reported" || !event.messageId) continue;
    ledger.ingest({
      type: "assistant", session_id: event.sdkSessionId,
      parent_tool_use_id: event.parentToolUseId,
      message: { id: event.messageId, model: event.model, usage: event.usage },
    });
  }
  const usage = ledger.drainTurnUsage();
  const hasInput = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens > 0;
  return { ...ledger.providerTotals(), cache_hit_ratio: usage.coverage === "complete" && hasInput ? Number(cacheHitRatio(usage).toFixed(4)) : null,
    requests: usage.modelRequests, requestCountKnown: usage.status === "reported",
    status: usage.status, source: "provider_messages", coverage: usage.coverage, eventRows: rows.length };
}
