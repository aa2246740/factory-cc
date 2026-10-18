import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor, type DoctorSdk } from "../../scripts/doctor.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("doctor auth dry-run", () => {
  it("prints masked account info and does not read the prompt", async () => {
    let reads = 0;
    const sdk: DoctorSdk = {
      query(args) {
        const prompt = args.prompt as AsyncIterable<unknown> & { [Symbol.asyncIterator](): AsyncIterator<unknown> };
        const iterate = prompt[Symbol.asyncIterator].bind(prompt);
        prompt[Symbol.asyncIterator] = () => {
          const iterator = iterate();
          const next = iterator.next.bind(iterator);
          iterator.next = () => { reads += 1; return next(); };
          return iterator;
        };
        return {
          accountInfo: async () => ({ email: "ada@example.com", subscriptionType: "max", apiKeySource: "none", tokenSource: "claude.ai" }),
          close() {},
        };
      },
    };
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: unknown) => { lines.push(String(line ?? "")); });
    const code = await runDoctor(["--auth", "subscription"], { PATH: "/usr/bin", HOME: "/tmp/relay-doctor-home" }, { loadSdk: async () => sdk });
    expect(code).toBe(0);
    expect(reads).toBe(0);
    const report = JSON.parse(lines.at(-1) ?? "{}") as { email: string; classification: { kind: string }; promptSent: boolean; subscriptionType: string };
    expect(report.email).toBe("a***@example.com");
    expect(report.email).not.toContain("ada");
    expect(report.classification.kind).toBe("subscription");
    expect(report.subscriptionType).toBe("max");
    expect(report.promptSent).toBe(false);
    expect(lines.join("")).not.toContain("ada@example.com");
  });

  it("fails preflight without printing a secret or opening the SDK", async () => {
    const loadSdk = vi.fn(async () => { throw new Error("SDK must not load"); });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line?: unknown) => { errors.push(String(line ?? "")); });
    const secret = "offline-key-value-should-not-print";
    const code = await runDoctor(["--auth", "subscription"], { PATH: "/usr/bin", HOME: "/tmp/relay-doctor-home", ANTHROPIC_API_KEY: secret }, { loadSdk });
    expect(code).toBe(1);
    expect(loadSdk).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("ANTHROPIC_API_KEY");
    expect(errors.join("")).not.toContain(secret);
  });
  it.each(["helper", "gateway", "login", "unknown", "literal", "throw"])("runs claude-config dry-run offline for %s without yielding a prompt or leaking secrets", async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), "relay-doctor-config-"));
    const helper = "helper --offline-secret", literal = "offline-literal-never-use";
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...(kind === "helper" || kind === "throw" ? { apiKeyHelper: helper } : {}), env: {
      ...(kind === "gateway" ? { ANTHROPIC_BASE_URL: "https://offline.invalid/path?key=hidden" } : {}),
      ...(kind === "literal" ? { ANTHROPIC_API_KEY: literal } : {}), UNKNOWN_NAME: literal,
    }, hooks: {} }));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => { lines.push(String(value)); });
    vi.spyOn(console, "error").mockImplementation((value) => { lines.push(String(value)); });
    let options: Record<string, unknown> | undefined, prompt: AsyncIterable<unknown> | undefined;
    const close = vi.fn();
    const loadSdk = vi.fn(async (): Promise<DoctorSdk> => ({ query(args) {
      options = args.options; prompt = args.prompt;
      return { accountInfo: async () => {
        if (kind === "throw") throw new Error(helper);
        return kind === "login" ? { subscriptionType: "max" } : {};
      }, close };
    } }));
    try {
      const code = await runDoctor(["--auth", "claude-config"], { HOME: dir, CLAUDE_CONFIG_DIR: dir }, { loadSdk });
      const success = ["helper", "gateway", "login"].includes(kind);
      expect(code).toBe(success ? 0 : 1);
      const output = lines.join("\n");
      expect(output).not.toContain(helper); expect(output).not.toContain(literal); expect(output).not.toContain("?key=hidden");
      if (kind === "literal") { expect(loadSdk).not.toHaveBeenCalled(); return; }
      expect(options).toMatchObject({ settingSources: [], strictMcpConfig: true });
      if (kind === "helper") expect(options?.settings).toEqual({ apiKeyHelper: helper });
      expect(close).toHaveBeenCalledOnce();
      expect(JSON.parse(lines.at(-1)!)).toMatchObject({ promptSent: false });
      if (kind === "unknown") expect(output).toContain("Claude Code is not logged in.");
      if (success) expect(JSON.parse(lines.at(-1)!)).toMatchObject({ classification: { kind: kind === "login" ? "subscription" : "unknown" }, promptSent: false });
      let yielded = false;
      void prompt![Symbol.asyncIterator]().next().then(() => { yielded = true; });
      await Promise.resolve(); expect(yielded).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

});
