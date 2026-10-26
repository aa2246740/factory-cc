import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOG_MAX_BYTES, appendLogLine, createLogger } from "../../src/logging.js";

const directories: string[] = [];
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-logging-"));
  directories.push(dir);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const mode = (path: string) => statSync(path).mode & 0o777;

describe("bridge log files", () => {
  it("are created private and an older, more open file is tightened", () => {
    const logger = createLogger(dir);
    logger.info("first");
    expect(mode(join(dir, "bridge.jsonl"))).toBe(0o600);

    const old = join(dir, "requests.jsonl");
    writeFileSync(old, "earlier line\n", { mode: 0o644 });
    chmodSync(old, 0o644);
    appendLogLine(old, "next line");
    expect(mode(old)).toBe(0o600);
    expect(readFileSync(old, "utf8")).toBe("earlier line\nnext line\n");
  });

  it("default to a 10 MB limit and do not rotate below it", () => {
    expect(DEFAULT_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    const file = join(dir, "turns.jsonl");
    for (let line = 0; line < 50; line += 1) appendLogLine(file, `line ${line}`);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(50);
    expect(() => statSync(`${file}.1`)).toThrow();
  });

  it("rotate to .1 before growing past the limit, keeping one private generation", () => {
    vi.stubEnv("BRIDGE_LOG_MAX_BYTES", "100");
    const file = join(dir, "bridge.jsonl");
    const written: string[] = [];
    for (let line = 0; line < 12; line += 1) {
      const text = `entry-${String(line).padStart(2, "0")}-${"x".repeat(20)}`;
      written.push(text);
      appendLogLine(file, text);
      expect(statSync(file).size).toBeLessThanOrEqual(100);
    }
    const current = readFileSync(file, "utf8").trim().split("\n");
    const previous = readFileSync(`${file}.1`, "utf8").trim().split("\n");
    expect(current.at(-1)).toBe(written.at(-1));
    // Only one generation survives, and it is the one immediately before the current file.
    expect([...previous, ...current]).toEqual(written.slice(written.length - previous.length - current.length));
    expect(previous.length).toBeGreaterThan(0);
    expect(mode(`${file}.1`)).toBe(0o600);
    expect(mode(file)).toBe(0o600);
  });

  it("rotate through the logger and replace an oversized record with a bounded marker", () => {
    vi.stubEnv("BRIDGE_LOG_MAX_BYTES", "120");
    const logger = createLogger(dir);
    for (let index = 0; index < 6; index += 1) logger.info("event", { index });
    expect(statSync(join(dir, "bridge.jsonl.1")).size).toBeGreaterThan(0);
    logger.info("huge", { note: "y".repeat(500) });
    expect(readFileSync(join(dir, "bridge.jsonl"), "utf8")).toContain("log_record_omitted");
    expect(statSync(join(dir, "bridge.jsonl")).size).toBeLessThanOrEqual(120);
  });

  it("ignores a nonsensical limit override", () => {
    vi.stubEnv("BRIDGE_LOG_MAX_BYTES", "0");
    const file = join(dir, "bridge.jsonl");
    for (let line = 0; line < 5; line += 1) appendLogLine(file, `line ${line}`);
    expect(() => statSync(`${file}.1`)).toThrow();
  });
});

it("caps oversized legacy archives when the configured limit is lowered", () => {
  vi.stubEnv("BRIDGE_LOG_MAX_BYTES", "100");
  const file = join(dir, "legacy.jsonl");
  writeFileSync(`${file}.1`, "old archive\n".repeat(50));
  appendLogLine(file, "new record");
  expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(100);
  expect(readFileSync(`${file}.1`, "utf8")).not.toContain("archiveold");
});
