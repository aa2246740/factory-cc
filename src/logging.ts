import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactJson } from "./security/redact.js";

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
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
    appendFileSync(file, `${line}\n`);
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
