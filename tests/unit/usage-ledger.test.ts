import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageLedger, emptyUsage, summarizeUsage, writeUsageEvent, type UsageLedgerEvent } from "../../src/runtime/usage.js";

const first = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0 };
const second = { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 };
const total = { input_tokens: 150, output_tokens: 30, cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000 };

function stream(event: Record<string, unknown>, parent: string | null = null): Record<string, unknown> {
  return { type: "stream_event", session_id: "sdk-session", parent_tool_use_id: parent, event };
}

function start(id: string, usage: object, parent: string | null = null) {
  return stream({ type: "message_start", message: { id, model: "test-model", usage } }, parent);
}

function delta(usage: object, parent: string | null = null) {
  return stream({ type: "message_delta", usage }, parent);
}

function assistant(id: string, usage: object, parent: string | null = null) {
  return { type: "assistant", session_id: "sdk-session", parent_tool_use_id: parent, message: { id, usage } };
}

function result(input: number, output: number, create: number, read: number) {
  return { type: "result", subtype: "success", session_id: "sdk-session", modelUsage: {
    "test-model": { inputTokens: input, outputTokens: output, cacheCreationInputTokens: create, cacheReadInputTokens: read },
  } };
}

describe("SDK usage ledger", () => {
  it.each(["partial", "full"] as const)("dedupes %s stream deltas, assistant blocks and final SDK cumulative usage", (kind) => {
    const ledger = new UsageLedger();
    const events = [
      start("m1", { ...first, output_tokens: 0 }),
      delta(kind === "partial" ? { output_tokens: first.output_tokens } : first),
      assistant("m1", first), assistant("m1", first),
      start("m2", { ...second, output_tokens: 0 }),
      delta(kind === "partial" ? { output_tokens: second.output_tokens } : second),
      assistant("m2", second),
      result(150, 30, 1000, 1000),
    ];
    const records = events.map((event) => ledger.ingest(event)!);
    expect(ledger.providerTotals()).toEqual(total);
    expect(ledger.billingSnapshot()).toMatchObject({ ...total, scope: "sdk_session_cumulative", estimated: true });
    expect(ledger.drainTurnUsage()).toMatchObject({ ...total, status: "reported", coverage: "complete", estimated: false, modelRequests: 2 });
    expect(summarizeUsage(records)).toMatchObject({ ...total, requests: 2, eventRows: 8, status: "reported" });
  });

  it("keeps streaming input turns and resumed/cleared cumulative billing snapshots separate", () => {
    const ledger = new UsageLedger();
    ledger.ingest(assistant("m1", first));
    // A resumed SDK session can already include substantial earlier usage.
    ledger.ingest(result(1100, 110, 9000, 12000));
    expect(ledger.drainTurnUsage()).toMatchObject({ ...first, modelRequests: 1 });
    ledger.ingest(assistant("m2", second));
    ledger.ingest(result(1150, 130, 9000, 13000));
    expect(ledger.drainTurnUsage()).toMatchObject({ ...second, modelRequests: 1 });
    expect(ledger.billingSnapshot()).toMatchObject({ input_tokens: 1150, output_tokens: 130 });
    // /clear and startup-error snapshots can reset: store the latest, not a positive delta.
    ledger.ingest(result(0, 0, 0, 0));
    expect(ledger.billingSnapshot()).toMatchObject(emptyUsage());
    expect(ledger.providerTotals()).toEqual(total);
    expect(ledger.drainTurnUsage()).toMatchObject({ ...emptyUsage(), status: "unknown", estimated: true });
    ledger.ingest({ type: "result", subtype: "error_during_execution", modelUsage: {} });
    expect(ledger.billingSnapshot()).toBeUndefined();
  });

  it("does not treat per-turn main-agent SDK usage as provider messages or session billing", () => {
    const ledger = new UsageLedger();
    const event = ledger.ingest({ type: "result", usage: first });
    expect(event).toMatchObject({ source: "sdk_result", mainAgentTurnUsage: first, status: "reported" });
    expect(ledger.billingSnapshot()).toBeUndefined();
    expect(ledger.providerTotals()).toEqual(emptyUsage());
    expect(ledger.drainTurnUsage()).toMatchObject({ status: "unknown", coverage: "unknown", estimated: true });
  });

  it("attributes interleaved main and subagent streams to their own message IDs", () => {
    const ledger = new UsageLedger();
    ledger.ingest(start("main", { ...first, output_tokens: 0 }));
    ledger.ingest(start("child", { ...second, output_tokens: 0 }, "task-1"));
    ledger.ingest(delta({ output_tokens: 20 }, "task-1"));
    ledger.ingest(delta({ output_tokens: 10 }));
    ledger.ingest(assistant("child", second, "task-1"));
    expect(ledger.providerTotals()).toEqual(total);
  });

  it("does not reset known cache/input fields when a delta omits or nulls them", () => {
    const ledger = new UsageLedger();
    ledger.ingest(start("m", { ...first, output_tokens: 0 }));
    ledger.ingest(delta({ output_tokens: 5, input_tokens: null, cache_creation_input_tokens: null }));
    ledger.ingest(delta({ output_tokens: 10 }));
    // SDK assistant block can repeat an earlier usage snapshot.
    ledger.ingest(assistant("m", { ...first, output_tokens: 0 }));
    expect(ledger.providerTotals()).toEqual(first);
  });

  it("marks absent cache fields unknown instead of claiming zero cache misses", () => {
    const ledger = new UsageLedger();
    const record = ledger.ingest(assistant("m", { input_tokens: 100, output_tokens: 10 }))!;
    expect(ledger.drainTurnUsage()).toMatchObject({
      status: "reported", coverage: "partial", estimated: true,
      knownFields: ["input_tokens", "output_tokens"],
    });
    expect(summarizeUsage([record])).toMatchObject({ cache_hit_ratio: null, coverage: "partial" });
  });

  it("refuses to attribute orphan deltas or missing message IDs to a prior stream", () => {
    const ledger = new UsageLedger();
    expect(ledger.ingest(delta({ output_tokens: 10 }))).toMatchObject({ status: "unknown", reason: "missing_stream_start" });
    ledger.ingest(start("m", first));
    ledger.ingest(stream({ type: "message_stop" }));
    expect(ledger.ingest(delta({ output_tokens: 100 }))).toMatchObject({ status: "unknown" });
    expect(ledger.ingest({ type: "assistant", message: { usage: second } })).toMatchObject({ reason: "missing_message_id" });
    expect(ledger.providerTotals()).toEqual(first);
  });

  it("rejects invalid counter values and records missing usage as unknown", () => {
    const ledger = new UsageLedger();
    const event = ledger.ingest(assistant("m", { input_tokens: -1, output_tokens: NaN, cache_read_input_tokens: Infinity }));
    expect(event).toMatchObject({ status: "unknown", usage: {}, reason: "no_numeric_usage" });
    expect(ledger.providerTotals()).toEqual(emptyUsage());
  });

  it("retains SDK billing by model without exposing raw prompt or credential fields", () => {
    const ledger = new UsageLedger();
    const event = ledger.ingest({
      ...result(150, 30, 1000, 1000), total_cost_usd: 0.123,
      usage: { ...first, authorization: "PRIVATE_AUTH_VALUE" },
      content: "PRIVATE_PROMPT", apiKey: "PRIVATE_KEY_VALUE",
    })!;
    const dir = mkdtempSync(join(tmpdir(), "usage-evidence-"));
    try {
      const file = join(dir, "usage.jsonl");
      writeUsageEvent(file, event, { sessionId: "bridge-session", model: "test-model" });
      const raw = readFileSync(file, "utf8");
      expect(raw).not.toMatch(/PRIVATE_|authorization|apiKey|content/);
      const saved = JSON.parse(raw) as UsageLedgerEvent;
      expect(saved.modelUsage?.["test-model"]).toEqual(total);
      expect(saved.mainAgentTurnUsage).toEqual(first);
      expect(saved.totalCostUSD).toBe(0.123);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps distinct Claude model identifiers in the billing snapshot", () => {
    const ledger = new UsageLedger();
    ledger.ingest({ type: "result", modelUsage: {
      "claude-sonnet-4-6": { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 80, cacheCreationInputTokens: 0 },
      "claude-opus-4-6": { inputTokens: 20, outputTokens: 3, cacheReadInputTokens: 40, cacheCreationInputTokens: 5 },
    } });
    expect(Object.keys(ledger.billingSnapshot()!.models)).toEqual(["claude-sonnet-4-6", "claude-opus-4-6"]);
    expect(ledger.billingSnapshot()).toMatchObject({ input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 120 });
  });
});
