import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeContextEvidence } from "../../scripts/verify-factory-context.js";

describe("Factory context evidence retention", () => {
  it("never replaces a summary created while a long-running verification was active", () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-context-evidence-"));
    try {
      const path = join(directory, "summary.json");
      writeFileSync(path, "earlier independent evidence\n");
      expect(() => writeContextEvidence(path, { status: "PASS" }, [], true)).toThrowError(expect.objectContaining({ code: "EEXIST" }));
      expect(readFileSync(path, "utf8")).toBe("earlier independent evidence\n");
    } finally { rmSync(directory, { recursive: true }); }
  });

  it("creates new private evidence with exact authorized secrets removed", () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-context-evidence-"));
    try {
      const path = join(directory, "summary.json");
      writeContextEvidence(path, { detail: "echo opaque-secret-fixture" }, ["opaque-secret-fixture"], true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ detail: "echo [redacted]" });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally { rmSync(directory, { recursive: true }); }
  });
});
