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
});
