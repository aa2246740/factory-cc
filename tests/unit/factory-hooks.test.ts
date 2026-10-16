import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
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
    const options = { ...pathsValue, url: "http://127.0.0.1:18787", hookToken: "never-in-hook-command" };
    const result = installFactoryHooks(options);
    installFactoryHooks({ ...options, hookToken: "rotated-secret" });
    const hooks = JSON.parse(readFileSync(pathsValue.hooksPath, "utf8"));
    expect(hooks.PostToolUse).toHaveLength(2);
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse[0]).toEqual(existing);
    for (const event of FACTORY_HOOK_EVENTS) expect(hooks[event].at(-1).hooks[0].command).toContain(pathsValue.configPath);
    expect(JSON.stringify(hooks)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain(options.hookToken);
    const saved = JSON.parse(readFileSync(pathsValue.configPath, "utf8")) as { hookToken?: string; adminToken?: string };
    expect(saved.hookToken).toBe("rotated-secret");
    expect(saved.adminToken).toBeUndefined();
    expect(statSync(pathsValue.configPath).mode & 0o777).toBe(0o600);
    hooks.SessionEnd.push(existing);
    writeFileSync(pathsValue.hooksPath, JSON.stringify(hooks));
    expect(removeFactoryHooks(pathsValue)).toEqual({ removed: true });
    expect(JSON.parse(readFileSync(pathsValue.hooksPath, "utf8"))).toEqual({ PostToolUse: [existing], PreToolUse: [existing], SessionEnd: [existing] });
    expect(existsSync(pathsValue.configPath)).toBe(false);
    expect(removeFactoryHooks(pathsValue)).toEqual({ removed: false });
  });

  it("removes an old installation that stored adminToken instead of hookToken", () => {
    const pathsValue = paths();
    const command = "legacy-owned-command";
    writeFileSync(pathsValue.hooksPath, JSON.stringify({ SessionEnd: [{ hooks: [{ type: "command", command }] }] }));
    writeFileSync(pathsValue.configPath, JSON.stringify({ url: "http://127.0.0.1:9", adminToken: "old-admin-token", command }));
    expect(removeFactoryHooks(pathsValue)).toEqual({ removed: true });
    expect(JSON.parse(readFileSync(pathsValue.hooksPath, "utf8"))).toEqual({});
    expect(existsSync(pathsValue.configPath)).toBe(false);
  });

  it("retains settings.json fallback hooks when creating the standalone file", () => {
    const pathsValue = paths();
    const original = { Stop: [{ hooks: [{ type: "command", command: "settings-fallback" }] }] };
    const settingsPath = join(pathsValue.hooksPath, "../settings.json");
    writeFileSync(settingsPath, JSON.stringify({ hooks: original, apiKey: "unrelated-sensitive-value" }));
    installFactoryHooks({ ...pathsValue, url: "http://localhost:1", hookToken: "private-admin-token" });
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
    expect(() => installFactoryHooks({ ...pathsValue, url: "http://127.0.0.1:18787", hookToken: "secret" })).toThrow("Invalid Factory hooks JSON");
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
    await expect(forwardFactoryHook({ url: "http://localhost:1", hookToken: "private-token" }, start, { fetch: send, eventId: "receipt" }))
      .resolves.toEqual({ additionalContext: "[factory-cc-session:opaque]", bindingToken: "a".repeat(64) });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1]!.body).toBe(send.mock.calls[1]![1]!.body);
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toEqual({ eventId: "receipt", event: start });
    expect(send.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: { authorization: "Bearer private-token" } });
  });

  it("carries generation ownership and supplies wrapper launch only for session lifecycle boundaries", async () => {
    const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
    const options = { fetch: send, eventId: "receipt", bindingToken: "a".repeat(64), launchId: "launch-owned" };
    const config = { url: "http://localhost:1", hookToken: "token" };
    await forwardFactoryHook(config, start, options);
    await forwardFactoryHook(config, { ...start, hook_event_name: "SessionEnd" }, options);
    await forwardFactoryHook(config, { ...start, hook_event_name: "UserPromptSubmit" }, options);
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toMatchObject({ bindingToken: options.bindingToken, launchId: options.launchId });
    const endEnvelope = JSON.parse(send.mock.calls[1]![1]!.body as string);
    expect(endEnvelope.bindingToken).toBe(options.bindingToken);
    expect(endEnvelope.launchId).toBe(options.launchId);
    expect(JSON.parse(send.mock.calls[2]![1]!.body as string)).not.toHaveProperty("launchId");
  });

  it("never silently drops a present empty binding into the missing-binding fallback", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await forwardFactoryHook({ url: "http://localhost:1", hookToken: "token" }, { ...start, hook_event_name: "SessionEnd" },
      { fetch: send, bindingToken: "", launchId: "owned-launch" });
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toMatchObject({ bindingToken: "", launchId: "owned-launch" });
  });

  it("runs the actual hook entrypoint for missing-binding client exit while rejecting other missing or malformed authority", async () => {
    const { configPath } = paths(); const received: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk.toString();
      received.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test listener");
    writeFileSync(configPath, JSON.stringify({ url: `http://127.0.0.1:${address.port}`, hookToken: "offline-hook-test-only" }));
    const invoke = async (hook: string, launchId?: string, bindingToken?: string) => {
      const env = { ...process.env }; delete env.BRIDGE_FACTORY_BINDING; delete env.BRIDGE_FACTORY_LAUNCH_ID;
      if (launchId !== undefined) env.BRIDGE_FACTORY_LAUNCH_ID = launchId;
      if (bindingToken !== undefined) env.BRIDGE_FACTORY_BINDING = bindingToken;
      const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/factory-hook.ts"), "--factory-cc-hook-config", configPath], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      const completed = new Promise<{ code: number | null; stderr: string }>((done, reject) => { child.once("error", reject); child.once("close", (code) => done({
        code,
        // Node prints this when the harness sets both NO_COLOR and FORCE_COLOR. It is not hook output.
        stderr: stderr.replace(/\(node:\d+\) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\.\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g, ""),
      })); });
      child.stdin.end(JSON.stringify({ ...start, hook_event_name: hook }));
      return completed;
    };
    try {
      expect(await invoke("SessionEnd", "owned-launch")).toEqual({ code: 0, stderr: "" });
      expect(received).toHaveLength(1); expect(received[0]).toMatchObject({ launchId: "owned-launch", event: { hook_event_name: "SessionEnd" } });
      expect(received[0]).not.toHaveProperty("bindingToken");
      expect(await invoke("SessionEnd")).toMatchObject({ code: 1, stderr: expect.stringContaining("npm run run-droid") });
      expect(await invoke("SessionEnd", "owned-launch", "")).toMatchObject({ code: 1 });
      expect(await invoke("UserPromptSubmit", "owned-launch")).toMatchObject({ code: 1 });
      expect(received).toHaveLength(1);
    } finally {
      server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("never converts a response for another event into model context", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, additionalContext: "ignore" })));
    await expect(forwardFactoryHook({ url: "http://localhost:1", hookToken: "token" }, { ...start, hook_event_name: "SessionEnd" }, { fetch: send })).resolves.toEqual({});
  });

  it("renews only UserPromptSubmit context without replacing the registered generation", async () => {
    const bindingToken = "b".repeat(64);
    const additionalContext = `[factory-cc-session:${bindingToken}]`;
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, additionalContext })));
    await expect(forwardFactoryHook({ url: "http://localhost:1", hookToken: "token" },
      { ...start, hook_event_name: "UserPromptSubmit" }, { fetch: send, bindingToken }))
      .resolves.toEqual({ additionalContext });
    expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toMatchObject({ bindingToken, event: { hook_event_name: "UserPromptSubmit" } });
  });

  it("fails closed on HTTP rejection and suppresses server contents", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-body", { status: 409 }));
    await expect(forwardFactoryHook({ url: "http://localhost:1", hookToken: "token" }, start, { fetch: send }))
      .rejects.toThrow("Factory lifecycle event was not accepted by the bridge");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid and oversized events before making a request", async () => {
    const send = vi.fn<typeof fetch>();
    const config = { url: "http://localhost:1", hookToken: "token" };
    await expect(forwardFactoryHook(config, { ...start, hook_event_name: "Unsupported" }, { fetch: send })).rejects.toThrow("Invalid Factory lifecycle");
    await expect(forwardFactoryHook(config, { ...start, extra: "x".repeat(4 * 1024 * 1024) }, { fetch: send })).rejects.toThrow("size limit");
    expect(send).not.toHaveBeenCalled();
  });
});
