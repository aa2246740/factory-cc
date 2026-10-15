import { BridgeError } from "../types.js";

export function assertBodySize(bytes: number, max: number): void {
  if (bytes > max) {
    throw new BridgeError(413, "request_too_large", `request body exceeds ${max} bytes`);
  }
}

export function clampString(value: string, max = 100_000): string {
  return value.length > max ? value.slice(0, max) : value;
}
