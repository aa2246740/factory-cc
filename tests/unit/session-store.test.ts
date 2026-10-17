import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("fails interrupted generations after restart and interrupts sessions parked on a tool that can no longer answer", () => {
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
    expect(loaded.require(waiting.bridgeSessionId)).toMatchObject({
      state: "IDLE", hostEnded: "interrupted", sdkSessionId: "sdk-waiting", pendingToolIds: [], endedToolIds: ["tool-a"],
      notes: ["bridge-restarted-while-waiting-for-tool"],
    });
    expect(loaded.list().filter((record) => ["NEW", "GENERATING", "WAITING_DROID_TOOL", "RESUMING"].includes(record.state))).toEqual([]);
    // Both slots are free again, and the interruption survives yet another restart.
    expect(() => { loaded.create(input); loaded.create(input); }).not.toThrow();
    expect(new SessionStore(dir, true, 2).require(waiting.bridgeSessionId)).toMatchObject({ state: "IDLE", hostEnded: "interrupted", pendingToolIds: [] });
  });

  it("frees every slot held by abandoned sessions after a restart, so new conversations are not refused", () => {
    const dir = temporaryDir();
    const store = new SessionStore(dir, true, 3);
    const abandoned = [1, 2, 3].map((n) => {
      const record = store.create(input);
      store.setState(record.bridgeSessionId, "GENERATING");
      store.update(record.bridgeSessionId, { pendingToolIds: [`tool-${n}`] });
      store.setState(record.bridgeSessionId, "WAITING_DROID_TOOL");
      return record.bridgeSessionId;
    });
    expect(() => store.create(input)).toThrowError(expect.objectContaining({ status: 429, code: "session_limit" }));
    const restarted = new SessionStore(dir, true, 3);
    expect(() => restarted.create(input)).not.toThrow();
    expect(restarted.list().filter((record) => abandoned.includes(record.bridgeSessionId)).map((record) => record.hostEnded)).toEqual(["interrupted", "interrupted", "interrupted"]);
  });

  it("interrupts only a session that is parked on a tool, releasing its slot and tool IDs", () => {
    const store = new SessionStore(temporaryDir(), false, 1);
    const record = store.create(input);
    store.setState(record.bridgeSessionId, "GENERATING");
    expect(store.interrupt(record.bridgeSessionId, "ignored")).toMatchObject({ state: "GENERATING", notes: [] });
    store.update(record.bridgeSessionId, { pendingToolIds: ["tool-a"] });
    store.setState(record.bridgeSessionId, "WAITING_DROID_TOOL");
    expect(() => store.create(input)).toThrowError(expect.objectContaining({ status: 429 }));
    expect(store.interrupt(record.bridgeSessionId, "tool-wait-expired")).toMatchObject({
      state: "IDLE", hostEnded: "interrupted", pendingToolIds: [], endedToolIds: ["tool-a"], notes: ["tool-wait-expired"],
    });
    expect(() => store.create(input)).not.toThrow();
    expect(() => store.interrupt("missing-session", "x")).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it.each([
    ["cancelled", (store: SessionStore, id: string) => store.setState(id, "CANCELLED")],
    ["failed", (store: SessionStore, id: string) => store.setState(id, "FAILED")],
    ["host-interrupted", (store: SessionStore, id: string) => store.update(id, { hostEnded: "interrupted" })],
    ["host-terminal", (store: SessionStore, id: string) => store.update(id, { hostEnded: "terminal" })],
  ])("releases the pending tool IDs of a session that ends (%s) but remembers them for retries", (_label, end) => {
    const store = new SessionStore(temporaryDir(), false, 2);
    const record = store.create(input);
    store.setState(record.bridgeSessionId, "GENERATING");
    store.update(record.bridgeSessionId, { pendingToolIds: ["tool-a", "tool-b"] });
    store.setState(record.bridgeSessionId, "WAITING_DROID_TOOL");
    expect(store.require(record.bridgeSessionId).pendingToolIds).toEqual(["tool-a", "tool-b"]);
    end(store, record.bridgeSessionId);
    expect(store.require(record.bridgeSessionId)).toMatchObject({ pendingToolIds: [], endedToolIds: ["tool-a", "tool-b"] });
  });

  it("does not let an ended session reclaim tool IDs when a late turn result is stored", () => {
    const store = new SessionStore(temporaryDir(), false, 2);
    const record = store.create(input);
    store.setState(record.bridgeSessionId, "GENERATING");
    store.update(record.bridgeSessionId, { hostEnded: "interrupted" });
    store.update(record.bridgeSessionId, { pendingToolIds: ["late-tool"] });
    expect(store.require(record.bridgeSessionId)).toMatchObject({ pendingToolIds: [], endedToolIds: ["late-tool"] });
  });

  describe("a damaged sessions.jsonl", () => {
    const lines = (file: string) => readFileSync(file, "utf8").split("\n");

    it("skips a half-written line in the middle, keeps every other record and logs only its position", () => {
      const dir = temporaryDir();
      const file = join(dir, "sessions.jsonl");
      const store = new SessionStore(dir, true, 8);
      const [a, b, c] = ["alpha", "bravo", "charlie"].map((model) => store.create({ ...input, model }));
      const damaged = lines(file).map((line, index) => index === 1 ? line.slice(0, 40) : line).join("\n");
      expect(damaged).toContain(b!.bridgeSessionId.slice(0, 8));
      writeFileSync(file, damaged);

      const warn = vi.fn();
      const loaded = new SessionStore(dir, true, 8, { warn });
      expect(loaded.list().map((record) => record.bridgeSessionId).sort()).toEqual([a!.bridgeSessionId, c!.bridgeSessionId].sort());
      expect(warn).toHaveBeenCalledExactlyOnceWith("session_store_corrupt_line", { line: 2, length: 40 });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("bravo");
    });

    it("skips lines that parse but are not session records", () => {
      const dir = temporaryDir();
      const file = join(dir, "sessions.jsonl");
      const record = new SessionStore(dir, true, 8).create(input);
      writeFileSync(file, ["123", "null", '{"other":true}', readFileSync(file, "utf8").trim()].join("\n"));
      const warn = vi.fn();
      expect(new SessionStore(dir, true, 8, { warn }).list().map((item) => item.bridgeSessionId)).toEqual([record.bridgeSessionId]);
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it("starts the next append on its own line when the file ends in a partial record", () => {
      const dir = temporaryDir();
      const file = join(dir, "sessions.jsonl");
      const store = new SessionStore(dir, true, 8);
      const first = store.create(input);
      appendFileSync(file, '{"bridgeSessionId":"half-wri');
      const second = store.create(input);
      const written = lines(file).filter(Boolean);
      expect(written.at(-1)).toBe(JSON.stringify(second));
      expect(written.filter((line) => { try { JSON.parse(line); return false; } catch { return true; } })).toEqual(['{"bridgeSessionId":"half-wri']);
      expect(new SessionStore(dir, true, 8).list().map((record) => record.bridgeSessionId).sort())
        .toEqual([first.bridgeSessionId, second.bridgeSessionId].sort());
    });

    it("terminates a partial last line at startup too, before the first new record", () => {
      const dir = temporaryDir();
      const file = join(dir, "sessions.jsonl");
      const record = new SessionStore(dir, true, 8).create(input);
      writeFileSync(file, `${readFileSync(file, "utf8")}{"bridgeSessionId":"torn`);
      const reopened = new SessionStore(dir, true, 8);
      expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
      const next = reopened.create(input);
      expect(lines(file).filter(Boolean).map((line) => JSON.parse(line).bridgeSessionId)).toEqual([record.bridgeSessionId, next.bridgeSessionId]);
    });
  });

  it("compacts the append-only log to one record per session at startup, privately and atomically", () => {
    const dir = temporaryDir();
    const file = join(dir, "sessions.jsonl");
    const store = new SessionStore(dir, true, 8);
    const record = store.create(input);
    store.setState(record.bridgeSessionId, "GENERATING");
    store.setState(record.bridgeSessionId, "IDLE");
    store.create(input);
    expect(readFileSync(file, "utf8").trim().split("\n").length).toBeGreaterThan(2);
    const loaded = new SessionStore(dir, true, 8);
    const rewritten = readFileSync(file, "utf8").trim().split("\n");
    expect(rewritten.map((line) => JSON.parse(line)).map((item) => item.bridgeSessionId)).toEqual(loaded.list().map((item) => item.bridgeSessionId));
    expect(rewritten).toHaveLength(2);
    loaded.setState(record.bridgeSessionId, "GENERATING");
    for (const name of ["sessions.jsonl", "sessions-snapshot.json"]) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves the log untouched when it cannot be read, instead of compacting over it", () => {
    const dir = temporaryDir();
    const file = join(dir, "sessions.jsonl");
    mkdirSync(file);
    expect(() => new SessionStore(dir, true, 8)).not.toThrow();
    expect(statSync(file).isDirectory()).toBe(true);
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
