import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import type { BridgeRuntime } from "../../src/runtime/types.js";
import { upstreamError } from "../../src/runtime/upstream-error.js";

const apps: BridgeApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
it.each([false, true])("returns 429 + retry-after before content (stream=%s)", async (stream) => {
  const config = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "relay-upstream-")), port: 0, clientToken: "client", adminToken: "admin", hookToken: "hook" });
  const runtime: BridgeRuntime = { kind: "fake", async handle() { throw upstreamError(new Error("rate_limit_error retry-after: 9")); }, async cancel() {}, async deliverResults() { return []; } };
  const app = createBridgeApp(config, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, "", runtime);
  apps.push(app); await listen(app, config);
  const response = await fetch(`${app.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer client", "content-type": "application/json" },
    body: JSON.stringify({ model: "relay-chat", max_tokens: 16, stream, messages: [{ role: "user", content: "go" }] }) });
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("9");
  expect(await response.json()).toMatchObject({ type: "error", error: { type: "rate_limit_error", retry_after: 9 } });
});
