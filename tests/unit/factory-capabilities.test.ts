import { describe, expect, it } from "vitest";
import { assertNativeOutputContract, nativeOutputCapabilities } from "../../src/runtime/factory-capabilities.js";

describe("native output capability boundaries", () => {
  it.each([
    { logprobs: true }, { top_logprobs: 2 },
    { response_format: { type: "json_schema", json_schema: { strict: true } } },
    { response_format: { type: "json_object" } },
    { response_format: { type: "text", schema: {} } },
    { output_config: { format: { type: "json_schema", schema: {} } } },
    { output_format: { type: "json_schema" } },
    { modalities: ["text", "image"] }, { modalities: ["audio"] },
    { audio: { voice: "alloy", format: "wav" } },
  ])("refuses specialized output before inference: %j", (request) => {
    expect(() => assertNativeOutputContract(request)).toThrow(/cannot honor/);
    try { assertNativeOutputContract(request); } catch (error) {
      expect(error).toMatchObject({ status: 422, code: "unsupported_output_contract" });
    }
  });

  it("accepts ordinary text defaults without confusing input images or host image tools with generated output", () => {
    expect(() => assertNativeOutputContract({
      logprobs: false, top_logprobs: 0, response_format: { type: "text" }, modalities: ["text"],
      output_config: { effort: "high" },
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "fixture" } }] }],
      tools: [{ name: "GenerateImage", input_schema: { type: "object" } }],
    })).not.toThrow();
    expect(nativeOutputCapabilities.factoryHostTools).toBe("delegated-to-factory");
    expect(nativeOutputCapabilities.generatedImages).toBe(false);
  });
});
