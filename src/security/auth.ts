import { timingSafeEqual } from "node:crypto";
import { BridgeError } from "../types.js";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }
  return timingSafeEqual(left, right);
}

export function extractClientToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const apiKey = header(headers, "x-api-key");
  if (apiKey) return apiKey;
  const auth = header(headers, "authorization");
  if (!auth) return undefined;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

export function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export function requireClientToken(
  headers: Record<string, string | string[] | undefined>,
  expected: string,
): void {
  const got = extractClientToken(headers);
  if (!got || !safeEqual(got, expected)) {
    throw new BridgeError(401, "authentication_error", "invalid bridge client token");
  }
}

export function requireAdminToken(
  headers: Record<string, string | string[] | undefined>,
  expected: string,
): void {
  const got = header(headers, "x-bridge-admin-token") ?? extractClientToken(headers);
  if (!got || !safeEqual(got, expected)) {
    throw new BridgeError(401, "authentication_error", "invalid bridge admin token");
  }
}
