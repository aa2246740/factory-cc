import { describe, expect, it } from "vitest";
import { redactHeaders, redactJson } from "../../src/security/redact.js";

describe("redaction", () => {
  it("strips authorization headers and key-shaped strings", () => {
    const headers = redactHeaders({ authorization: "Bearer sk-abc123456789", "x-api-key": "fk-secretsecret" });
    expect(headers.authorization).toBe("[redacted]");
    expect(headers["x-api-key"]).toBe("[redacted]");
    expect(JSON.stringify(redactJson({ note: "Bearer sk-abc123456789 extra" }))).not.toContain("sk-abc");
  });
  it("removes live Factory generation capabilities from logged prompt content", () => {
    const token = "a".repeat(64);
    const raw = { messages: [{ content: `before [factory-cc-session:${token}] after` }] };
    expect(redactJson(raw)).toEqual({ messages: [{ content: "before [factory-cc-session:redacted] after" }] });
    expect(raw.messages[0]!.content).toContain(token);
  });
});
