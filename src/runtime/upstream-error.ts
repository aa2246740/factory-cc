import { BridgeError } from "../types.js";

/** Translate only explicit upstream status/type evidence, never a bare number in prose. */
export function upstreamError(error: unknown): BridgeError | undefined {
  if (error instanceof BridgeError && ["rate_limit_error", "overloaded_error"].includes(error.code)) return error;
  const source = error && typeof error === "object" ? error : undefined;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const status = source && "status" in source && typeof source.status === "number" ? source.status : undefined;
  const limited = status === 429 || /rate_limit_error|\btoo many requests\b|\bcredentials?\b.{0,80}\bcooling down\b|(?:API Error|HTTP|status|rejected)[^\n]{0,40}\b429\b/i.test(message);
  const overloaded = status === 529 || /overloaded_error|(?:API Error|HTTP|status|rejected)[^\n]{0,40}\b529\b/i.test(message);
  if (!limited && !overloaded) return undefined;
  let retryAfter: string | undefined;
  const headers = source && "headers" in source ? source.headers : undefined;
  if (headers instanceof Headers) retryAfter = headers.get("retry-after") ?? undefined;
  else if (headers && typeof headers === "object" && "retry-after" in headers && typeof headers["retry-after"] === "string") retryAfter = headers["retry-after"];
  const match = /retry[-_ ]after["'\s:=]+(\d+(?:\.\d+)?)/i.exec(message);
  let seconds: number | undefined;
  if (retryAfter) {
    const parsed = Number(retryAfter);
    seconds = Number.isFinite(parsed) ? parsed : (Date.parse(retryAfter) - Date.now()) / 1000;
  } else if (match) seconds = Number(match[1]);
  return new BridgeError(limited ? 429 : 529, limited ? "rate_limit_error" : "overloaded_error",
    limited ? "The upstream model is rate limited. Retry after its cooldown." : "The upstream model is overloaded. Retry later.",
    seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 ? { retry_after: Math.max(1, Math.ceil(seconds)) } : undefined);
}
