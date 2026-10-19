import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { BridgeApp } from "../../src/http/app.js";
import { postMessages, startTestBridge } from "../helpers/server.js";

const apps: BridgeApp[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (apps.length) await apps.pop()!.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const payload = {
  model: "relay-probe",
  max_tokens: 16,
  system: "SECRET-SYSTEM-INSTRUCTIONS",
  messages: [{ role: "user", content: "SECRET-USER-PROMPT RELAY_TEXT_PROBE" }],
  tools: [{ name: "Read", description: "SECRET-TOOL-DESCRIPTION", input_schema: { type: "object" } }],
};
const lastEntry = (file: string) => JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!) as { body: Record<string, unknown>; headers: Record<string, string> };

describe("request log", () => {
  it("keeps message text out by default and records only a hash, the size and the tool names", async () => {
    const { app, token, config } = await startTestBridge();
    apps.push(app);
    expect((await postMessages(app.url, token, payload)).status).toBe(200);
    const file = join(config.logDir, "requests.jsonl");
    const text = readFileSync(file, "utf8");
    for (const secret of ["SECRET-USER-PROMPT", "SECRET-SYSTEM-INSTRUCTIONS", "SECRET-TOOL-DESCRIPTION", token]) expect(text).not.toContain(secret);
    const wire = JSON.stringify(payload);
    expect(lastEntry(file).body).toEqual({ sha256: createHash("sha256").update(wire).digest("hex"), bytes: Buffer.byteLength(wire), toolNames: ["Read"] });
    expect(lastEntry(file).headers.authorization).toBe("[redacted]");
    for (const name of ["turns.jsonl", "bridge.jsonl"]) {
      try { expect(readFileSync(join(config.logDir, name), "utf8")).not.toContain("SECRET-"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  });

  it("restores the redacted full body when BRIDGE_LOG_BODIES is set", async () => {
    vi.stubEnv("BRIDGE_LOG_BODIES", "1");
    const { app, token, config } = await startTestBridge();
    apps.push(app);
    expect(config.logBodies).toBe(true);
    expect((await postMessages(app.url, token, payload)).status).toBe(200);
    const entry = lastEntry(join(config.logDir, "requests.jsonl"));
    expect(entry.body).toMatchObject({ system: "SECRET-SYSTEM-INSTRUCTIONS", messages: [{ role: "user", content: "SECRET-USER-PROMPT RELAY_TEXT_PROBE" }] });
    expect(JSON.stringify(entry)).not.toContain(token);
  });

  it("defaults BRIDGE_LOG_BODIES to off and only 1 turns it on", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "relay-logbodies-"));
    directories.push(dataDir);
    const load = () => loadConfig({ dataDir }).logBodies;
    expect(load()).toBe(false);
    vi.stubEnv("BRIDGE_LOG_BODIES", "true");
    expect(load()).toBe(false);
    vi.stubEnv("BRIDGE_LOG_BODIES", "1");
    expect(load()).toBe(true);
  });

  it("writes every log file with mode 0600", async () => {
    const { app, token, config } = await startTestBridge();
    apps.push(app);
    await postMessages(app.url, token, payload);
    const host = await fetch(`${app.url}/internal/host-events`, {
      method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ eventId: "log-mode", event: { hook_event_name: "SessionStart", session_id: "factory-log", cwd: config.sdkCwd, source: "startup" } }),
    });
    expect(host.status).toBe(200);
    for (const name of ["requests.jsonl", "turns.jsonl", "host-events.jsonl"]) {
      expect(statSync(join(config.logDir, name)).mode & 0o777).toBe(0o600);
    }
  });
});
