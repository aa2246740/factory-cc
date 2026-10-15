import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readToolFreeSessionActivity } from "../../scripts/e2e-mission.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function evidence(deniedSession?: string) {
  const dir = mkdtempSync(join(tmpdir(), "relay-e2e-evidence-"));
  dirs.push(dir);
  const native = join(dir, "isolated-claude-config", "projects");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(dir, "requests.jsonl"), JSON.stringify({ session: "helper", body: { tools: [] } }));
  writeFileSync(join(native, "native-helper.jsonl"), [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "call-edit", name: "Edit" }] } },
    // An error result alone cannot prove a tool did not execute side effects.
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-edit", is_error: true, content: "failed" }] } },
  ].map((row) => JSON.stringify(row)).join("\n"));
  if (deniedSession) writeFileSync(join(dir, "bridge.jsonl"), JSON.stringify({ level: "info", event: "host_tool_access_denied",
    data: { sessionId: deniedSession, toolUseId: "call-edit", toolName: "Edit" } }));
  return readToolFreeSessionActivity(join(dir, "requests.jsonl"), join(dir, "isolated-claude-config"), [
    { bridgeSessionId: "helper", sdkSessionId: "native-helper" },
  ]);
}

describe("Mission helper capability evidence", () => {
  it("accepts a tool attempt only with the exact pre-execution denial receipt", () => {
    const [session] = evidence("helper");
    expect(session?.transcriptFound).toBe(true);
    expect(session?.nativeToolCalls).toEqual([{ id: "call-edit", name: "Edit", denied: true }]);
  });

  it("does not mistake an error result or another session's denial for safe execution", () => {
    expect(evidence()[0]?.nativeToolCalls[0]?.denied).toBe(false);
    expect(evidence("different-session")[0]?.nativeToolCalls[0]?.denied).toBe(false);
  });
});
