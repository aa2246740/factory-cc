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

  describe("ended sessions and the tool results Factory keeps in its history", () => {
    const toolUse: Message = { role: "assistant", content: [{ type: "tool_use", id: "tool-a", name: "Read", input: {} }] };
    const toolResult = { type: "tool_result" as const, tool_use_id: "tool-a", content: "interrupted" };
    const request = (...tail: Message[]): MessagesRequest => ({ ...initial, messages: [initial.messages[0]!, toolUse, ...tail] });
    const retry = request({ role: "user", content: [toolResult] });
    const merged = request({ role: "user", content: [toolResult, { type: "text", text: "Do something else instead." }] });
    const consecutive = request({ role: "user", content: [toolResult] }, { role: "user", content: "Do something else instead." });
    const endings: Array<Partial<SessionRecord>> = [{ state: "CANCELLED" }, { state: "FAILED" }, { hostEnded: "terminal" }, { hostEnded: "interrupted" }];

    it.each(endings)("answers a retried tool result of an ended session with a clear 409: %j", (patch) => {
      for (const held of [{ endedToolIds: ["tool-a"] }, { pendingToolIds: ["tool-a"] }]) {
        expect(() => resolve([session({ ...patch, ...held })], retry))
          .toThrowError(expect.objectContaining({ status: 409, code: "session_unavailable", message: expect.stringMatching(/will not be replayed.*new session/) }));
      }
    });

    it.each(endings)("treats a new message after an ended tool wait as a new conversation: %j", (patch) => {
      const record = session({ ...patch, pendingToolIds: ["tool-a"], endedToolIds: ["tool-a"] });
      for (const next of [merged, consecutive]) expect(resolve([record], next)).toEqual({ reason: "new-session" });
    });

    it("lets a live session keep ownership of its own pending tool while an ended one is ignored", () => {
      const live = session({ bridgeSessionId: "bridge-live", state: "WAITING_DROID_TOOL", pendingToolIds: ["tool-a"] });
      const dead = session({ bridgeSessionId: "bridge-dead", state: "CANCELLED", endedToolIds: ["tool-a"] });
      expect(resolve([dead, live], retry)).toMatchObject({ match: live, reason: "tool-use-id" });
      expect(resolve([dead, live], merged)).toMatchObject({ match: live, reason: "tool-use-id" });
    });

    it("does not mistake an unknown tool result for a retry of an ended session", () => {
      const ended = session({ state: "CANCELLED", endedToolIds: ["other-tool"] });
      expect(resolve([ended], retry)).toEqual({ reason: "new-session" });
    });
  });

  describe("optional model switching", () => {
    const nextModel = { ...continuation, model: "other-model" };
    const resolveSwitch = (records: SessionRecord[], request = nextModel, extraHeaders = {}) =>
      resolveSession(records, { ...headers, ...extraHeaders }, request, { cwd, allowModelSwitch: true });

    it("uses the stored model fingerprint without changing the persisted format or mutating identity", () => {
      const record = session(); const original = structuredClone(record);
      expect(record.contextHash).not.toBe(sessionContextHash(headers, nextModel, cwd));
      expect(resolveSwitch([record])).toMatchObject({ match: record, reason: "history-prefix" });
      expect(resolveSwitch([record], nextModel, { "x-bridge-session": "droid-a" }))
        .toMatchObject({ match: record, reason: "explicit-id" });
      expect(record).toEqual(original);
      expect(resolveSession([record], headers, nextModel, { cwd, allowModelSwitch: false }).match).toBeUndefined();
      expect(() => resolveSession([record], { ...headers, "x-bridge-session": "droid-a" }, nextModel, { cwd }))
        .toThrowError(expect.objectContaining({ code: "session_context_changed" }));
    });

    it("keeps old hash compatibility after successive switches and permits a resumable host checkpoint", () => {
      const record = session({ model: nextModel.model, contextHash: sessionContextHash(headers, nextModel, cwd), hostEnded: "resumable" });
      expect(resolveSwitch([record], continuation).match).toBe(record);
      expect(resolveSwitch([record], { ...nextModel, model: "third-model" }).match).toBe(record);
    });

    it("does not infer a conversation from a repeated initial prompt or a new explicit ID", () => {
      expect(resolveSwitch([session()], { ...initial, model: nextModel.model }).match).toBeUndefined();
      expect(resolveSwitch([session()], nextModel, { "x-bridge-session": "new-session" }).match).toBeUndefined();
      const fork = { ...nextModel, messages: [initial.messages[0]!, { role: "assistant" as const, content: "Different reply." }, continuation.messages[2]!] };
      expect(resolveSwitch([session()], fork).match).toBeUndefined();
    });

    it("requires explicit identity when several models have the same completed transcript", () => {
      const first = session();
      const second = session({ bridgeSessionId: "bridge-b", droidSessionId: "droid-b", model: nextModel.model,
        contextHash: sessionContextHash(headers, nextModel, cwd) });
      expect(() => resolveSwitch([first, second])).toThrowError(expect.objectContaining({ code: "ambiguous_session" }));
      expect(resolveSwitch([first, second], nextModel, { "x-bridge-session": "droid-a" }).match).toBe(first);
      expect(() => resolveSwitch([session({ state: "GENERATING", historyMessageHashes: undefined })], { ...initial, model: nextModel.model }))
        .toThrowError(expect.objectContaining({ code: "ambiguous_session" }));
    });

    it.each<Partial<SessionRecord>>([
      { state: "GENERATING" }, { state: "RESUMING" }, { state: "WAITING_DROID_TOOL" },
      { pendingToolIds: ["unresolved"] }, { cancelRequested: true },
    ])("rejects a busy matched conversation without forking it: %j", (patch) => {
      const record = session(patch); const original = structuredClone(record);
      for (const extra of [{}, { "x-bridge-session": "droid-a" }]) {
        expect(() => resolveSwitch([record], nextModel, extra)).toThrowError(expect.objectContaining({ status: 409, code: "model_switch_busy" }));
      }
      expect(record).toEqual(original);
    });

    it("does not change a model while delivering its pending tool result or migrate another tool owner", () => {
      const record = session({ state: "WAITING_DROID_TOOL", pendingToolIds: ["tool-a"] });
      const request: MessagesRequest = { ...nextModel, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool-a", content: "done" }] }] };
      expect(() => resolveSwitch([record], request)).toThrowError(expect.objectContaining({ code: "model_switch_busy" }));
      expect(resolveSwitch([record], { ...request, model: initial.model }).match).toBe(record);
      const other = session({ bridgeSessionId: "bridge-b", droidSessionId: "droid-b" });
      expect(() => resolveSwitch([record, other], request, { "x-bridge-session": "droid-b" }))
        .toThrowError(expect.objectContaining({ code: "cross_session_tool_result" }));
    });

    it("retains role, workspace, thinking and authenticated host boundaries", () => {
      const record = session({ factorySessionId: "host-a", factoryCwd: cwd });
      const contexts = [
        { request: nextModel, headers: { ...headers, "x-bridge-role": "worker" }, cwd },
        { request: nextModel, headers, cwd: "/tmp/project-b" },
        { request: { ...nextModel, thinking: { type: "enabled" as const, budget_tokens: 1024 } }, headers, cwd },
      ];
      for (const changed of contexts) {
        expect(resolveSession([record], changed.headers, changed.request, { cwd: changed.cwd, allowModelSwitch: true }).match).toBeUndefined();
        expect(() => resolveSession([record], { ...changed.headers, "x-bridge-session": "droid-a" }, changed.request, { cwd: changed.cwd, allowModelSwitch: true }))
          .toThrowError(expect.objectContaining({ code: "session_context_changed" }));
      }
      expect(resolveSession([record], headers, nextModel, { cwd, hostSessionId: "host-b", allowModelSwitch: true }).match).toBeUndefined();
      expect(() => resolveSession([record], { ...headers, "x-bridge-session": "droid-a" }, nextModel, { cwd, hostSessionId: "host-b", allowModelSwitch: true }))
        .toThrowError(expect.objectContaining({ code: "cross_host_session" }));
    });

    describe("Factory model-specific thinking defaults", () => {
      // Actual Factory GLM-5.2 -> GLM-4.7 requests changed enabled/4095 to
      // absent thinking, while retaining these two user messages and reply.
      const oldRequest: MessagesRequest = { ...initial, model: "glm-5.2", thinking: { type: "enabled", budget_tokens: 4095 },
        messages: [userMessage("Factory environment and available skills."), userMessage("Remember verification code Pine; reply STORED.")] };
      const oldHistory: Message[] = [...oldRequest.messages, { role: "assistant", content: "STORED" }];
      const changed: MessagesRequest = { ...oldRequest, model: "glm-4.7", thinking: undefined,
        messages: [...oldHistory, userMessage("What verification code did I ask you to remember?")] };
      const options = { cwd, hostSessionId: "host-a", allowModelSwitch: true };
      const owned = (patch: Partial<SessionRecord> = {}) => session({ role: "unknown", model: oldRequest.model,
        contextHash: sessionContextHash({}, oldRequest, cwd), factorySessionId: "host-a", factoryCwd: cwd,
        requestMessageHashes: historyMessageHashes(oldRequest.messages), historyMessageHashes: historyMessageHashes(oldHistory), ...patch });

      it("retains the native identity for an authenticated complete history despite the host default changing", () => {
        const record = owned(); const original = structuredClone(record);
        expect(resolveSession([record], {}, changed, options)).toMatchObject({ match: record, reason: "history-prefix" });
        expect(resolveSession([record], { "x-bridge-session": "droid-a" }, changed, options))
          .toMatchObject({ match: record, reason: "explicit-id" });
        expect(record).toEqual(original);
        expect(resolveSession([record], {}, changed, { ...options, allowModelSwitch: false }).match).toBeUndefined();
        expect(() => resolveSession([owned({ state: "GENERATING" })], {}, changed, options))
          .toThrowError(expect.objectContaining({ code: "model_switch_busy" }));
      });

      it("requires exact host, workspace, role, tools and a complete old fingerprint", () => {
        for (const patch of [
          { factorySessionId: "host-b" }, { factorySessionId: undefined }, { factoryCwd: "/tmp/other-workspace" },
          { factoryCwd: undefined }, { role: "worker" as const }, { toolNames: [] }, { contextHash: undefined },
        ]) expect(resolveSession([owned(patch)], {}, changed, options).match).toBeUndefined();
        expect(resolveSession([owned()], {}, { ...changed, tools: [] }, options).match).toBeUndefined();
        expect(resolveSession([owned()], {}, changed, { ...options, hostSessionId: undefined }).match).toBeUndefined();
        expect(resolveSession([owned()], {}, changed, { ...options, cwd: "/tmp/other-workspace" }).match).toBeUndefined();
        expect(resolveSession([owned()], { "x-bridge-role": "worker" }, changed, options).match).toBeUndefined();
      });

      it("does not relax same-model thinking or infer continuity from host ownership or explicit ID alone", () => {
        const record = owned();
        expect(resolveSession([record], {}, { ...changed, model: oldRequest.model }, options).match).toBeUndefined();
        expect(resolveSession([record], {}, { ...changed, messages: oldRequest.messages }, options).match).toBeUndefined();
        expect(resolveSession([record], {}, { ...changed, messages: [userMessage("Unrelated new conversation.")] }, options).match).toBeUndefined();
        expect(() => resolveSession([record], { "x-bridge-session": "droid-a" }, { ...changed, messages: [changed.messages.at(-1)!] }, options))
          .toThrowError(expect.objectContaining({ code: "session_context_changed" }));
        expect(() => resolveSession([record], { "x-bridge-session": "droid-a" }, { ...changed, tools: [] }, options))
          .toThrowError(expect.objectContaining({ code: "session_context_changed" }));
        const resultOnly: MessagesRequest = { ...changed, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "pending", content: "done" }] }] };
        expect(() => resolveSession([owned({ state: "WAITING_DROID_TOOL", pendingToolIds: ["pending"] })], {}, resultOnly, options))
          .toThrowError(expect.objectContaining({ code: "session_context_changed" }));
        expect(() => resolveSession([owned({ state: "WAITING_DROID_TOOL", pendingToolIds: ["pending"] })], { "x-bridge-session": "droid-a" }, resultOnly, options))
          .toThrowError(expect.objectContaining({ code: "session_context_changed" }));
        expect(() => resolveSession([record, owned({ bridgeSessionId: "bridge-b", droidSessionId: "droid-b" })], {}, changed, options))
          .toThrowError(expect.objectContaining({ code: "ambiguous_session" }));
      });

      it("permits the same narrow change after authenticated compaction while retaining exact-tail checks", () => {
        const record = owned();
        const compacted = { ...changed, messages: [userMessage("Rewritten Factory summary."), ...changed.messages] };
        expect(resolveSession([record], {}, compacted, options)).toMatchObject({ match: record, reason: "authenticated-history-tail" });
        expect(resolveSession([record], { "x-bridge-session": "droid-a" }, compacted, options))
          .toMatchObject({ match: record, reason: "explicit-id" });
        const wrongReply = { ...compacted, messages: [...compacted.messages.slice(0, -2), { role: "assistant" as const, content: "A different reply." }, compacted.messages.at(-1)!] };
        expect(resolveSession([record], {}, wrongReply, options).match).toBeUndefined();
        expect(() => resolveSession([record], { "x-bridge-session": "droid-a" }, wrongReply, options))
          .toThrowError(expect.objectContaining({ code: "session_context_changed" }));
        expect(() => resolveSession([owned({ pendingToolIds: ["unresolved"] })], {}, compacted, options))
          .toThrowError(expect.objectContaining({ code: "model_switch_busy" }));
      });
    });

    it("refuses model switches for legacy records without a complete context fingerprint", () => {
      const record = session({ contextHash: undefined });
      expect(resolveSwitch([record]).match).toBeUndefined();
      expect(() => resolveSwitch([record], nextModel, { "x-bridge-session": "droid-a" }))
        .toThrowError(expect.objectContaining({ code: "session_context_changed" }));
      expect(resolveSwitch([record], continuation, { "x-bridge-session": "droid-a" }).match).toBe(record);
    });

    it.each<Partial<SessionRecord>>([
      { state: "FAILED" }, { state: "CANCELLED" }, { hostEnded: "terminal" }, { hostEnded: "interrupted" },
    ])("does not revive a session that has ended: %j", (patch) => {
      const record = session(patch);
      expect(resolveSwitch([record]).match).toBeUndefined();
      expect(() => resolveSwitch([record], nextModel, { "x-bridge-session": "droid-a" }))
        .toThrowError(expect.objectContaining({ code: "session_unavailable" }));
    });
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

    it("allows an idle model switch on an authenticated retained turn and rejects a busy one without forking", () => {
      const request = { ...compacted, model: "other-model" };
      const options = { cwd, hostSessionId: "host-a", allowModelSwitch: true };
      const record = owned();
      expect(resolveSession([record], headers, request, options)).toMatchObject({ match: record, reason: "authenticated-history-tail" });
      for (const patch of [{ state: "GENERATING" as const }, { pendingToolIds: ["unresolved"] }, { cancelRequested: true }]) {
        expect(() => resolveSession([owned(patch)], headers, request, options))
          .toThrowError(expect.objectContaining({ code: "model_switch_busy" }));
      }
      expect(resolveSession([record], headers, { ...request, tools: [] }, options).match).toBeUndefined();
      expect(resolveSession([record], headers, request, { ...options, hostSessionId: "host-b" }).match).toBeUndefined();
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

function userMessage(content: string): Message { return { role: "user", content }; }
