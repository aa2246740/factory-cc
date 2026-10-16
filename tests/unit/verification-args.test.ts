import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveVerificationSummary, verificationArgs } from "../../scripts/verification-args.js";
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe("real verification CLI evidence arguments", () => {
  it("provides a pure help parse without any environment requirement", () => {
    expect(verificationArgs(["--help"])).toEqual({ help: true });
    expect(verificationArgs([])).toEqual({ help: false });
  });
  it("rejects unknown, duplicate and missing arguments", () => {
    for (const args of [["--pretend-pass"], ["--summary"], ["--summary", "--help"], ["--summary", "a.json", "--summary", "b.json"]]) {
      expect(() => verificationArgs(args)).toThrow();
    }
  });
  it("preserves earlier evidence even when a path is created after argument validation", () => {
    const directory = mkdtempSync(join(tmpdir(), "verify-args-")); paths.push(directory);
    const path = join(directory, "evidence.json");
    expect(verificationArgs(["--summary", path]).summary).toBe(path);
    writeFileSync(path, "old failure\n");
    expect(() => verificationArgs(["--summary", path])).toThrow(/will not be overwritten/);
    expect(() => saveVerificationSummary(path, { status: "PASS" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe("old failure\n");
  });
});
