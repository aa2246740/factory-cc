import { connect } from "node:net";
import { request as httpRequest } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeApp } from "../../src/http/app.js";
import { postMessages, startTestBridge } from "../helpers/server.js";

const apps: BridgeApp[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const body = { model: "relay-probe", max_tokens: 16, messages: [{ role: "user", content: "RELAY_TEXT_PROBE" }] };

function raw(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

function rawSocket(port: number, host: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host }, () => socket.write(payload));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

describe("loopback request checks, token separation and bounded records", () => {
  it("rejects a foreign Host or Origin and still serves the same-origin control page", async () => {
    const { app } = await startTestBridge();
    apps.push(app);
    const port = new URL(app.url).port;
    const health = await fetch(`${app.url}/healthz`).then(async (response) => ({ status: response.status, body: await response.json() }));
    expect(health).toEqual({ status: 200, body: { ok: true, mode: "mock" } });
    const control = await fetch(`${app.url}/control`);
    expect(control.status).toBe(200);
    const allowedOrigin = await fetch(`${app.url}/control`, { headers: { origin: `http://127.0.0.1:${port}` } });
    expect(allowedOrigin.status).toBe(200);

    const foreignHost = await raw(`${app.url}/healthz`, { host: `evil.example:${port}` });
    expect(foreignHost.status).toBe(403);
    expect(JSON.parse(foreignHost.body)).toEqual({ type: "error", error: { type: "permission_error", message: "Host is not allowed for this bridge." } });
    // HTTP/1.1 with no Host header is rejected by Node's parser as 400 before this
    // app runs. HTTP/1.0 may omit Host, and that request reaches the check.
    const missingHost = await rawSocket(Number(port), "127.0.0.1", "GET /healthz HTTP/1.0\r\n\r\n");
    expect(missingHost.startsWith("HTTP/1.1 403")).toBe(true);
    expect(missingHost).toContain("permission_error");
    const emptyHost = await rawSocket(Number(port), "127.0.0.1", "GET /healthz HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n");
    expect(emptyHost).toContain("403");
    expect(emptyHost).toContain("permission_error");
    const foreignOrigin = await fetch(`${app.url}/healthz`, { headers: { origin: "http://evil.example" } });
    expect(foreignOrigin.status).toBe(403);
    expect(await foreignOrigin.json()).toEqual({ type: "error", error: { type: "permission_error", message: "Origin is not allowed for this bridge." } });
  });

  it("accepts the admin token only from the admin header or bearer, and limits the hook token to host events", async () => {
    const { app, config } = await startTestBridge();
    apps.push(app);
    const runtime = (headers: Record<string, string>) => fetch(`${app.url}/internal/runtime`, { headers });
    expect((await runtime({ "x-api-key": config.adminToken })).status).toBe(401);
    expect((await runtime({ authorization: `Bearer ${config.hookToken}` })).status).toBe(401);
    expect((await runtime({ "x-bridge-admin-token": config.hookToken })).status).toBe(401);
    expect((await runtime({ authorization: `Bearer ${config.adminToken}` })).status).toBe(200);
    expect((await runtime({ "x-bridge-admin-token": config.adminToken })).status).toBe(200);

    const event = { eventId: "hook-ok", event: { hook_event_name: "SessionStart", session_id: "factory-hook", cwd: config.sdkCwd, source: "startup" } };
    const denied = await fetch(`${app.url}/internal/sessions`, { headers: { authorization: `Bearer ${config.hookToken}` } });
    expect(denied.status).toBe(401);
    const accepted = await fetch(`${app.url}/internal/host-events`, {
      method: "POST", headers: { authorization: `Bearer ${config.hookToken}`, "content-type": "application/json" }, body: JSON.stringify(event),
    });
    expect(accepted.status).toBe(200);
  });

  it("does not record unauthenticated posts and keeps only the last 500 authenticated requests", async () => {
    const { app, token, config } = await startTestBridge({ maxSessions: 800 });
    apps.push(app);
    const before = app.records.length;
    const probe = JSON.stringify(body);
    for (let offset = 0; offset < 2000; offset += 100) {
      await Promise.all(Array.from({ length: 100 }, () => fetch(`${app.url}/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: probe,
      })));
    }
    expect(app.records.length).toBe(before);
    expect(app.authFailureCount).toBe(2000);
    const runtime = await fetch(`${app.url}/internal/runtime`, { headers: { "x-bridge-admin-token": config.adminToken } }).then((response) => response.json()) as { authFailureCount: number };
    expect(runtime.authFailureCount).toBe(2000);
    expect(existsSync(join(config.logDir, "request-index.json"))).toBe(false);

    for (let index = 0; index < 600; index += 1) {
      const response = await postMessages(app.url, token, body, { "x-bridge-session": `ring-${index}` });
      expect(response.status).toBe(200);
    }
    expect(app.records).toHaveLength(500);
    expect(app.authFailureCount).toBe(2000);
    await app.close();
    const saved = JSON.parse(readFileSync(join(config.logDir, "request-index.json"), "utf8")) as unknown[];
    expect(saved).toHaveLength(500);
  });
});
