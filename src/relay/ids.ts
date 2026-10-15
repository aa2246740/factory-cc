import { randomBytes, randomUUID } from "node:crypto";

export function toolUseId(): string {
  return `toolu_${randomBytes(12).toString("hex")}`;
}

export function sessionId(): string {
  return `sess_${randomUUID()}`;
}

export function requestId(): string {
  return `req_${randomUUID()}`;
}

export function nonce(): string {
  return randomBytes(16).toString("hex");
}
