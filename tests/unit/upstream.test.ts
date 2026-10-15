import { describe, expect, it } from "vitest";
import { modelSlots, publicSelection, sdkEnv } from "../../src/upstream/providers.js";

describe("upstream selection helpers", () => {
  it("fills every Claude Code model slot with the same BYOK model", () => {
    const slots = modelSlots("MiniMax-M2.5");
    expect(slots.ANTHROPIC_MODEL).toBe("MiniMax-M2.5");
    expect(slots.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("MiniMax-M2.5");
    expect(slots.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("MiniMax-M2.5");
    expect(slots.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("MiniMax-M2.5");
    expect(slots.CLAUDE_CODE_SUBAGENT_MODEL).toBe("MiniMax-M2.5");
  });

  it("injects AUTH_TOKEN, empties API_KEY, and refuses a Bridge loop", () => {
    const previous = process.env.MINIMAXCN_API_KEY;
    process.env.MINIMAXCN_API_KEY = "test-minimax-token-not-real";
    const selection = {
      provider: {
        id: "minimax" as const,
        label: "test",
        baseUrl: "https://api.minimaxi.com/anthropic",
        model: "MiniMax-M2.5",
        tokenEnv: "MINIMAXCN_API_KEY",
        authHeader: "authorization" as const,
      },
      modelSlots: modelSlots("MiniMax-M2.5"),
    };
    const env = sdkEnv(selection, "127.0.0.1:18787");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.minimaxi.com/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-minimax-token-not-real");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.ANTHROPIC_MODEL).toBe("MiniMax-M2.5");
    expect(publicSelection(selection).tokenEnv).toBe("MINIMAXCN_API_KEY");
    expect(() => sdkEnv({
      ...selection,
      provider: { ...selection.provider, baseUrl: "http://127.0.0.1:18787" },
    }, "127.0.0.1:18787")).toThrow(/refusing/);
    if (previous === undefined) delete process.env.MINIMAXCN_API_KEY;
    else process.env.MINIMAXCN_API_KEY = previous;
  });
});
