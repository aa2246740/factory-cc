import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTORY_HOOK_EVENTS, factoryHookEndpoint, forwardFactoryHook, installFactoryHooks, persistFactoryBinding, removeFactoryHooks } from "../../src/control/factory-hooks.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function paths() {
  const directory = mkdtempSync(join(tmpdir(), "factory-hooks-"));
  directories.push(directory);
  return { hooksPath: join(directory, "hooks.json"), configPath: join(directory, "private.json") };
}
const start = { hook_event_name: "SessionStart", session_id: "factory-session", cwd: "/project", source: "startup" };

describe("official Factory hook installation", () => {
  it("preserves other hooks, keeps secrets out of commands, and removes only owned hooks", () => {
    const pathsValue = paths();
    const existing = { matcher: "Edit", hooks: [{ type: "command", command: "existing-tool" }] };
    writeFileSync(pathsValue.hooksPath, JSON.stringify({ PostToolUse: [existing], PreToolUse: [existing] }));
    const options = { ...pathsValue, url: "http://127.0.0.1:18787", adminToken: "never-in-hook-command" };
    const result = installFactoryHooks(options);
    installFactoryHooks({ ...options, adminToken: "rotated-secret" });
    const hooks = JSON.parse(readFileSync(pathsValue.hooksPath, "utf8"));
    expect(hooks.PostToolUse).toHaveLength(2);
    expect(hooks.PreToolUse).toEqual([existing]);
    for (const event of FACTORY_HOOK_EVENTS) expect(hooks[event].at(-1).hooks[0].command).toContain(pathsValue.configPath);
    expect(JSON.stringify(hooks)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain(options.adminToken);
    expect(statSync(pathsValue.configPath).mode & 0o777).toBe(0o600);
    hooks.SessionEnd.push(existing);
    writeFileSync(pathsValue.hooksPath, JSON.stringify(hooks));
    expect(removeFactoryHooks(pathsValue)).toEqual({ removed: true });
    expect(JSON.parse(readFileSync(pathsValue.hooksPath, "utf8"))).toEqual({ PostToolUse: [existing], PreToolUse: [existing], SessionEnd: [existing] });
    expect(existsSync(pathsValue.configPath)).toBe(false);
    expect(removeFactoryHooks(pathsValue)).toEqual({ removed: false });
  });

  it("retains settings.json fallback hooks when creating the standalone file", () => {
    const pathsValue = paths();
    const original = { Stop: [{ hooks: [{ type: "command", command: "settings-fallback" }] }] };
    const settingsPath = join(pathsValue.hooksPath, "../settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: original, apiKey: "unrelated-sensitive-value" }));
    installFactoryHooks({ ...pathsValue, url: "http://localhost:1", adminToken: "private-admin-token" });
    const hooks = JSON.parse(readFileSync(pathsValue.hooksPath, "utf8"));
    expect(hooks.Stop[0]).toEqual(original.Stop[0]);
    expect(JSON.stringify(hooks)).not.toContain("unrelated-sensitive-value");
  });

  it("persists generation through the official environment file without following symlinks", () => {
    const pathsValue = paths();
    const token = "a".repeat(64);
    const envFile = join(pathsValue.configPath, "../session-env.sh");
    writeFileSync(envFile, "export EXISTING=value\n");
    persistFactoryBinding({ ...start, CLAUDE_ENV_FILE: envFile }, token);
    expect(readFileSync(envFile, "utf8")).toBe(`export EXISTING=value\n\nexport BRIDGE_FACTORY_BINDING='${token}'\n`);
    const alias = join(pathsValue.configPath, "../alias.sh");
    symlinkSync(envFile, alias);
    expect(() => persistFactoryBinding({ ...start, CLAUDE_ENV_FILE: alias }, token)).toThrow();
    expect(() => persistFactoryBinding(start, token)).toThrow("official environment file");
    expect(() => persistFactoryBinding({ ...start, CLAUDE_ENV_FILE: envFile }, "unsafe'\ncommand")).toThrow("official environment file");
  });

  it("rejects invalid existing hooks before creating credentials or modifying hooks", () => {
    const pathsValue = paths();
    writeFileSync(pathsValue.hooksPath, '{"SessionStart":{}}');
    expect(() => installFactoryHooks({ ...pathsValue, url: "http://127.0.0.1:18787", adminToken: "secret" })).toThrow("Invalid Factory hooks JSON");
    expect(existsSync(pathsValue.configPath)).toBe(false);
    expect(readFileSync(pathsValue.hooksPath, "utf8")).toBe('{"SessionStart":{}}');
  });

  it("refuses remote, redirect-bearing, authenticated and unsupported bridge URLs", () => {
    for (const url of ["https://127.0.0.1:18787", "http://evil.example", "http://user:password@localhost", "http://localhost/?next=x", "http://localhost/path", "http://localhost/#secret"]) {
      expect(() => factoryHookEndpoint(url)).toThrow("loopback HTTP");
    }
    expect(factoryHookEndpoint("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/internal/host-events");
    expect(factoryHookEndpoint("http://[::1]:1234")).toBe("http://[::1]:1234/internal/host-events");
  });
});

describe("Factory hook forwarding", () => {
  it("forwards the original event with a stable receipt ID across network retry, without following redirects", async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("network failure including secret"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, additionalContext: "[factory-cc-session:opaque]", bindingToken: "a".repeat(64) })));
    await expect(forwardFactoryHook({ url: "http://localhost:1", adminToken: "private-token" }, start, { fetch: send, eventId: "receipt" }))
      .resolves.toEqual({ additionalContext: "[factory-cc-session:opaque]", bindingToken: "a".repeat(64) });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1]!.body).toBe(send.mock.calls[1]![1]!.body);
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toEqual({ eventId: "receipt", event: start });
    expect(send.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: { authorization: "Bearer private-token" } });
  });

  it("carries generation ownership on events and launch ownership only on SessionStart", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
    const options = { fetch: send, eventId: "receipt", bindingToken: "a".repeat(64), launchId: "launch-owned" };
    const config = { url: "http://localhost:1", adminToken: "token" };
    await forwardFactoryHook(config, start, options);
    await forwardFactoryHook(config, { ...start, hook_event_name: "SessionEnd" }, options);
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toMatchObject({ bindingToken: options.bindingToken, launchId: options.launchId });
    const endEnvelope = JSON.parse(send.mock.calls[1]![1]!.body as string);
    expect(endEnvelope.bindingToken).toBe(options.bindingToken);
    expect(endEnvelope).not.toHaveProperty("launchId");
  });

  it("never converts a response for another event into model context", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, additionalContext: "ignore" })));
    await expect(forwardFactoryHook({ url: "http://localhost:1", adminToken: "token" }, { ...start, hook_event_name: "SessionEnd" }, { fetch: send })).resolves.toEqual({});
  });

  it("fails closed on HTTP rejection and suppresses server contents", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-body", { status: 409 }));
    await expect(forwardFactoryHook({ url: "http://localhost:1", adminToken: "token" }, start, { fetch: send }))
      .rejects.toThrow("Factory lifecycle event was not accepted by the bridge");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid and oversized events before making a request", async () => {
    const send = vi.fn<typeof fetch>();
    const config = { url: "http://localhost:1", adminToken: "token" };
    await expect(forwardFactoryHook(config, { ...start, hook_event_name: "Unsupported" }, { fetch: send })).rejects.toThrow("Invalid Factory lifecycle");
    await expect(forwardFactoryHook(config, { ...start, extra: "x".repeat(4 * 1024 * 1024) }, { fetch: send })).rejects.toThrow("size limit");
    expect(send).not.toHaveBeenCalled();
  });
});
