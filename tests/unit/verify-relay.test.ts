import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { completionMatches, doctorInstance, ownDirectory, parseVerificationArgs, removeOwnedDirectory, runtimeIsDrained } from "../../scripts/verify-relay.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const drained = () => ({ activeNativeSessions: 0, activeNativeTurns: 0, pendingHostCalls: 0, pendingApprovals: 0, fatalErrors: [], control: { activeHostSessions: 0, pendingApprovals: 0, failures: [] } });

describe("verification harness acceptance boundaries", () => {
  it("requires an explicit feature/doctor mode and never silently claims all-feature coverage", () => {
    expect(() => parseVerificationArgs([])).toThrow("Choose exactly one");
    expect(() => parseVerificationArgs(["--feature", "all"])).toThrow("does not certify every Factory model path");
    expect(() => parseVerificationArgs(["--feature", "chat", "--offline-check"])).toThrow("Choose exactly one");
    expect(() => parseVerificationArgs(["--offline-check", "--summary", "result.json"])).toThrow("requires --feature");
    expect(parseVerificationArgs(["--help"]).help).toBe(true);
  });

  it("accepts real Droid tool-trace prefixes only with an independently matching native final answer", () => {
    expect(completionMatches("[Read] Read input.json\n\n[Write] Write result.json\nVERIFY_WRITE_OK", "VERIFY_WRITE_OK", "VERIFY_WRITE_OK")).toBe(true);
    expect(completionMatches("[Read] VERIFY_WRITE_OK", "VERIFY_WRITE_OK", "VERIFY_WRITE_OK")).toBe(false);
    expect(completionMatches("VERIFY_WRITE_OK", "write failed", "VERIFY_WRITE_OK")).toBe(false);
    expect(completionMatches("VERIFY_WRITE_OK", undefined, "VERIFY_WRITE_OK")).toBe(false);
  });

  it("rejects hidden pending work, fatal/control failures and missing runtime counters", () => {
    expect(runtimeIsDrained(drained())).toBe(true);
    expect(runtimeIsDrained({ ...drained(), activeNativeTurns: 1 })).toBe(false);
    expect(runtimeIsDrained({ ...drained(), fatalErrors: [{ code: "native_failed" }] })).toBe(false);
    expect(runtimeIsDrained({ ...drained(), control: { ...drained().control, failures: ["host_close_failed"] } })).toBe(false);
    expect(runtimeIsDrained({ ...drained(), control: { pendingApprovals: 0, failures: [] } })).toBe(false);
    expect(runtimeIsDrained({})).toBe(false);
  });

  it("refuses recursive deletion after directory identity is replaced by a symlink", () => {
    const owned = ownDirectory("relay-verify-private-");
    const victim = ownDirectory("relay-verify-private-");
    const moved = `${owned.path}-moved`;
    cleanup.push(() => { rmSync(owned.path, { force: true }); rmSync(moved, { recursive: true, force: true }); removeOwnedDirectory(victim); });
    writeFileSync(join(victim.path, "keep.txt"), "untouched");
    renameSync(owned.path, moved);
    symlinkSync(victim.path, owned.path);
    expect(() => removeOwnedDirectory(owned)).toThrow("ownership changed");
    expect(existsSync(join(victim.path, "keep.txt"))).toBe(true);
  });

  it("doctor uses only GET, requires actual admin access, and labels model readiness untested", async () => {
    const home = ownDirectory("relay-e2e-home-");
    const workspace = ownDirectory("relay-e2e-ws-");
    const data = ownDirectory("relay-verify-private-");
    for (const owned of [home, workspace, data]) cleanup.push(() => { removeOwnedDirectory(owned); });
    mkdirSync(join(home.path, ".factory"));
    mkdirSync(join(data.path, "claude-config"));
    writeFileSync(join(home.path, ".factory/settings.json"), "{}", { mode: 0o600 });
    writeFileSync(join(home.path, ".factory/relay-hooks.json"), "{}", { mode: 0o600 });
    const requests: string[] = [];
    const token = "synthetic-private-doctor-token";
    const server: Server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/healthz") res.end(JSON.stringify({ ok: true, mode: "sdk" }));
      else if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end("{}"); }
      else if (req.url === "/internal/runtime") res.end(JSON.stringify({ kind: "sdk", authMode: "byok", ...drained() }));
      else res.end(JSON.stringify({ sessions: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const address = server.address() as { port: number };
    const manifest = join(data.path, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ kind: "relay-verification-instance", version: 1, url: `http://127.0.0.1:${address.port}`, adminToken: token, home, workspace, data }), { mode: 0o600 });
    const result = await doctorInstance(manifest);
    expect(result.status).toBe("PASS");
    expect(result.modelAvailability).toBe("NOT_TESTED_BY_DOCTOR");
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
    chmodSync(manifest, 0o644);
    await expect(doctorInstance(manifest)).rejects.toThrow("mode-0600");
  });
});
