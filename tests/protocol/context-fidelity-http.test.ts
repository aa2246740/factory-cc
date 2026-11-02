import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { createBridgeApp, listen, type BridgeApp } from "../../src/http/app.js";
import { assistantMessage } from "../../src/protocol/messages.js";
import type { BridgeRuntime, Continuity } from "../../src/runtime/types.js";
import { contextOverflowError } from "../../src/runtime/upstream-error.js";

const apps: BridgeApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function start(runtime: BridgeRuntime) {
  const config = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "relay-continuity-")), port: 0, clientToken: "client", adminToken: "admin", hookToken: "hook", persistSessions: false });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = createBridgeApp(config, logger, "", runtime);
  apps.push(app);
  await listen(app, config);
  return { app, logger };
}
function post(app: BridgeApp, path: string, body: unknown) {
  return fetch(`${app.url}${path}`, { method: "POST", headers: { authorization: "Bearer client", "content-type": "application/json" }, body: JSON.stringify(body) });
}
const history = [{ role: "user", content: "old" }, { role: "assistant", content: "old reply" }, { role: "user", content: "now" }];

describe("continuity is visible to the client", () => {
  it.each([false, true])("sets X-Bridge-Continuity, counts it and warns on a cold import (stream=%s)", async (stream) => {
    const continuity: Continuity = { kind: "cold-import", reason: "new-session", importedMessages: 2 };
    const runtime: BridgeRuntime = {
      kind: "fake",
      async handle(input, sink) {
        sink?.continuity?.(continuity);
        sink?.textDelta("hi");
        return { response: assistantMessage(input.request.model, [{ type: "text", text: "hi" }], "end_turn", { input_tokens: 1, output_tokens: 1 }), pendingToolIds: [], continuity };
      },
      async cancel() {}, async deliverResults() { return []; },
    };
    const { app, logger } = await start(runtime);
    const response = await post(app, "/v1/messages", { model: "relay-chat", max_tokens: 16, stream, messages: history });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-bridge-continuity")).toBe("cold-import");
    await response.text();
    expect(app.runtimeStatus()).toMatchObject({ upstreamCompaction: "off", continuity: { "cold-import": 1, reused: 0 } });
    expect(logger.warn).toHaveBeenCalledWith("continuity_downgrade", expect.objectContaining({ continuity: "cold-import", reason: "new-session", importedMessages: 2 }));
  });

  it("takes continuity from the turn when the runtime reports it only there", async () => {
    const runtime: BridgeRuntime = {
      kind: "fake",
      async handle(input) {
        return { response: assistantMessage(input.request.model, [{ type: "text", text: "hi" }], "end_turn", { input_tokens: 1, output_tokens: 1 }), pendingToolIds: [], continuity: { kind: "reused" } };
      },
      async cancel() {}, async deliverResults() { return []; },
    };
    const { app, logger } = await start(runtime);
    const response = await post(app, "/v1/messages", { model: "relay-chat", max_tokens: 16, messages: [{ role: "user", content: "go" }] });
    expect(response.headers.get("x-bridge-continuity")).toBe("reused");
    expect(logger.warn).not.toHaveBeenCalledWith("continuity_downgrade", expect.anything());
  });
});

describe("a full context window reaches Droid as an overflow it compacts on", () => {
  function overflowing(): BridgeRuntime {
    return {
      kind: "fake",
      async handle() { throw contextOverflowError("Prompt is too long: 1050000 tokens > 1000000 maximum"); },
      async cancel() {}, async deliverResults() { return []; },
      // Even a runtime that still holds the session must not keep it for a retry.
      isSessionUsable: () => true,
    };
  }

  it.each([false, true])("answers Messages with invalid_request_error and prompt is too long (stream=%s)", async (stream) => {
    const { app } = await start(overflowing());
    const response = await post(app, "/v1/messages", { model: "relay-chat", max_tokens: 16, stream, messages: [{ role: "user", content: "go" }] });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toMatch(/^prompt is too long/);
    expect(app.store.list().map((session) => session.state)).toEqual(["FAILED"]);
  });

});
