import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/sessions/store.js";
import { historyMessageHashes, resolveSession, sessionContextHash } from "../../src/sessions/correlate.js";
import type { Message, MessagesRequest } from "../../src/types.js";

const dirs: string[] = [];
function temporaryDir() {
  const dir = mkdtempSync(join(tmpdir(), "relay-session-test-"));
  dirs.push(dir);
  return dir;
}
const input = { role: "chat" as const, model: "test-model", toolNames: [] };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("session capacity and durable identity", () => {
  it("supports more than 16 completed conversations without exhausting active capacity", () => {
    const store = new SessionStore(temporaryDir(), false, 1);
    for (let i = 0; i < 20; i += 1) {
      const record = store.create(input);
      store.setState(record.bridgeSessionId, "GENERATING");
      store.setState(record.bridgeSessionId, "IDLE");
    }
    expect(store.list()).toHaveLength(20);
    expect(() => store.create(input)).not.toThrow();
  });

  it("keeps a pending tool conversation active and never evicts it to admit another request", () => {
    const store = new SessionStore(temporaryDir(), false, 1);
    const waiting = store.create(input);
    store.setState(waiting.bridgeSessionId, "GENERATING");
    store.update(waiting.bridgeSessionId, { pendingToolIds: ["tool-a"] });
    store.setState(waiting.bridgeSessionId, "WAITING_DROID_TOOL");
    expect(() => store.create(input)).toThrowError(expect.objectContaining({ status: 429, code: "session_limit" }));
    expect(store.require(waiting.bridgeSessionId).pendingToolIds).toEqual(["tool-a"]);
  });

  it("also enforces the active limit when resuming an idle session", () => {
    const store = new SessionStore(temporaryDir(), false, 1);
    const idle = store.create(input);
    store.setState(idle.bridgeSessionId, "GENERATING");
    store.setState(idle.bridgeSessionId, "IDLE");
    const active = store.create(input);
    expect(() => store.setState(idle.bridgeSessionId, "GENERATING")).toThrowError(expect.objectContaining({ status: 429 }));
    expect(store.require(idle.bridgeSessionId).state).toBe("IDLE");
    store.setState(active.bridgeSessionId, "CANCELLED");
    expect(() => store.setState(idle.bridgeSessionId, "GENERATING")).not.toThrow();
  });

  it("persists the SDK session and transcript fingerprints for a completed conversation", () => {
    const dir = temporaryDir();
    const store = new SessionStore(dir, true, 2);
    const record = store.create({ ...input, droidSessionId: "droid-a", contextHash: "context-fingerprint", requestMessageHashes: ["request-fingerprint"] });
    store.setState(record.bridgeSessionId, "GENERATING");
    store.update(record.bridgeSessionId, { sdkSessionId: "sdk-native-session", historyMessageHashes: ["request-fingerprint", "response-fingerprint"] });
    store.setState(record.bridgeSessionId, "IDLE");
    const loaded = new SessionStore(dir, true, 2).require(record.bridgeSessionId);
    expect(loaded).toMatchObject({ state: "IDLE", sdkSessionId: "sdk-native-session", contextHash: "context-fingerprint", requestMessageHashes: ["request-fingerprint"], historyMessageHashes: ["request-fingerprint", "response-fingerprint"] });
    expect(JSON.parse(readFileSync(join(dir, "sessions-snapshot.json"), "utf8"))[0].sdkSessionId).toBe("sdk-native-session");
  });

  it("keeps native session continuity after restart when Droid host context and catalog change", () => {
    const dir = temporaryDir();
    const store = new SessionStore(dir, true, 1);
    const headers = { "x-bridge-role": "chat" };
    const cwd = "/tmp/project-a";
    const request: MessagesRequest = {
      model: input.model, max_tokens: 16, system: "Mission status: planning.",
      messages: [{ role: "user", content: "Remember Pine." }],
    };
    const completed: Message[] = [...request.messages, { role: "assistant", content: "Remembered." }];
    const record = store.create({
      ...input, droidSessionId: "droid-a", contextHash: sessionContextHash(headers, request, cwd),
      requestMessageHashes: historyMessageHashes(request.messages),
    });
    store.setState(record.bridgeSessionId, "GENERATING");
    store.update(record.bridgeSessionId, { sdkSessionId: "sdk-a", historyMessageHashes: historyMessageHashes(completed) });
    store.setState(record.bridgeSessionId, "IDLE");
    const loaded = new SessionStore(dir, true, 1);
    const next: MessagesRequest = {
      ...request, system: "Mission status: testing.",
      tools: [{ name: "StartMission", input_schema: { type: "object" } }],
      messages: [...completed, { role: "user", content: "What did I ask you to remember?" }],
    };
    expect(resolveSession(loaded.list(), headers, next, { cwd }).match)
      .toMatchObject({ bridgeSessionId: record.bridgeSessionId, sdkSessionId: "sdk-a" });
    expect(resolveSession(loaded.list(), { ...headers, "x-bridge-session": "droid-a" }, next, { cwd }).match)
      .toMatchObject({ bridgeSessionId: record.bridgeSessionId, sdkSessionId: "sdk-a" });
  });

  it("fails interrupted generations after restart and retains pending tool ownership", () => {
    const dir = temporaryDir();
    const store = new SessionStore(dir, true, 2);
    const interrupted = store.create(input);
    store.setState(interrupted.bridgeSessionId, "GENERATING");
    store.update(interrupted.bridgeSessionId, { sdkSessionId: "sdk-interrupted" });
    const waiting = store.create(input);
    store.setState(waiting.bridgeSessionId, "GENERATING");
    store.update(waiting.bridgeSessionId, { sdkSessionId: "sdk-waiting", pendingToolIds: ["tool-a"] });
    store.setState(waiting.bridgeSessionId, "WAITING_DROID_TOOL");
    const loaded = new SessionStore(dir, true, 2);
    expect(loaded.require(interrupted.bridgeSessionId)).toMatchObject({ state: "FAILED", sdkSessionId: "sdk-interrupted", notes: ["bridge-restarted-during-generation"] });
    expect(loaded.require(waiting.bridgeSessionId)).toMatchObject({ state: "WAITING_DROID_TOOL", sdkSessionId: "sdk-waiting", pendingToolIds: ["tool-a"] });
    expect(() => loaded.create(input)).not.toThrow();
    expect(() => loaded.create(input)).toThrowError(expect.objectContaining({ status: 429 }));
  });

  it("persists completed and interrupted host endings without reviving their native transcript", () => {
    const dir = temporaryDir();
    const store = new SessionStore(dir, true, 2);
    const request: MessagesRequest = { model: input.model, max_tokens: 10, messages: [{ role: "user", content: "finish the feature" }] };
    const completed: Message[] = [...request.messages, { role: "assistant", content: "finished" }];
    const headers = { "x-bridge-role": "chat" };
    for (const hostEnded of ["terminal", "interrupted"] as const) {
      const record = store.create({ ...input, contextHash: sessionContextHash(headers, request, "/tmp/project") });
      store.setState(record.bridgeSessionId, "GENERATING");
      store.update(record.bridgeSessionId, { sdkSessionId: `native-${hostEnded}`, hostEnded, historyMessageHashes: historyMessageHashes(completed) });
      store.setState(record.bridgeSessionId, "IDLE");
    }
    const loaded = new SessionStore(dir, true, 2);
    expect(loaded.list().map((record) => record.hostEnded)).toEqual(["terminal", "interrupted"]);
    expect(resolveSession(loaded.list(), headers, { ...request, messages: [...completed, { role: "user", content: "continue" }] }, { cwd: "/tmp/project" }).match).toBeUndefined();
  });
});
