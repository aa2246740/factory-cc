import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlBroker } from "../../src/control/broker.js";
import { SessionStore } from "../../src/sessions/store.js";
import type { BridgeRuntime, RuntimeHostCall } from "../../src/runtime/types.js";
import type { MessagesRequest } from "../../src/types.js";

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "control-broker-")); dirs.push(dir);
  const store = new SessionStore(dir, false, 16);
  const calls = new Map<string, RuntimeHostCall[]>();
  const runtime: BridgeRuntime = {
    kind: "sdk", handle: vi.fn(), deliverResults: vi.fn(), cancel: vi.fn(async () => {}),
    pendingHostCalls: (id) => calls.get(id) ?? [], completeHostTool: vi.fn(async () => "accepted" as const), endHostSession: vi.fn(async () => ({ resumable: true })),
  };
  const broker = new ControlBroker(runtime, store, 1000);
  const session = () => {
    const record = store.create({ role: "worker", model: "test", toolNames: ["EndFeatureRun"] });
    store.setState(record.bridgeSessionId, "GENERATING");
    store.setState(record.bridgeSessionId, "WAITING_DROID_TOOL");
    calls.set(record.bridgeSessionId, [{ toolUseId: randomUUID(), toolName: "EndFeatureRun", input: { feature: "sum", result: { ok: true } } }]);
    return record.bridgeSessionId;
  };
  const event = (name: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: name, session_id: "factory-a", cwd: dir, ...extra });
  const send = (name: string, token?: string, extra = {}) => broker.hostEvent({ eventId: randomUUID(), event: event(name, extra), bindingToken: token });
  return { dir, store, calls, runtime, broker, session, event, send };
}

