import { afterEach, describe, expect, it } from "vitest";
import { postMessages, startTestBridge } from "../helpers/server.js";
import type { BridgeApp } from "../../src/http/app.js";

const apps: BridgeApp[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("Messages protocol", () => {
  it("returns 401 and never starts a session on a bad token", async () => {
    const { app } = await startTestBridge();
    apps.push(app);
    const res = await postMessages(app.url, "wrong", {
      model: "relay-probe",
      max_tokens: 32,
      messages: [{ role: "user", content: "RELAY_TEXT_PROBE" }],
    });
    expect(res.status).toBe(401);
    expect(app.store.list()).toHaveLength(0);
    expect(app.records).toHaveLength(0);
    expect(app.authFailureCount).toBe(1);
  });

  it("returns the fixed text probe in JSON and SSE", async () => {
    const { app, token } = await startTestBridge();
    apps.push(app);
    const json = await postMessages(app.url, token, {
      model: "relay-probe",
      max_tokens: 64,
      messages: [{ role: "user", content: "RELAY_TEXT_PROBE say hi" }],
    });
    expect(json.status).toBe(200);
    const content = json.json.content as Array<{ text?: string }>;
    expect(content[0]?.text).toContain("relay-bridge mock: text probe ok");

    const stream = await fetch(`${app.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: "relay-probe",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "RELAY_TEXT_PROBE" }],
      }),
    });
    const raw = await stream.text();
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(raw).toContain("event: message_start");
    expect(raw).toContain("event: content_block_delta");
    expect(raw).toContain("relay-bridge mock: text probe ok");
    expect(raw).toContain("event: message_stop");
  });

  it("emits a real tool_use from the provided schema then accepts the matching result", async () => {
    const { app, token } = await startTestBridge();
    apps.push(app);
    const tools = [{
      name: "Read", description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }];
    const first = await postMessages(app.url, token, {
      model: "relay-probe",
      max_tokens: 64,
      messages: [{ role: "user", content: "RELAY_TOOL_PROBE RELAY_CANARY_ABC CANARY_PATH=/tmp/canary.txt" }],
      tools,
    });
    expect(first.status).toBe(200);
    const block = (first.json.content as Array<{ type: string; id: string; name: string; input: { path: string } }>)[0];
    expect(block.type).toBe("tool_use");
    expect(block.name).toBe("Read");
    expect(block.input.path).toBe("/tmp/canary.txt");
    expect(first.json.stop_reason).toBe("tool_use");

    const second = await postMessages(
      app.url,
      token,
      {
        model: "relay-probe",
        max_tokens: 64,
        tools,
        messages: [
          { role: "user", content: "RELAY_TOOL_PROBE RELAY_CANARY_ABC" },
          { role: "assistant", content: [block] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: block.id, content: "RELAY_CANARY_ABC" }] },
        ],
      },
      { "X-Bridge-Session": first.session ?? "" },
    );
    expect(second.status).toBe(200);
    expect(JSON.stringify(second.json.content)).toContain("canary=RELAY_CANARY_ABC");
  });

  it("refuses to invent a tool when none are recognized", async () => {
    const { app, token } = await startTestBridge();
    apps.push(app);
    const res = await postMessages(app.url, token, {
      model: "relay-probe",
      max_tokens: 16,
      messages: [{ role: "user", content: "RELAY_TOOL_PROBE" }],
      tools: [
        {
          name: "DeployProd",
          description: "write production files",
          input_schema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      ],
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.json)).toContain("DeployProd");
  });

  it("treats tool results from earlier turns as history, not as answers to a new request", async () => {
    const { app, token } = await startTestBridge();
    apps.push(app);
    const res = await postMessages(app.url, token, {
      model: "relay-probe",
      max_tokens: 64,
      messages: [
        { role: "user", content: "inspect the project" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_earlier", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_earlier", content: "interrupted" }] },
        { role: "assistant", content: "Stopped as requested." },
        { role: "user", content: "RELAY_TEXT_PROBE" },
      ],
    });
    expect(res.status).toBe(200);
    expect((res.json.content as Array<{ text?: string }>)[0]?.text).toContain("text probe ok");
  });

  it("returns 501 for token counting instead of a fake exact count", async () => {
    const { app, token } = await startTestBridge();
    apps.push(app);
    const res = await fetch(`${app.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "relay-probe", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(501);
  });
});
