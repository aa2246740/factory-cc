import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessions/store.js";
import { UsageLedger } from "../../src/runtime/usage.js";
import { ToolMailbox } from "../../src/relay/mailbox.js";

it("prunes ended and old idle sessions, preserving pending work and protected resumable sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-retention-"));
  const store = new SessionStore(dir, true, 32, undefined, { maxRecords: 2, maxAgeMs: 100, journalMaxBytes: 8000 });
  const create = () => store.create({ role: "chat", model: "relay", toolNames: [] });
  const ended = create(); store.setState(ended.bridgeSessionId, "FAILED");
  const idle = create(); store.setState(idle.bridgeSessionId, "IDLE");
  const pending = create(); store.update(pending.bridgeSessionId, { pendingToolIds: ["tool"] }); store.setState(pending.bridgeSessionId, "WAITING_DROID_TOOL");
  const protectedSession = create(); store.setState(protectedSession.bridgeSessionId, "IDLE");
  const removed = store.prune(new Set([protectedSession.bridgeSessionId]), Date.now() + 1000);
  expect(removed.sort()).toEqual([ended.bridgeSessionId, idle.bridgeSessionId].sort());
  expect(store.list().map((s) => s.bridgeSessionId).sort()).toEqual([pending.bridgeSessionId, protectedSession.bridgeSessionId].sort());
  expect(readFileSync(join(dir, "sessions.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
});
it("periodically compacts session updates rather than appending forever", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-journal-"));
  const store = new SessionStore(dir, true, 4, undefined, { maxRecords: 10, maxAgeMs: 1000, journalMaxBytes: 3000 });
  const session = store.create({ role: "chat", model: "relay", toolNames: [] });
  for (let index = 0; index < 400; index++) store.update(session.bridgeSessionId, { sdkSessionId: `checkpoint-${index}` });
  expect(statSync(join(dir, "sessions.jsonl")).size).toBeLessThan(4000);
  expect(new SessionStore(dir, true, 4).get(session.bridgeSessionId)?.sdkSessionId).toBe("checkpoint-399");
});
it("bounds usage identities while retaining cumulative counters and declaring the dedupe window", () => {
  const ledger = new UsageLedger();
  for (let index = 0; index < 8000; index++) ledger.ingest({ type: "assistant", session_id: "native", message: { id: `message-${index}`, usage: { input_tokens: 1, output_tokens: 2 } } });
  expect(ledger.providerTotals()).toMatchObject({ input_tokens: 8000, output_tokens: 16000 });
  expect(ledger.drainTurnUsage()).toMatchObject({ input_tokens: 8000, output_tokens: 16000, modelRequests: 8000, estimated: true, coverage: "partial" });
  expect(ledger.drainTurnUsage()).toMatchObject({ input_tokens: 0, output_tokens: 0, modelRequests: 0 });
});
it("bounds completed mailbox payloads but never removes a pending callback", async () => {
  const mailbox = new ToolMailbox();
  for (let i = 0; i < 400; i++) {
    mailbox.registerCall({ callId: String(i), originalName: "tool", mcpName: "tool", input: {} });
    mailbox.submitResult({ callId: String(i), content: "large result" });
    await mailbox.wait(String(i), 1000);
  }
  mailbox.registerCall({ callId: "pending", originalName: "tool", mcpName: "tool", input: {} });
  expect(mailbox.pruneCompleted()).toHaveLength(144);
  expect(mailbox.getCall("0")).toBeUndefined();
  expect(mailbox.hasCall("pending")).toBe(true);
  expect(mailbox.hasCall("399")).toBe(true);
});
