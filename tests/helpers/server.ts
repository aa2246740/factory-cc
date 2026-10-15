import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type BridgeConfig } from "../../src/config.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { createLogger } from "../../src/logging.js";

export async function startTestBridge(overrides: Partial<BridgeConfig> = {}): Promise<{
  app: BridgeApp;
  token: string;
  config: BridgeConfig;
}> {
  const token = overrides.clientToken ?? "test-token-not-anthropic";
  const config = loadConfig({
    mode: "mock",
    host: "127.0.0.1",
    port: 0,
    clientToken: token,
    adminToken: "admin-token",
    dataDir: mkdtempSync(join(tmpdir(), "relay-test-")),
    persistSessions: false,
    ...overrides,
  });
  const app = createBridgeApp(config, createLogger(config.logDir), join(config.sandboxDir, "CANARY.txt"));
  await listen(app, config);
  return { app, token, config };
}

export async function postMessages(
  url: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown>; raw: string; session?: string }> {
  const res = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  return {
    status: res.status,
    json: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    raw,
    session: res.headers.get("x-bridge-session") ?? undefined,
  };
}
