import { BridgeError } from "../types.js";

/** These are contracts of this adapter, not a claim about Factory's hosted models. */
export const nativeOutputCapabilities = Object.freeze({
  text: true,
  toolCalls: true,
  tokenLogprobs: false,
  constrainedJson: false,
  generatedImages: false,
  generatedAudio: false,
  factoryHostTools: "delegated-to-factory" as const,
});

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/**
 * The native agent interface cannot honor provider completion output contracts.
 * Refuse those requests before session creation rather than returning ordinary
 * text that a classifier may mistake for a successful specialized completion.
 * Image input and advertised Factory image tools are deliberately independent:
 * those tools still execute in Factory with its own authorized configuration.
 */
export function assertNativeOutputContract(request: Record<string, unknown>): void {
  const unsupported: string[] = [];
  if (request.logprobs !== undefined && request.logprobs !== null && request.logprobs !== false) unsupported.push("logprobs");
  if (request.top_logprobs !== undefined && request.top_logprobs !== null && request.top_logprobs !== 0) unsupported.push("top_logprobs");
  const responseFormat = object(request.response_format);
  if (request.response_format != null && (responseFormat?.type !== "text" || Object.keys(responseFormat).some((key) => key !== "type"))) {
    unsupported.push("response_format");
  }
  if (object(request.output_config)?.format != null) unsupported.push("output_config.format");
  if (request.output_format != null) unsupported.push("output_format");
  if (request.modalities != null && (!Array.isArray(request.modalities)
      || request.modalities.some((modality) => modality !== "text"))) unsupported.push("modalities");
  if (request.audio != null) unsupported.push("audio");
  if (unsupported.length) {
    throw new BridgeError(422, "unsupported_output_contract",
      `The native Claude Code bridge cannot honor ${unsupported.join(", ")}. Use a separately authorized provider route for token probabilities, constrained JSON, or generated media; this request was rejected before native execution.`);
  }
}
