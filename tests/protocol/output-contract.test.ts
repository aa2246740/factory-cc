import { afterEach, describe, expect, it } from "vitest";
import { postMessages, startTestBridge } from "../helpers/server.js";
import type { BridgeApp } from "../../src/http/app.js";

const apps: BridgeApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

describe("specialized completion contracts", () => {
  it.each([false, true])("refuses Shield-style JSON + logprobs without creating a session (stream=%s)", async (stream) => {
    const { app, token } = await startTestBridge();
    apps.push(app);
    const response = await postMessages(app.url, token, {
      model: "shield-risk", max_tokens: 128, stream,
      messages: [{ role: "user", content: "Classify this synthetic placeholder." }],
      response_format: { type: "json_schema", json_schema: { name: "shield_decision", strict: true, schema: { type: "object" } } },
      logprobs: true, top_logprobs: 2,
    });
    expect(response.status).toBe(422);
    expect(response.json).toMatchObject({ type: "error", error: { type: "unsupported_output_contract" } });
    expect(app.store.list()).toEqual([]);
    expect(app.records).toEqual([]);
  });
});
