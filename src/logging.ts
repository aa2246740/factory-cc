import { appendFileSync, chmodSync, closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { redactJson } from "./security/redact.js";

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

export const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Read per write so an operator (or a test) can lower it without rebuilding the logger. */
function logMaxBytes(): number {
  const configured = Number(process.env.BRIDGE_LOG_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.max(1, Math.floor(configured)) : DEFAULT_LOG_MAX_BYTES;
}

/** Bound a legacy archive too when an upgrade lowers the configured cap. */
function capArchive(file: string, maxBytes: number): void {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) return;
    const { size } = info;
    if (size <= maxBytes) return;
    const tail = Buffer.alloc(maxBytes);
    const bytes = readSync(fd, tail, 0, maxBytes, size - maxBytes);
    const content = tail.subarray(0, bytes);
    const firstNewline = content.indexOf(0x0a);
    const complete = firstNewline >= 0 ? content.subarray(firstNewline + 1) : Buffer.alloc(0);
    ftruncateSync(fd, 0);
    writeSync(fd, complete);
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Append one line to a bridge log. The file is private (0600; an older, more
 * open one is tightened) and is rotated to `<file>.1`, replacing the previous
 * generation, instead of growing past the size limit.
 */
export function appendLogLine(file: string, line: string, maxBytes = logMaxBytes()): void {
  let data = line.endsWith("\n") ? line : `${line}\n`;
  if (Buffer.byteLength(data) > maxBytes) {
    data = `${JSON.stringify({ event: "log_record_omitted", bytes: Buffer.byteLength(data) })}\n`;
    if (Buffer.byteLength(data) > maxBytes) data = maxBytes >= 3 ? "{}\n" : "\n";
  }
  try {
    const current = statSync(file);
    if ((current.mode & 0o077) !== 0) chmodSync(file, 0o600);
    if (current.size > 0 && current.size + Buffer.byteLength(data) > maxBytes) renameSync(file, `${file}.1`);
  } catch {
    // A missing file is created below. Log upkeep must never take the bridge down.
  }
  try { capArchive(`${file}.1`, maxBytes); } catch { /* Missing archive or read-only legacy archive. */ }
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
    if (level === "error") console.error(prefix, data ? redactJson(data) : "");
    else if (level === "warn") console.warn(prefix, data ? redactJson(data) : "");
    else console.log(prefix);
  };

  return {
    info: (event, data) => write("info", event, data),
    warn: (event, data) => write("warn", event, data),
    error: (event, data) => write("error", event, data),
  };
}
