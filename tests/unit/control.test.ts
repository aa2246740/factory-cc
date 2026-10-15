import { createHash } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { controlBaseUrl, runControl } from "../../scripts/control.js";
import { controlPageHeaders, controlPageHtml } from "../../src/http/control-page.js";

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function localServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}`;
}

describe("local approval CLI", () => {
  it("sends one authenticated decision with the user's exact edited input", async () => {
    const received: unknown[] = [];
    const url = await localServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      received.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
      res.end('{"ok":true}');
    });
    const directory = mkdtempSync(join(tmpdir(), "bridge-control-"));
    directories.push(directory);
    const file = join(directory, "input.json");
    writeFileSync(file, JSON.stringify({ command: "echo 'explicit input'", timeout: 100 }));
    expect(await runControl(["approve", "a/b c", "--input", file], { BRIDGE_ADMIN_TOKEN: "test-secret", BRIDGE_CONTROL_URL: url })).toEqual({ ok: true });
    expect(received).toEqual([{
      method: "POST", path: "/internal/approvals/a%2Fb%20c", authorization: "Bearer test-secret",
      body: { decision: "allow", updatedInput: { command: "echo 'explicit input'", timeout: 100 } },
    }]);
  });

  it("does not follow redirects or retry a decision after an uncertain response", async () => {
    let externalRequests = 0;
    let requests = 0;
    const redirectedUrl = await localServer((_req, res) => { externalRequests += 1; res.end('{}'); });
    const url = await localServer((_req, res) => {
      requests += 1;
      res.writeHead(307, { Location: redirectedUrl });
      res.end();
    });
    await expect(runControl(["approve", "once"], { BRIDGE_ADMIN_TOKEN: "never-log-this-token", BRIDGE_CONTROL_URL: url })).rejects.toThrow("list requests before retrying");
    expect(requests).toBe(1);
    expect(externalRequests).toBe(0);
  });

  it("keeps server error contents and credentials out of error output", async () => {
    let requests = 0;
    const url = await localServer((_req, res) => {
      requests += 1;
      res.writeHead(409);
      res.end('{"error":"private-server-output test-secret"}');
    });
    let message = "";
    try { await runControl(["deny", "already-done"], { BRIDGE_ADMIN_TOKEN: "test-secret", BRIDGE_CONTROL_URL: url }); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain("already handled");
    expect(message).not.toMatch(/private-server-output|test-secret/);
    expect(requests).toBe(1);
  });

  it("rejects nonlocal origins and token-bearing URLs before making a request", () => {
    for (const url of ["https://example.com", "http://localhost.evil.test", "file:///tmp/test", "http://127.0.0.1:18787/a", "http://token@localhost", "http://localhost?token=secret", "http://localhost#secret"]) {
      expect(() => controlBaseUrl(url)).toThrow(/local HTTP\(S\) origin/);
    }
    expect(controlBaseUrl(undefined)).toBe("http://127.0.0.1:18787");
    expect(controlBaseUrl("http://[::1]:1234")).toBe("http://[::1]:1234");
  });

  it("requires valid explicit commands, credentials, and JSON objects", async () => {
    await expect(runControl(["approve", "id"], {})).rejects.toThrow("BRIDGE_ADMIN_TOKEN is required");
    await expect(runControl(["approve", "id", "--token", "secret"], {})).rejects.toThrow("Invalid arguments");
    await expect(runControl(["cancel", "id", "extra"], {})).rejects.toThrow("exactly one session");
    const directory = mkdtempSync(join(tmpdir(), "bridge-control-"));
    directories.push(directory);
    const file = join(directory, "input.json");
    writeFileSync(file, '[]');
    await expect(runControl(["approve", "id", "--input", file], {})).rejects.toThrow("JSON object");
  });
});

// A small browser model makes the security and async behavior observable without
// evaluating HTML. Assignment to innerHTML deliberately throws in these tests.
class Element {
  children: Element[] = [];
  parent?: Element;
  textContent = "";
  value = "";
  className = "";
  hidden = false;
  disabled = false;
  open = false;
  listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();
  constructor(readonly tagName: string) {}
  set innerHTML(_value: string) { throw new Error("untrusted HTML insertion"); }
  append(...elements: Element[]): void { for (const element of elements) { element.parent = this; this.children.push(element); } }
  replaceChildren(...elements: Element[]): void { this.children = []; this.append(...elements); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  addEventListener(type: string, callback: (event: { preventDefault(): void }) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  fire(type: string): void { for (const callback of this.listeners.get(type) ?? []) callback({ preventDefault() {} }); }
  descendants(): Element[] { return [this, ...this.children.flatMap((child) => child.descendants())]; }
}

function browser(fetcher: typeof fetch) {
  const ids = new Map(["status", "token", "approvals", "sessions", "workspace", "login", "updated", "refresh", "lock"].map((id) => [id, new Element(id)]));
  const window = new Element("window") as Element & { confirm(): boolean };
  window.confirm = () => true;
  const intervals: Array<() => void> = [];
  const html = controlPageHtml();
  const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
  if (!script) throw new Error("missing script");
  new Script(script).runInNewContext({
    document: { getElementById: (id: string) => ids.get(id), createElement: (tag: string) => new Element(tag) },
    window, fetch: fetcher, AbortSignal,
    setInterval: (callback: () => void) => { intervals.push(callback); return intervals.length; },
    clearInterval: () => {},
  });
  const get = (id: string): Element => ids.get(id)!;
  const connect = (token: string): void => { get("token").value = token; get("login").fire("submit"); };
  return { get, connect, intervals };
}

const settle = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

describe("approval control page", () => {
  it("only permits its fixed script and stylesheet, and cannot be framed or cached", () => {
    const html = controlPageHtml();
    const headers = controlPageHeaders();
    for (const tag of ["script", "style"]) {
      const source = html.match(new RegExp(`<${tag}>([\\s\\S]+)</${tag}>`))?.[1];
      expect(source).toBeTruthy();
      expect(headers["Content-Security-Policy"]).toContain(`'sha256-${createHash("sha256").update(source!).digest("base64")}'`);
    }
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).not.toContain("unsafe-inline");
    expect(headers["Cache-Control"]).toBe("no-store");
  });

  it("renders hostile tool text inertly and sends a double-clicked approval only once", async () => {
    const input = { command: "<img src=x onerror=alert(1)>" };
    let pending = true;
    const mutations: Array<{ path: string; body: unknown }> = [];
    const fetcher = vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toHaveProperty("Authorization", "Bearer memory-token");
      if (init?.method === "POST") {
        mutations.push({ path: String(path), body: JSON.parse(String(init.body)) });
        pending = false;
        return Response.json({ ok: true });
      }
      return Response.json(String(path).endsWith("approvals")
        ? { approvals: pending ? [{ id: "id/with slash", bridgeSessionId: "s1", toolName: "<script>bad</script>", input, expiresAt: "2099-01-01" }] : [] }
        : { sessions: [] });
    });
    const ui = browser(fetcher as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
    ui.connect("memory-token");
    await settle();
    expect(ui.get("token").value).toBe("");
    const nodes = ui.get("approvals").descendants();
    expect(nodes.find((node) => node.tagName === "h3")?.textContent).toBe("<script>bad</script>");
    expect(nodes.find((node) => node.tagName === "pre")?.textContent).toContain(input.command);
    const allow = nodes.find((node) => node.textContent === "允许一次")!;
    allow.fire("click");
    allow.fire("click");
    await settle();
    expect(mutations).toEqual([{ path: "/internal/approvals/id%2Fwith%20slash", body: { decision: "allow" } }]);
    ui.get("lock").fire("click");
    expect(ui.get("approvals").children).toHaveLength(0);
    expect(ui.get("sessions").children).toHaveLength(0);
    const count = fetcher.mock.calls.length;
    for (const tick of ui.intervals) tick();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(count);
  });

  it("discards authenticated responses arriving after the user locks the page", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = vi.fn(async (path: string | URL | Request) => {
      await gate;
      return Response.json(String(path).endsWith("approvals")
        ? { approvals: [{ id: "late", bridgeSessionId: "s1", toolName: "Bash", input: {}, expiresAt: "2099-01-01" }] }
        : { sessions: [] });
    });
    const ui = browser(fetcher as typeof fetch);
    ui.connect("memory-token");
    ui.get("lock").fire("click");
    release();
    await settle();
    expect(ui.get("workspace").hidden).toBe(true);
    expect(ui.get("approvals").children).toHaveLength(0);
  });
});
