import { afterEach, describe, expect, it } from "vitest";
import { startTestBridge, postMessages } from "../helpers/server.js";
import type { BridgeApp } from "../../src/http/app.js";

const apps: BridgeApp[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
describe("control API boundaries", () => {
  it("requires administrator authority separately from the model client token", async () => {
    const { app, token } = await startTestBridge(); apps.push(app);
    for (const path of ["/internal/approvals", "/internal/runtime"]) {
      expect((await fetch(`${app.url}${path}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
      const response = await fetch(`${app.url}${path}`, { headers: { authorization: "Bearer admin-token" } });
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const host = await fetch(`${app.url}/internal/host-events`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ eventId: "unauthorized", event: { hook_event_name: "SessionStart", session_id: "a", cwd: "/tmp" } }) });
    expect(host.status).toBe(401);
    expect(app.records).toHaveLength(0);
    expect(app.runtimeStatus().control).toMatchObject({ activeHostSessions: 0 });
    const malformed = await fetch(`${app.url}/internal/host-events`, { method: "POST", headers: { authorization: "Bearer admin-token", "content-type": "application/json" }, body: '{"private":"should-not-echo"' });
    expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain("should-not-echo");
  });

  it("rejects unsupported forced tool execution before opening a native session", async () => {
    const { app, token } = await startTestBridge(); apps.push(app);
    for (const tool_choice of [{ type: "any" }, { type: "tool", name: "Bash" }, { type: "auto", disable_parallel_tool_use: true }]) {
      const result = await postMessages(app.url, token, { model: "test", max_tokens: 10, messages: [{ role: "user", content: "work" }], tool_choice });
      expect(result.status).toBe(422); expect(result.json.error).toMatchObject({ type: "unsupported_tool_choice" });
    }
    expect(app.store.list()).toHaveLength(0);
  });
});
