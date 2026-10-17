import { mkdtempSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isLoopbackHost, isWildcardHost, loadConfig, parseAllowedHosts } from "../../src/config.js";
import { createBridgeApp, listen } from "../../src/http/app.js";
import { createLogger } from "../../src/logging.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
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
    expect(loadConfig({ dataDir, ...tokens, host: "0.0.0.0", allowRemote: true, allowedHosts: ["192.168.1.20"], authMode: "byok" })).toMatchObject({ host: "0.0.0.0", allowRemote: true });
  });

  describe("remote Host names (BRIDGE_ALLOWED_HOSTS)", () => {
    const remote = { ...tokens, allowRemote: true, authMode: "byok" as const };

    it("treats 0.0.0.0 and :: as wildcard binds", () => {
      for (const host of ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0"]) expect(isWildcardHost(host)).toBe(true);
      for (const host of ["10.0.0.8", "127.0.0.1", "::1", "example.test"]) expect(isWildcardHost(host)).toBe(false);
    });

    it.each(["0.0.0.0", "::"])("refuses a remote bind to %s without the names clients will use, and says what to set", (host) => {
      const dataDir = directory();
      expect(() => loadConfig({ dataDir, ...remote, host })).toThrow(/BRIDGE_ALLOWED_HOSTS.*names or IPs/);
      expect(() => loadConfig({ dataDir, ...remote, host, allowedHosts: [] })).toThrow(/BRIDGE_ALLOWED_HOSTS/);
      vi.stubEnv("BRIDGE_ALLOWED_HOSTS", " , ");
      expect(() => loadConfig({ dataDir, ...remote, host })).toThrow(/BRIDGE_ALLOWED_HOSTS/);
      vi.stubEnv("BRIDGE_ALLOWED_HOSTS", "192.168.1.20");
      expect(loadConfig({ dataDir, ...remote, host }).allowedHosts).toEqual(["192.168.1.20"]);
    });

    it("keeps a specific remote address working without any list, and never relaxes the earlier refusals", () => {
      const dataDir = directory();
      expect(loadConfig({ dataDir, ...remote, host: "10.0.0.8" })).toMatchObject({ host: "10.0.0.8", allowRemote: true, allowedHosts: [] });
      expect(() => loadConfig({ dataDir, ...tokens, host: "0.0.0.0", allowedHosts: ["192.168.1.20"] })).toThrow(/BRIDGE_ALLOW_REMOTE=1/);
      expect(() => loadConfig({ dataDir, ...tokens, host: "0.0.0.0", allowRemote: true, authMode: "subscription", allowedHosts: ["192.168.1.20"] }))
        .toThrow(/exposing a Claude subscription/);
    });

    it("normalizes names: trimmed, lowercased, deduplicated, IPv6 bracketed", () => {
      expect(parseAllowedHosts(" Devbox.Local, 192.168.1.20 ,devbox.local,[FE80::1],fe80::2,,")).toEqual(["devbox.local", "192.168.1.20", "[fe80::1]", "[fe80::2]"]);
      expect(parseAllowedHosts(undefined)).toEqual([]);
      expect(parseAllowedHosts(["A.example", "a.EXAMPLE"])).toEqual(["a.example"]);
      const dataDir = directory();
      vi.stubEnv("BRIDGE_ALLOWED_HOSTS", "Devbox.Local,10.1.2.3");
      expect(loadConfig({ dataDir, ...remote, host: "0.0.0.0" }).allowedHosts).toEqual(["devbox.local", "10.1.2.3"]);
    });

    it.each(["10.0.0.8:18787", "http://devbox.local", "devbox.local/path", "dev box", "*.example", "[fe80::1]:8080x"])("rejects an entry that is not a bare name or IP: %s", (entry) => {
      expect(() => parseAllowedHosts(entry)).toThrow(/bare host names or IP addresses/);
    });
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
