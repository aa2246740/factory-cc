import { describe, expect, it } from "vitest";
import { explicitSessionId, historyMessageHashes, resolveSession, sessionContextHash } from "../../src/sessions/correlate.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { Message, MessagesRequest } from "../../src/types.js";

const headers = { "x-bridge-role": "chat" };
const cwd = "/tmp/project-a";
const initial: MessagesRequest = {
  model: "relay-probe", max_tokens: 100,
  system: "stable system",
  tools: [{ name: "Read", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "Remember the release codename: Pine." }],
};
const completed: Message[] = [...initial.messages, { role: "assistant", content: [{ type: "text", text: "I will remember Pine." }] }];
const continuation: MessagesRequest = { ...initial, messages: [...completed, { role: "user", content: "What was the codename?" }] };
const catalogChanges: Array<[string, NonNullable<MessagesRequest["tools"]>]> = [
  ["added tools", [...initial.tools!, { name: "StartMission", input_schema: { type: "object" } }]],
  ["removed tools", []],
  ["changed schemas", [{ name: "Read", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }]],
  ["changed descriptions", [{ ...initial.tools![0]!, description: "Read a file in the current Mission." }]],
];

function session(patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    bridgeSessionId: "bridge-a", droidSessionId: "droid-a", sdkSessionId: "sdk-a", role: "chat",
    state: "IDLE", model: initial.model, toolNames: ["Read"],
    contextHash: sessionContextHash(headers, initial, cwd),
    requestMessageHashes: historyMessageHashes(initial.messages),
    historyMessageHashes: historyMessageHashes(completed),
    createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [],
    usage: { input_tokens: 0, output_tokens: 0, estimated: true }, ...patch,
  };
}

function resolve(sessions: SessionRecord[], request = continuation, extraHeaders = {}) {
  return resolveSession(sessions, { ...headers, ...extraHeaders }, request, { cwd });
}

