import { describe, expect, it } from "vitest";
import { cursorMenuFromCatalog } from "../../src/runtime/cursor/catalog.js";
import { cursorLiveCatalogFixture } from "../../src/runtime/cursor/fixture.js";
import { applyCursorReasoning, claudeReasoningOptions, droidReasoningLevel, mapReasoningValue } from "../../src/runtime/reasoning.js";
import type { MessagesRequest } from "../../src/types.js";

const grok = cursorMenuFromCatalog(cursorLiveCatalogFixture, "default")[1]!.cursor!;
const composer = cursorMenuFromCatalog(cursorLiveCatalogFixture, "default")[0]!.cursor!;
const request = (extra: Partial<MessagesRequest> = {}): MessagesRequest => ({ model: "cursor:grok-4.7", max_tokens: 16, messages: [{ role: "user", content: "ping" }], ...extra });

describe("Droid reasoning levels", () => {
  it("reads the captured selector fields and treats a missing field as no level", () => {
    expect(droidReasoningLevel(request())).toBeUndefined();
    expect(droidReasoningLevel(request({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } }))).toBe("high");
    expect(droidReasoningLevel(request({ thinking: { type: "between_tools" }, output_config: { effort: "high" } }))).toBe("off");
    expect(droidReasoningLevel(request({ output_config: { effort: "max" } }))).toBe("max");
    expect(droidReasoningLevel(request({ thinking: { type: "enabled", budget_tokens: 1024 } }))).toBeUndefined();
  });

  it("maps Grok effort from the catalog and leaves Composer, fast, and context pinned", () => {
    const table = ["off", "low", "medium", "high", "xhigh", "max"].map((level) => [level, applyCursorReasoning(grok.params, grok.parameters, level).find((param) => param.id === "reasoning_effort")?.value]);
    expect(table).toEqual([
      ["off", "low"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "xhigh"],
    ]);
    expect(applyCursorReasoning(grok.params, grok.parameters, undefined)).toEqual(grok.params);
    for (const level of ["off", "low", "high", "max"]) {
      const params = applyCursorReasoning(grok.params, grok.parameters, level);
      expect(params.find((param) => param.id === "fast")?.value).toBe("false");
      expect(params.find((param) => param.id === "context")?.value).toBe("256k");
      expect(applyCursorReasoning(composer.params, composer.parameters, level)).toEqual([{ id: "fast", value: "false" }]);
    }
  });

  it("follows a catalog that gains an effort parameter later", () => {
    const withEffort = { id: "fast-model", params: [{ id: "fast", value: "false" }, { id: "effort", value: "high" }], parameters: [{ id: "effort", values: [{ value: "low" }, { value: "high" }, { value: "max" }] }] };
    expect(applyCursorReasoning(withEffort.params, withEffort.parameters, "medium").find((param) => param.id === "effort")?.value).toBe("low");
    expect(applyCursorReasoning(withEffort.params, withEffort.parameters, "xhigh").find((param) => param.id === "effort")?.value).toBe("high");
    expect(mapReasoningValue("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(applyCursorReasoning(composer.params, [{ id: "effort", values: [{ value: "low" }, { value: "high" }] }], "low")).toEqual(composer.params);
  });

  it("maps Claude options and leaves a request without a level untouched", () => {
    expect(claudeReasoningOptions(undefined)).toBeUndefined();
    expect(claudeReasoningOptions("off")).toEqual({ thinking: { type: "disabled" } });
    expect(claudeReasoningOptions("low")).toEqual({ effort: "low", thinking: { type: "adaptive", display: "summarized" } });
    expect(claudeReasoningOptions("high")).toEqual({ effort: "high", thinking: { type: "adaptive", display: "summarized" } });
    expect(claudeReasoningOptions("xhigh")?.effort).toBe("xhigh");
    expect(claudeReasoningOptions("max")?.effort).toBe("max");
    expect(claudeReasoningOptions("minimal")).toEqual({ effort: "low", thinking: { type: "adaptive", display: "summarized" } });
    expect(claudeReasoningOptions("mystery")).toBeUndefined();
  });
});