describe("live permission requests", () => {
  it("settles once, permits edited input, and rejects duplicate or stale decisions", async () => {
    const f = fixture(); const abort = new AbortController();
    const result = f.broker.requestApproval({ bridgeSessionId: "native-a", toolName: "Bash", input: { command: "echo initial" }, signal: abort.signal });
    const pending = f.broker.listApprovals()[0]!;
    f.broker.decide(pending.id as string, { decision: "allow", updatedInput: { command: "echo approved" } });
    expect(await result).toEqual({ behavior: "allow", updatedInput: { command: "echo approved" } });
    expect(f.broker.listApprovals()).toEqual([]);
    expect(() => f.broker.decide(pending.id as string, { decision: "allow" })).toThrowError(expect.objectContaining({ code: "approval_expired" }));
  });

  it("native abort, expiry and shutdown deny without retaining authority", async () => {
    vi.useFakeTimers(); const f = fixture(); const abort = new AbortController();
    const request = { bridgeSessionId: "a", toolName: "Write", input: {}, signal: abort.signal };
    const aborted = f.broker.requestApproval(request); abort.abort();
    expect(await aborted).toMatchObject({ behavior: "deny" });
    const expired = f.broker.requestApproval({ ...request, signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await expired).toMatchObject({ behavior: "deny" });
    const closed = f.broker.requestApproval({ ...request, signal: new AbortController().signal }); f.broker.close();
    expect(await closed).toMatchObject({ behavior: "deny" });
    expect(f.broker.listApprovals()).toEqual([]);
  });

  it("malformed approval never consumes the pending native callback", async () => {
    const f = fixture(); const abort = new AbortController();
    const result = f.broker.requestApproval({ bridgeSessionId: "a", toolName: "Write", input: {}, signal: abort.signal });
    const id = f.broker.listApprovals()[0]!.id as string;
    expect(() => f.broker.decide(id, { decision: "allow", updatedInput: [] })).toThrow();
    expect(f.broker.listApprovals()).toHaveLength(1); abort.abort(); await result;
  });
});

describe("authentic Factory lifecycle", () => {
  it("renews ownership on authenticated user turns after Factory discarded its original start context", async () => {
    const f = fixture(); const start = await f.send("SessionStart");
    const token = start.bindingToken as string;
    const turn = await f.send("UserPromptSubmit", token, { prompt: "Recall after automatic compaction" });
    expect(turn).toEqual({ ok: true, additionalContext: start.additionalContext });
    const request: MessagesRequest = { model: "test", max_tokens: 10, messages: [{ role: "user", content: `${turn.additionalContext} recall` }] };
    expect(f.broker.prepareRequest(request, f.dir)).toMatchObject({ binding: token, request: { messages: [{ role: "user", content: " recall" }] } });
    await expect(f.send("UserPromptSubmit", "old-generation")).rejects.toMatchObject({ code: "stale_host_event" });
    await f.send("SessionEnd", token);
    expect(await f.send("UserPromptSubmit", token)).not.toHaveProperty("additionalContext");
  });

  it("retires only the authenticated compact predecessor so copied markers cannot misbind handoff", async () => {
    const f = fixture();
    const old = await f.send("SessionStart");
    const id = f.session(); f.broker.bind(old.bindingToken as string, id);
    const sibling = await f.send("SessionStart", undefined, { session_id: "sibling" });
    const siblingId = f.session(); f.broker.bind(sibling.bindingToken as string, siblingId);
    const currentCompact = await f.send("SessionStart", undefined, { source: "compact", previous_session_id: "factory-a" });
    expect(currentCompact.bindingToken).toBe(old.bindingToken);
    expect(f.runtime.endHostSession).not.toHaveBeenCalled();
    const fresh = await f.send("SessionStart", undefined, { session_id: "handoff-b", source: "compact", previous_session_id: "factory-a" });
    expect(f.runtime.endHostSession).toHaveBeenCalledExactlyOnceWith(id, "Factory compact handoff");
    const request: MessagesRequest = { model: "test", max_tokens: 10, messages: [{ role: "user", content: `${old.additionalContext}\n${fresh.additionalContext}\ncontinue` }] };
    expect(f.broker.prepareRequest(request, f.dir).binding).toBe(fresh.bindingToken);
    request.messages[0]!.content = `${sibling.additionalContext} separate work`;
    expect(f.broker.prepareRequest(request, f.dir).binding).toBe(sibling.bindingToken);
    expect(f.store.require(id).hostEnded).toBe("resumable");
  });

  it("does not let a new launch retire another launch's live compact predecessor", async () => {
    const f = fixture();
    const firstLaunch = f.broker.createLaunch({ cwd: f.dir }).launchId;
    const secondLaunch = f.broker.createLaunch({ cwd: f.dir }).launchId;
    const old = await f.broker.hostEvent({ eventId: randomUUID(), event: f.event("SessionStart"), launchId: firstLaunch });
    const id = f.session(); f.broker.bind(old.bindingToken as string, id);
    await expect(f.broker.hostEvent({ eventId: randomUUID(), event: f.event("SessionStart", {
      session_id: "new", source: "compact", previous_session_id: "factory-a",
    }), launchId: secondLaunch })).rejects.toMatchObject({ code: "conflicting_host_launch" });
    expect(f.runtime.endHostSession).not.toHaveBeenCalled();
  });

  it("keeps Spec read-only through optimistic mode changes until the exact successful host receipt", async () => {
    const f = fixture();
    const start = await f.send("SessionStart", undefined, { permission_mode: "spec" });
    const token = start.bindingToken as string;
    const id = f.session(); f.broker.bind(token, id);
    const call = { toolUseId: "native-spec-exit", toolName: "ExitSpecMode", input: { title: "Plan", plan: "Read then implement" } };
    f.calls.set(id, [call]);
    expect(f.broker.factoryPermissionMode(id)).toBe("spec");
    await f.send("PreToolUse", token, { permission_mode: "auto-high", tool_name: "ExitSpecMode" });
    expect(f.broker.factoryPermissionMode(id)).toBe("spec");
    const completed = { permission_mode: "auto-high", tool_name: "ExitSpecMode", tool_input: call.input,
      tool_use_id: call.toolUseId, tool_response: "approved" };
    await expect(f.send("PostToolUse", "stale", completed)).rejects.toMatchObject({ code: "stale_host_event" });
    expect(f.broker.factoryPermissionMode(id)).toBe("spec");
    await f.send("PostToolUse", token, { ...completed, tool_use_id: "another-call" });
    expect(f.broker.factoryPermissionMode(id)).toBe("spec");
    await f.send("PostToolUse", token, { ...completed, tool_response: { isError: true } });
    expect(f.broker.factoryPermissionMode(id)).toBe("spec");
    await f.send("PostToolUse", token, completed);
    expect(f.broker.factoryPermissionMode(id)).toBe("auto-high");
    await f.send("UserPromptSubmit", token, { permission_mode: "spec" });
    expect(f.broker.factoryPermissionMode(id)).toBe("spec");
    await f.send("SessionEnd", token);
    expect(f.broker.factoryPermissionMode(id)).toBeUndefined();
  });

  it("binds an alias launch to physical Factory cwd and rejects unrelated workspaces", async () => {
    const f = fixture();
    const physical = realpathSync(f.dir);
    const alias = `${f.dir}-alias`; dirs.push(alias);
    symlinkSync(physical, alias, "junction");
    const { launchId } = f.broker.createLaunch({ cwd: alias });
    const start = await f.broker.hostEvent({ eventId: randomUUID(), event: f.event("SessionStart", { cwd: physical }), launchId });
    const original: MessagesRequest = { model: "test", max_tokens: 100, messages: [{ role: "user", content: `${start.additionalContext} work` }] };
    expect(f.broker.prepareRequest(original, alias).binding).toBe(start.bindingToken);
    expect(f.broker.prepareRequest(original, physical).binding).toBe(start.bindingToken);
    const id = f.session(); f.broker.bind(start.bindingToken as string, id);
    expect(f.store.require(id).factoryCwd).toBe(physical);
    const other = `${f.dir}-other`; dirs.push(other); mkdirSync(other);
    expect(() => f.broker.prepareRequest(original, other)).toThrowError(expect.objectContaining({ code: "host_workspace_mismatch" }));
    await expect(f.broker.hostEvent({ eventId: randomUUID(), event: f.event("SessionStart", { cwd: other, session_id: "different-host" }), launchId }))
      .rejects.toMatchObject({ code: "invalid_host_launch" });
    await expect(f.send("SessionEnd", start.bindingToken as string, { cwd: other })).rejects.toMatchObject({ code: "host_not_registered" });
    await f.broker.endLaunch(launchId, false);
  });

  it("ends through an authenticated registered alias after the directory disappears without accepting retargeted aliases", async () => {
    const f = fixture();
    const physical = realpathSync(f.dir);
    const alias = `${f.dir}-alias`; dirs.push(alias);
    const other = `${f.dir}-other`; dirs.push(other); mkdirSync(other);
    symlinkSync(physical, alias, "junction");
    const { launchId } = f.broker.createLaunch({ cwd: alias });
    const start = await f.broker.hostEvent({ eventId: randomUUID(), event: f.event("SessionStart", { cwd: physical }), launchId });
    const token = start.bindingToken as string;
    const id = f.session(); f.broker.bind(token, id);
    rmSync(alias); symlinkSync(other, alias, "junction");
    await expect(f.send("SessionEnd", token, { cwd: alias })).rejects.toMatchObject({ code: "host_not_registered" });
    expect(f.runtime.endHostSession).not.toHaveBeenCalled();
    rmSync(alias); symlinkSync(physical, alias, "junction");
    rmSync(physical, { recursive: true });
    await expect(f.send("SessionEnd", "wrong-generation", { cwd: alias })).rejects.toMatchObject({ code: "host_not_registered" });
    await f.send("SessionEnd", token, { cwd: alias });
    expect(f.runtime.endHostSession).toHaveBeenCalledExactlyOnceWith(id, expect.any(String));
    expect(f.store.require(id).hostEnded).toBe("resumable");
    // The old physical path still recognizes the same completed generation.
    await f.send("SessionEnd", token, { cwd: physical });
    expect(f.runtime.endHostSession).toHaveBeenCalledTimes(1);
  });

  it("strips registered transport markers without changing user content/tool inputs and binds exact workspace", async () => {
    const f = fixture(); const start = await f.send("SessionStart");
    const marker = start.additionalContext as string;
    const original: MessagesRequest = { model: "test", max_tokens: 100, messages: [{ role: "user", content: [{ type: "text", text: marker }, { type: "text", text: "Implement sum" }] }] };
    const prepared = f.broker.prepareRequest(original, f.dir);
    expect(prepared.request.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Implement sum" }] }]);
    expect(original.messages[0]!.content).toHaveLength(2);
    expect(prepared.binding).toBe(start.bindingToken);
    expect(() => f.broker.prepareRequest(original, "/different")).toThrowError(expect.objectContaining({ code: "host_workspace_mismatch" }));
  });

  it("requires both a real EndFeatureRun result and SessionEnd; no next model request is needed", async () => {
    const f = fixture(); const start = await f.send("SessionStart"); const token = start.bindingToken as string;
    const id = f.session(); f.broker.bind(token, id); const call = f.calls.get(id)![0]!;
    await f.send("PostToolUse", token, { tool_name: "EndFeatureRun", tool_input: { result: { ok: true }, feature: "sum" }, tool_response: "host completed worker" });
    expect(f.runtime.completeHostTool).not.toHaveBeenCalled();
    const ending = { eventId: "ended-once", event: f.event("SessionEnd", { reason: "other" }), bindingToken: token };
    await Promise.all([f.broker.hostEvent(ending), f.broker.hostEvent(ending)]);
    expect(f.runtime.completeHostTool).toHaveBeenCalledExactlyOnceWith(id, { ...call, content: "host completed worker", terminal: true });
    expect(f.store.require(id)).toMatchObject({ state: "IDLE", pendingToolIds: [], hostEnded: "terminal" });
  });

  it("ordinary tools retain their HTTP continuation and failed terminal results never become success", async () => {
    const f = fixture(); const token = (await f.send("SessionStart")).bindingToken as string; const id = f.session(); f.broker.bind(token, id);
    const call = f.calls.get(id)![0]!;
    await f.send("PostToolUse", token, { tool_name: call.toolName, tool_input: call.input, tool_response: { isError: true, text: "validation failed" } });
    await f.send("SessionEnd", token);
    expect(f.runtime.completeHostTool).not.toHaveBeenCalled(); expect(f.runtime.endHostSession).toHaveBeenCalledOnce();
  });

  it("does not cancel on normal idle notifications", async () => {
    const f = fixture(); const token = (await f.send("SessionStart")).bindingToken as string; f.broker.bind(token, f.session());
    await f.send("Notification", token, { notification_type: "idle_prompt", message: "waiting for input" });
    expect(f.runtime.cancel).not.toHaveBeenCalled(); expect(f.runtime.endHostSession).not.toHaveBeenCalled();
  });

  it("never applies a prior tool receipt to a retry with the same arguments", async () => {
    const f = fixture(); const token = (await f.send("SessionStart")).bindingToken as string;
    const id = f.session(); f.broker.bind(token, id); const first = f.calls.get(id)![0]!;
    await f.send("PostToolUse", token, { tool_name: first.toolName, tool_input: first.input, tool_response: "temporary host failure" });
    f.calls.set(id, [{ ...first, toolUseId: "different-native-retry" }]);
    await f.send("SessionEnd", token);
    expect(f.runtime.completeHostTool).not.toHaveBeenCalled();
    expect(f.runtime.endHostSession).toHaveBeenCalledOnce();
  });

  it("rejects ambiguous parallel calls, cross-session events and stale generations", async () => {
    const f = fixture(); const token = (await f.send("SessionStart")).bindingToken as string;
    const id = f.session(); f.broker.bind(token, id); f.broker.bind(token, f.session());
    const call = f.calls.get(id)![0]!;
    await expect(f.send("PostToolUse", token, { tool_name: call.toolName, tool_input: call.input, tool_response: "done" })).rejects.toMatchObject({ code: "ambiguous_host_tool" });
    await expect(f.send("SessionEnd", "bad-generation")).rejects.toMatchObject({ code: "stale_host_event" });
    await expect(f.send("SessionEnd")).rejects.toMatchObject({ code: "stale_host_event" });
    await f.send("SessionEnd", token);
    const resumed = (await f.send("SessionStart")).bindingToken as string;
    expect(resumed).not.toBe(token);
    await expect(f.send("SessionEnd", token)).rejects.toMatchObject({ code: "stale_host_event" });
  });

  it("deduplicates event IDs and rejects changed content", async () => {
    const f = fixture(); const input = { eventId: "same-event", event: f.event("SessionStart") };
    expect(await f.broker.hostEvent(input)).toEqual(await f.broker.hostEvent(input));
    expect(() => f.broker.hostEvent({ ...input, event: f.event("SessionStart", { session_id: "other" }) })).toThrowError(expect.objectContaining({ code: "conflicting_host_event" }));
  });

  it("launch cancellation closes only registered ownership and prevents late admission", async () => {
    const f = fixture(); const { launchId } = f.broker.createLaunch({ cwd: f.dir });
    const start = await f.broker.hostEvent({ eventId: randomUUID(), event: f.event("SessionStart"), launchId });
    const own = f.session(); f.broker.bind(start.bindingToken as string, own); const other = f.session();
    await f.broker.endLaunch(launchId, true);
    expect(f.runtime.cancel).toHaveBeenCalledExactlyOnceWith(own, "factory-cancelled");
    expect(f.store.require(other).state).toBe("WAITING_DROID_TOOL");
    await expect(f.broker.hostEvent({ eventId: randomUUID(), event: f.event("SessionStart", { session_id: "late-child" }), launchId })).rejects.toMatchObject({ code: "invalid_host_launch" });
  });

  it("blocks late HTTP and new bindings while a host generation is draining", async () => {
    const f = fixture(); const start = await f.send("SessionStart"); const token = start.bindingToken as string;
    f.broker.bind(token, f.session());
    let release!: () => void;
    vi.mocked(f.runtime.endHostSession!).mockImplementationOnce(() => new Promise((done) => { release = () => done({ resumable: true }); }));
    const closing = f.send("SessionEnd", token);
    const request: MessagesRequest = { model: "test", max_tokens: 10, messages: [{ role: "user", content: `${start.additionalContext} late request` }] };
    expect(() => f.broker.prepareRequest(request, f.dir)).toThrowError(expect.objectContaining({ code: "stale_host_binding" }));
    expect(() => f.broker.bind(token, f.session())).toThrowError(expect.objectContaining({ code: "host_session_ended" }));
    await expect(f.send("SessionStart")).rejects.toMatchObject({ code: "host_session_closing" });
    release(); await closing;
    expect(() => f.broker.prepareRequest(request, f.dir)).toThrowError(expect.objectContaining({ code: "stale_host_binding" }));
    const resumed = await f.send("SessionStart");
    request.messages.push({ role: "user", content: `${resumed.additionalContext} resumed request` });
    expect(f.broker.prepareRequest(request, f.dir).binding).toBe(resumed.bindingToken);
  });

  it("drains other sessions if one terminal completion fails and retains interrupted replay protection", async () => {
    const f = fixture(); const token = (await f.send("SessionStart")).bindingToken as string;
    const one = f.session(); const two = f.session(); f.broker.bind(token, one); f.broker.bind(token, two);
    f.calls.get(two)![0]!.input = { feature: "different" };
    const call = f.calls.get(one)![0]!;
    await f.send("PostToolUse", token, { tool_name: call.toolName, tool_input: call.input, tool_response: "actual terminal result" });
    vi.mocked(f.runtime.completeHostTool!).mockRejectedValueOnce(new Error("completion failed"));
    await expect(f.send("SessionEnd", token)).rejects.toThrow("cleanup reported failures");
    expect(f.runtime.cancel).toHaveBeenCalledWith(one, "host-completion-failed");
    expect(f.runtime.endHostSession).toHaveBeenCalledWith(two, expect.any(String));
    expect(f.store.require(one).hostEnded).toBe("interrupted");
    expect(f.store.require(two).hostEnded).toBe("resumable");
    expect(f.broker.describe().failures).toEqual(["host_cleanup_failed"]);
  });
});
