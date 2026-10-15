import { afterEach, describe, expect, it } from "vitest";
import { postMessages, startTestBridge } from "../helpers/server.js";
import type { BridgeApp } from "../../src/http/app.js";

const apps: BridgeApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("resilience", () => {
  it("treats a repeated tool_result as duplicate without changing outcome", async () => {
    const { app, token } = await startTestBridge({ mode: "fake" });
    apps.push(app);
    const first = await postMessages(app.url, token, {
      model: "relay-probe",
      max_tokens: 16,
      messages: [{ role: "user", content: "TWO_TOOLS" }],
      tools: [
        { name: "alpha", input_schema: { type: "object", properties: {} } },
        { name: "beta", input_schema: { type: "object", properties: {} } },
      ],
    });
    const uses = first.json.content as Array<{ id: string; name: string }>;
    expect(uses).toHaveLength(2);
    const payload = {
      model: "relay-probe",
      max_tokens: 16,
      tools: [
        { name: "alpha", input_schema: { type: "object", properties: {} } },
        { name: "beta", input_schema: { type: "object", properties: {} } },
      ],
      messages: [
        { role: "user", content: "TWO_TOOLS" },
        { role: "assistant", content: uses },
        {
          role: "user" as const,
          content: [
            { type: "tool_result", tool_use_id: uses[0]!.id, content: "A-ok" },
            { type: "tool_result", tool_use_id: uses[1]!.id, content: "B-ok" },
          ],
        },
      ],
    };
    const second = await postMessages(app.url, token, payload, { "X-Bridge-Session": first.session ?? "" });
    expect(second.status).toBe(200);
    const replay = await postMessages(app.url, token, payload, { "X-Bridge-Session": first.session ?? "" });
    expect(replay.status).toBe(200);
  });

  it("accepts an image tool_result block without flattening it to a screenshot note", async () => {
    const { app, token } = await startTestBridge({ mode: "fake" });
    apps.push(app);
    const first = await postMessages(app.url, token, {
      model: "relay-probe",
      max_tokens: 16,
      messages: [{ role: "user", content: "picture" }],
      tools: [{ name: "screenshot", input_schema: { type: "object", properties: {} } }],
    });
    const use = (first.json.content as Array<{ id: string }>)[0];
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const second = await postMessages(
      app.url,
      token,
      {
        model: "relay-probe",
        max_tokens: 16,
        tools: [{ name: "screenshot", input_schema: { type: "object", properties: {} } }],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: use.id,
                content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }],
              },
            ],
          },
        ],
      },
      { "X-Bridge-Session": first.session ?? "" },
    );
    expect(second.status).toBe(200);
    expect(JSON.stringify(second.json)).not.toContain("见截图");
  });

  it("rejects a tool_result from another session", async () => {
    const { app, token } = await startTestBridge({ mode: "fake" });
    apps.push(app);
    const first = await postMessages(app.url, token, {
      model: "relay-probe",
      max_tokens: 16,
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "relay_probe", input_schema: { type: "object", properties: {} } }],
    }, { "X-Bridge-Session": "one" });
    const use = (first.json.content as Array<{ id: string }>)[0];
    const other = await postMessages(
      app.url,
      token,
      {
        model: "relay-probe",
        max_tokens: 16,
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "stolen" }] }],
      },
      { "X-Bridge-Session": "two" },
    );
    expect(other.status).toBe(409);
  });
});
