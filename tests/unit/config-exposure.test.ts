import { mkdtempSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isLoopbackHost, loadConfig } from "../../src/config.js";
import { createBridgeApp, listen } from "../../src/http/app.js";
import { createLogger } from "../../src/logging.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "relay-config-"));
  directories.push(path);
  return path;
}
const tokens = { clientToken: "client-token", adminToken: "admin-token", hookToken: "hook-token" };

describe("loopback exposure and distinct tokens", () => {
  it("treats localhost, ::1 and 127/8 as loopback", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["0.0.0.0", "192.168.1.2", "example.test"]) expect(isLoopbackHost(host)).toBe(false);
  });

  it("refuses a non-loopback bind unless remote access is explicitly allowed, and never for subscription", () => {
    const dataDir = directory();
    expect(() => loadConfig({ dataDir, ...tokens, host: "0.0.0.0" })).toThrow(/BRIDGE_ALLOW_REMOTE=1/);
    expect(() => loadConfig({ dataDir, ...tokens, host: "10.0.0.8", authMode: "subscription", allowRemote: true })).toThrow(/exposing a Claude subscription/);
    expect(loadConfig({ dataDir, ...tokens, host: "127.0.0.2" }).allowRemote).toBe(false);
    expect(loadConfig({ dataDir, ...tokens, host: "0.0.0.0", allowRemote: true, authMode: "byok" })).toMatchObject({ host: "0.0.0.0", allowRemote: true });
  });

  it("rejects equal client, admin and hook tokens without echoing them", () => {
    const dataDir = directory();
    for (const override of [
      { clientToken: "same-token", adminToken: "same-token", hookToken: "hook-token" },
      { clientToken: "client-token", adminToken: "same-token", hookToken: "same-token" },
      { clientToken: "same-token", adminToken: "admin-token", hookToken: "same-token" },
    ]) {
      let error: unknown;
      try { loadConfig({ dataDir, ...override }); } catch (caught) { error = caught; }
      expect(String(error)).toMatch(/must be different/);
      expect(String(error)).not.toContain("same-token");
    }
  });

  it("creates the data and log directories as mode 0700 and brackets an IPv6 listen URL", async () => {
    const dataDir = directory();
    const config = loadConfig({ dataDir, ...tokens, host: "::1", port: 0, mode: "mock" });
    expect(statSync(config.dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(config.logDir).mode & 0o777).toBe(0o700);
    const app = createBridgeApp(config, createLogger(config.logDir), join(config.sandboxDir, "CANARY.txt"));
    expect(app.url).toBe("http://[::1]:0");
    try {
      await listen(app, config);
      expect(app.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
      const port = new URL(app.url).port;
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = connect({ port: Number(port), host: "::1" }, () => {
          socket.write(`GET /healthz HTTP/1.1\r\nHost: [::1]:${port}\r\nConnection: close\r\n\r\n`);
        });
        const chunks: Buffer[] = [];
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        socket.on("error", reject);
      });
      expect(raw).toContain("HTTP/1.1 200");
      expect(raw).toContain('{"ok":true,"mode":"mock"}');
    } finally {
      if (app.server.listening) await app.close();
    }
  });
});
