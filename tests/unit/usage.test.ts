import { describe, expect, it } from "vitest";
import { cacheHitRatio, extractUsage, subtractUsage, summarizeUsage } from "../../src/runtime/usage.js";

describe("usage / cache", () => {
  it("reads cache fields from SDK result and modelUsage", () => {
    const fromUsage = extractUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 40,
        cache_read_input_tokens: 60,
      },
    });
    expect(fromUsage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: 60,
    });
    expect(cacheHitRatio(fromUsage!)).toBeCloseTo(60 / 200);

    const fromModels = extractUsage({
      modelUsage: {
        "MiniMax-M2.5": {
          inputTokens: 10,
          outputTokens: 4,
          cacheCreationInputTokens: 2,
          cacheReadInputTokens: 8,
        },
      },
    });
    expect(fromModels?.cache_read_input_tokens).toBe(8);
  });

  it("differences cumulative totals into per-request rows", () => {
    const delta = subtractUsage(
      { input_tokens: 30, output_tokens: 9, cache_creation_input_tokens: 5, cache_read_input_tokens: 20 },
      { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 4 },
    );
    expect(delta).toEqual({
      input_tokens: 20,
      output_tokens: 6,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 16,
    });
    const summary = summarizeUsage([delta, delta]);
    expect(summary.requests).toBe(2);
    expect(summary.cache_read_input_tokens).toBe(32);
  });
});
