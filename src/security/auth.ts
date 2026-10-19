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

function bearerToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const auth = header(headers, "authorization");
  if (!auth) return undefined;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

/** Admin routes accept the admin token only. `x-api-key` is the client credential and is ignored here. */
export function requireAdminToken(
  headers: Record<string, string | string[] | undefined>,
  expected: string,
): void {
  const got = header(headers, "x-bridge-admin-token") ?? bearerToken(headers);
  if (!got || !safeEqual(got, expected)) {
    throw new BridgeError(401, "authentication_error", "invalid bridge admin token");
  }
}

/** Host events may be sent by the hook process or by an administrator. `x-api-key` is still ignored. */
export function requireAdminOrHookToken(
  headers: Record<string, string | string[] | undefined>,
  adminToken: string,
  hookToken: string,
): void {
  const got = header(headers, "x-bridge-admin-token") ?? bearerToken(headers);
  const adminOk = got !== undefined && safeEqual(got, adminToken);
  const hookOk = got !== undefined && safeEqual(got, hookToken);
  if (!adminOk && !hookOk) {
    throw new BridgeError(401, "authentication_error", "invalid bridge admin token");
  }
}
