import { afterEach, describe, expect, it } from "vitest";
import { postMessages, startTestBridge } from "../helpers/server.js";
import type { BridgeApp } from "../../src/http/app.js";

const apps: BridgeApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("G1 cross-request tool relay (fake SDK)", () => {
  it("returns tool_use on the first HTTP response while the waiter stays alive", async () => {
    const { app, token } = await startTestBridge({ mode: "fake" });
    apps.push(app);

    const first = await postMessages(app.url, token, {
      model: "relay-probe",
      max_tokens: 32,
      messages: [{ role: "user", content: "call relay_probe nonce=abc" }],
      tools: [{ name: "relay_probe", description: "wait for external result", input_schema: { type: "object", properties: { nonce: { type: "string" } } } }],
    });
    expect(first.status).toBe(200);
    expect(first.json.stop_reason).toBe("tool_use");
    const use = (first.json.content as Array<{ type: string; id: string; name: string }>)[0];
    expect(use.name).toBe("relay_probe");
    const session = app.store.list()[0];
    expect(session?.state).toBe("WAITING_DROID_TOOL");
    expect(session?.pendingToolIds).toContain(use.id);

    const started = Date.now();
    const second = await postMessages(
      app.url,
      token,
      {
        model: "relay-probe",
        max_tokens: 32,
        tools: [{ name: "relay_probe", description: "wait for external result", input_schema: { type: "object", properties: { nonce: { type: "string" } } } }],
        messages: [
          { role: "user", content: "call relay_probe nonce=abc" },
          { role: "assistant", content: [use] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "nonce-abc-ok" }] },
        ],
      },
      { "X-Bridge-Session": first.session ?? "" },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(second.status).toBe(200);
    expect(JSON.stringify(second.json.content)).toContain("nonce-abc-ok");
    expect(app.store.list()[0]?.state).toBe("IDLE");
  });

  it("survives a wait longer than one HTTP handling window", async () => {
    const { app, token } = await startTestBridge({ mode: "fake" });
    apps.push(app);
    const first = await postMessages(app.url, token, {
      model: "relay-probe",
      max_tokens: 16,
      messages: [{ role: "user", content: "slow tool" }],
      tools: [{ name: "relay_probe", input_schema: { type: "object", properties: {} } }],
    });
    const use = (first.json.content as Array<{ id: string }>)[0];
    await new Promise((r) => setTimeout(r, 250));
    const second = await postMessages(
      app.url,
      token,
      {
        model: "relay-probe",
        max_tokens: 16,
        tools: [{ name: "relay_probe", input_schema: { type: "object", properties: {} } }],
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "late" }] }],
      },
      { "X-Bridge-Session": first.session ?? "" },
    );
    expect(JSON.stringify(second.json.content)).toContain("late");
  });

  it("cancels one session without touching another", async () => {
    const { app, token, config } = await startTestBridge({ mode: "fake" });
    apps.push(app);
    const a = await postMessages(app.url, token, {
      model: "relay-probe",
      max_tokens: 16,
      messages: [{ role: "user", content: "one" }],
      tools: [{ name: "relay_probe", input_schema: { type: "object", properties: {} } }],
    }, { "X-Bridge-Session": "chan-a", "X-Bridge-Role": "worker" });
    const b = await postMessages(app.url, token, {
      model: "relay-probe",
      max_tokens: 16,
      messages: [{ role: "user", content: "two" }],
      tools: [{ name: "relay_probe", input_schema: { type: "object", properties: {} } }],
    }, { "X-Bridge-Session": "chan-b", "X-Bridge-Role": "worker" });
    expect(app.store.list()).toHaveLength(2);

    const cancel = await fetch(`${app.url}/internal/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-admin-token": config.adminToken },
      body: JSON.stringify({ sessionId: a.session }),
    });
    expect(cancel.status).toBe(200);
    expect(app.store.get(a.session!)?.state).toBe("CANCELLED");
    expect(app.store.get(b.session!)?.state).toBe("WAITING_DROID_TOOL");
  });
});
