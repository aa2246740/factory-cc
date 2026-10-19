import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactJson } from "./security/redact.js";

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

export const DEFAULT_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** Read per write so an operator (or a test) can lower it without rebuilding the logger. */
function logMaxBytes(): number {
  const configured = Number(process.env.BRIDGE_LOG_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LOG_MAX_BYTES;
}

/**
 * Append one line to a bridge log. The file is private (0600; an older, more
 * open one is tightened) and is rotated to `<file>.1`, replacing the previous
 * generation, instead of growing past the size limit.
 */
export function appendLogLine(file: string, line: string): void {
  const data = line.endsWith("\n") ? line : `${line}\n`;
  try {
    const current = statSync(file);
    if ((current.mode & 0o077) !== 0) chmodSync(file, 0o600);
    if (current.size > 0 && current.size + Buffer.byteLength(data) > logMaxBytes()) renameSync(file, `${file}.1`);
  } catch {
    // A missing file is created below. Log upkeep must never take the bridge down.
  }
  appendFileSync(file, data, { mode: 0o600 });
}

export function createLogger(logDir: string): Logger {
  mkdirSync(logDir, { recursive: true });
  const file = join(logDir, "bridge.jsonl");

  const write = (level: string, event: string, data?: Record<string, unknown>) => {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level,
      event,
      data: data ? redactJson(data) : undefined,
    });
    appendLogLine(file, line);
    const prefix = `[relay-bridge ${level}] ${event}`;
    if (level === "error") console.error(prefix, data ?? "");
    else if (level === "warn") console.warn(prefix, data ?? "");
    else console.log(prefix);
  };

  return {
    info: (event, data) => write("info", event, data),
    warn: (event, data) => write("warn", event, data),
    error: (event, data) => write("error", event, data),
  };
}