describe("conversation continuity and isolation", () => {
  it("continues a completed transcript without requiring an explicit ID", () => {
    const record = session();
    expect(resolve([record])).toMatchObject({ match: record, reason: "history-prefix" });
    expect(resolve([record]).match?.sdkSessionId).toBe("sdk-a");
  });

  it("keeps the selected native session when Droid updates its host context", () => {
    const record = session();
    const next: MessagesRequest = {
      ...continuation,
      system: [{ type: "text", text: "New Mission state: tests passed; continue with review." }],
    };
    expect(resolve([record], next, { "x-bridge-session": "droid-a" }))
      .toMatchObject({ match: record, reason: "explicit-id" });
  });

  it("continues a unique complete transcript when host context changes without an explicit ID", () => {
    const record = session();
    expect(resolve([record], { ...continuation, system: "Updated environment and Mission state." }))
      .toMatchObject({ match: record, reason: "history-prefix" });
  });

  it("does not use changed host context to guess between identical transcripts", () => {
    const next = { ...continuation, system: "New Mission state." };
    const other = session({ bridgeSessionId: "bridge-b", droidSessionId: "droid-b" });
    expect(() => resolve([session(), other], next))
      .toThrowError(expect.objectContaining({ status: 409, code: "ambiguous_session" }));
    expect(resolve([session()], { ...initial, system: next.system }).match).toBeUndefined();
  });

  it("continues pending tool ownership when host context changes", () => {
    const record = session({ state: "WAITING_DROID_TOOL", pendingToolIds: ["tool-a"] });
    const request: MessagesRequest = {
      ...initial,
      system: "Tool state updated.",
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool-a", content: "passed" }] }],
    };
    expect(resolve([record], request)).toMatchObject({ match: record, reason: "tool-use-id" });
  });

  it("does not attach a repeated first prompt to an idle conversation", () => {
    expect(resolve([session()], initial).match).toBeUndefined();
  });

  it("does not match only a common opening user prompt", () => {
    const fork: MessagesRequest = { ...continuation, messages: [initial.messages[0]!, { role: "assistant", content: "A different reply." }, continuation.messages[2]!] };
    expect(resolve([session()], fork).match).toBeUndefined();
  });

  it("rejects ambiguous transcripts instead of choosing whichever session was created first", () => {
    expect(() => resolve([session(), session({ bridgeSessionId: "bridge-b", droidSessionId: "droid-b" })]))
      .toThrowError(expect.objectContaining({ status: 409, code: "ambiguous_session" }));
  });

  it("gives an explicit ID priority over an otherwise ambiguous transcript", () => {
    expect(resolve([session(), session({ bridgeSessionId: "bridge-b", droidSessionId: "droid-b" })], continuation, { "x-bridge-session": "droid-b" }).match?.bridgeSessionId).toBe("bridge-b");
  });

  it("starts a separate session for a new explicit ID even when its transcript matches", () => {
    expect(resolve([session()], continuation, { "x-bridge-session": "new-conversation" }).match).toBeUndefined();
  });

  it("does not treat metadata.user_id as a conversation ID", () => {
    expect(explicitSessionId({}, { ...initial, metadata: { user_id: "shared-user" } })).toBeUndefined();
    expect(explicitSessionId({}, { ...initial, metadata: { user_id: "shared-user", session_id: "actual-session" } })).toBe("actual-session");
  });

  it.each([
    ["model", { ...continuation, model: "other-model" }],
    ["thinking configuration", { ...continuation, thinking: { type: "enabled", budget_tokens: 1024 } }],
  ])("isolates a changed %s and refuses to mutate an explicitly selected session", (_name, request) => {
    expect(resolve([session()], request).match).toBeUndefined();
    expect(() => resolve([session()], request, { "x-bridge-session": "bridge-a" }))
      .toThrowError(expect.objectContaining({ status: 409, code: "session_context_changed" }));
  });

  it("preserves native history when the host changes a per-request no-tools restriction", () => {
    const record = session();
    expect(resolve([record], { ...continuation, tool_choice: { type: "none" } }, { "x-bridge-session": "droid-a" }).match).toBe(record);
  });

  it("uses authenticated Factory identity to isolate identical concurrent prompts and histories", () => {
    const record = session({ state: "GENERATING", factorySessionId: "host-a", factoryCwd: cwd, historyMessageHashes: undefined });
    expect(resolveSession([record], headers, initial, { cwd, hostSessionId: "host-b" }).match).toBeUndefined();
    const completedRecord = session({ factorySessionId: "host-a", factoryCwd: cwd });
    expect(resolveSession([completedRecord], headers, continuation, { cwd, hostSessionId: "host-b" }).match).toBeUndefined();
    expect(resolveSession([completedRecord], headers, continuation, { cwd, hostSessionId: "host-a" }).match).toBe(completedRecord);
    expect(() => resolveSession([completedRecord], { ...headers, "x-bridge-session": "droid-a" }, continuation, { cwd, hostSessionId: "host-b" }))
      .toThrowError(expect.objectContaining({ code: "cross_host_session" }));
  });

  it.each(catalogChanges)("keeps an explicitly selected native session with %s", (_label, tools) => {
    const record = session();
    expect(resolve([record], { ...continuation, tools }, { "x-bridge-session": "droid-a" }))
      .toMatchObject({ match: record, reason: "explicit-id" });
  });

  it.each(catalogChanges)("continues a unique complete history with %s", (_label, tools) => {
    const record = session();
    expect(resolve([record], { ...continuation, tools }))
      .toMatchObject({ match: record, reason: "history-prefix" });
  });

  it.each(catalogChanges)("preserves pending tool ownership with %s", (_label, tools) => {
    const record = session({ state: "WAITING_DROID_TOOL", pendingToolIds: ["tool-a"] });
    const request: MessagesRequest = {
      ...initial, tools,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool-a", content: "ToolSearch loaded the Mission tools." }] }],
    };
    expect(resolve([record], request)).toMatchObject({ match: record, reason: "tool-use-id" });
    expect(resolve([record], request, { "x-bridge-session": "droid-a" }))
      .toMatchObject({ match: record, reason: "explicit-id" });
  });

  it("does not infer identity from a dynamic catalog for an initial or ambiguous request", () => {
    const tools = catalogChanges[0]![1];
    expect(resolve([session()], { ...initial, tools }).match).toBeUndefined();
    expect(resolve([session()], { ...continuation, tools }, { "x-bridge-session": "new-session" }).match).toBeUndefined();
    expect(() => resolve([session(), session({ bridgeSessionId: "bridge-b", droidSessionId: "droid-b" })], { ...continuation, tools }))
      .toThrowError(expect.objectContaining({ status: 409, code: "ambiguous_session" }));
    expect(() => resolve([session({ state: "GENERATING", historyMessageHashes: undefined })], { ...initial, tools }))
      .toThrowError(expect.objectContaining({ status: 409, code: "ambiguous_session" }));
  });

  it("retains model, role and workspace isolation when the catalog also changes", () => {
    const request = { ...continuation, tools: catalogChanges[0]![1] };
    const record = session();
    const selected = { ...headers, "x-bridge-session": "droid-a" };
    expect(() => resolveSession([record], selected, { ...request, model: "other-model" }, { cwd }))
      .toThrowError(expect.objectContaining({ status: 409, code: "session_context_changed" }));
    expect(() => resolveSession([record], { ...selected, "x-bridge-role": "worker" }, request, { cwd }))
      .toThrowError(expect.objectContaining({ status: 409, code: "session_context_changed" }));
    expect(() => resolveSession([record], selected, request, { cwd: "/tmp/project-b" }))
      .toThrowError(expect.objectContaining({ status: 409, code: "session_context_changed" }));
    expect(resolveSession([record], headers, { ...request, model: "other-model" }, { cwd }).match).toBeUndefined();
    expect(resolveSession([record], { ...headers, "x-bridge-role": "worker" }, request, { cwd }).match).toBeUndefined();
    expect(resolveSession([record], headers, request, { cwd: "/tmp/project-b" }).match).toBeUndefined();
  });

  it("accepts a legacy record's changed catalog without losing its explicit or pending identity", () => {
    const record = session({ contextHash: undefined, state: "WAITING_DROID_TOOL", pendingToolIds: ["tool-a"] });
    const request: MessagesRequest = {
      ...initial, tools: catalogChanges[0]![1],
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool-a", content: "loaded" }] }],
    };
    expect(resolve([record], request).match).toBe(record);
    expect(resolve([record], request, { "x-bridge-session": "droid-a" }).match).toBe(record);
    expect(() => resolve([record], { ...request, model: "other-model" }, { "x-bridge-session": "droid-a" }))
      .toThrowError(expect.objectContaining({ status: 409, code: "session_context_changed" }));
  });

  it("isolates roles and workspaces even when the complete transcript is identical", () => {
    expect(resolve([session()], continuation, { "x-bridge-role": "worker" }).match).toBeUndefined();
    expect(resolveSession([session()], headers, continuation, { cwd: "/tmp/project-b" }).match).toBeUndefined();
    expect(() => resolveSession([session()], { ...headers, "x-bridge-session": "bridge-a" }, continuation, { cwd: "/tmp/project-b" }))
      .toThrowError(expect.objectContaining({ code: "session_context_changed" }));
  });

  it("rejects cross-session tool results even when the explicit ID exists", () => {
    const first = session({ pendingToolIds: ["tool-a"] });
    const second = session({ bridgeSessionId: "bridge-b", droidSessionId: "droid-b", pendingToolIds: ["tool-b"] });
    const request: MessagesRequest = { ...initial, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool-b", content: "done" }] }] };
    expect(() => resolve([first, second], request, { "x-bridge-session": "bridge-a" }))
      .toThrowError(expect.objectContaining({ status: 409, code: "cross_session_tool_result" }));
  });

  it("rejects a duplicate in-flight request without a channel ID", () => {
    expect(() => resolve([session({ state: "GENERATING", historyMessageHashes: undefined })], initial))
      .toThrowError(expect.objectContaining({ status: 409, code: "ambiguous_session" }));
  });

  it("normalizes text block representation and cache hints while retaining tool inputs", () => {
    const plain: Message[] = [{ role: "user", content: "hello" }];
    const hinted: Message[] = [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }];
    expect(historyMessageHashes(plain)).toEqual(historyMessageHashes(hinted));
    const tool = (value: string): Message[] => [{ role: "assistant", content: [{ type: "tool_use", id: "tool-a", name: "Read", input: { cache_control: value } }] }];
    expect(historyMessageHashes(tool("one"))).not.toEqual(historyMessageHashes(tool("two")));
  });

  it("does not resume a failed or cancelled transcript through history matching", () => {
    expect(resolve([session({ state: "FAILED" }), session({ bridgeSessionId: "bridge-b", state: "CANCELLED" })]).match).toBeUndefined();
  });

  describe("authenticated Factory compaction", () => {
    const compacted: MessagesRequest = { ...continuation, messages: [
      { role: "user", content: "Rewritten Factory summary and environment reminders." },
      ...continuation.messages,
    ] };
    const owned = (patch: Partial<SessionRecord> = {}) => session({ factorySessionId: "host-a", factoryCwd: cwd, ...patch });
    const resolveOwned = (records: SessionRecord[], request = compacted, hostSessionId = "host-a") =>
      resolveSession(records, headers, request, { cwd, hostSessionId });

    it("keeps the native session after prefix rewriting using the exact retained complete turn", () => {
      const record = owned();
      expect(resolveOwned([record])).toMatchObject({ match: record, reason: "authenticated-history-tail" });
    });

    it("requires authenticated ownership, the complete reply and unchanged execution settings", () => {
      const record = owned();
      expect(resolveSession([record], headers, compacted, { cwd }).match).toBeUndefined();
      expect(resolveOwned([record], compacted, "handoff-host").match).toBeUndefined();
      expect(resolveOwned([owned({ factorySessionId: undefined })]).match).toBeUndefined();
      expect(resolveOwned([owned({ factoryCwd: "/tmp/other-workspace" })]).match).toBeUndefined();
      expect(resolveOwned([record], { ...compacted, model: "different" }).match).toBeUndefined();
      expect(resolveOwned([record], { ...compacted, messages: [compacted.messages[0]!, initial.messages[0]!,
        { role: "assistant", content: "A different assistant reply." }, continuation.messages[2]!] }).match).toBeUndefined();
      expect(resolveOwned([record], { ...compacted, messages: [compacted.messages[0]!, continuation.messages[2]!] }).match).toBeUndefined();
    });

    it("does not merge tool-free helpers, unfinished turns or unresumable checkpoints", () => {
      expect(resolveOwned([owned()], { ...compacted, tools: [] }).match).toBeUndefined();
      for (const patch of [
        { toolNames: [] }, { state: "GENERATING" as const }, { pendingToolIds: ["unresolved"] },
        { sdkSessionId: undefined }, { cancelRequested: true }, { hostEnded: "terminal" as const },
        { hostEnded: "interrupted" as const }, { requestMessageHashes: ["different-current-request"] },
      ]) expect(resolveOwned([owned(patch)]).match).toBeUndefined();
    });

    it("does not discard extra new user messages or consume callback results through tail matching", () => {
      expect(resolveOwned([owned()], { ...compacted, messages: [...compacted.messages, { role: "user", content: "Second new message" }] }).match).toBeUndefined();
      expect(resolveOwned([owned()], { ...compacted, messages: [...compacted.messages.slice(0, -1), {
        role: "user", content: [{ type: "tool_result", tool_use_id: "unowned-tool", content: "done" }],
      }] }).match).toBeUndefined();
    });

    it("rejects ambiguous retained turns instead of guessing one native checkpoint", () => {
      expect(() => resolveOwned([owned(), owned({ bridgeSessionId: "bridge-b", sdkSessionId: "sdk-b" })]))
        .toThrowError(expect.objectContaining({ status: 409, code: "ambiguous_session" }));
    });
  });
});
