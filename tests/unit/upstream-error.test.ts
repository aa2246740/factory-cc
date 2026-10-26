import { expect, it } from "vitest";
import { upstreamError } from "../../src/runtime/upstream-error.js";

it.each([
  ["API Error: Request rejected (429) · All credentials for model test are cooling down (rate_limit_error)", 429, "rate_limit_error"],
  ["API Error: 529 overloaded_error", 529, "overloaded_error"],
  ["rate_limit_error retry-after: 12", 429, "rate_limit_error"],
])("maps explicit upstream error %s", (message, status, code) => {
  expect(upstreamError(new Error(message))).toMatchObject({ status, code });
});
it("preserves a numeric Retry-After header and omits private upstream prose", () => {
  const error = Object.assign(new Error("private upstream account detail"), { status: 429, headers: new Headers({ "retry-after": "3" }) });
  expect(upstreamError(error)).toMatchObject({ status: 429, extra: { retry_after: 3 } });
  expect(upstreamError(error)!.message).not.toContain("private");
});
it("does not treat an arbitrary number in a user message as a provider status", () => {
  expect(upstreamError(new Error("The calculation returned 429 items"))).toBeUndefined();
});
