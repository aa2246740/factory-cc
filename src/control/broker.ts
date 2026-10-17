import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { BridgeRuntime, RuntimeApprovalRequest, RuntimeControl, RuntimePermissionDecision } from "../runtime/types.js";
import type { SessionStore } from "../sessions/store.js";
import { BridgeError, type ContentBlock, type MessagesRequest } from "../types.js";
import { canonicalWorkspacePath } from "../workspace.js";

type ObjectValue = Record<string, unknown>;
interface HostBinding {
  token: string;
  sessionId: string;
  cwd: string;
  /** Authenticated aliases observed while the workspace still existed. */
  cwdAliases: Set<string>;
  bridgeSessions: Set<string>;
  ended: boolean;
  drained?: boolean;
  ending?: Promise<void>;
  terminalResults: Map<string, { toolUseId: string; input: unknown; response: unknown; isError: boolean }>;
  launchId?: string;
  permissionMode?: string;
  /** Remains locked until the host confirms successful ExitSpecMode. */
  specRestricted?: boolean;
}
interface PendingApproval {
  view: ObjectValue & { id: string; bridgeSessionId: string };
  finish(decision: RuntimePermissionDecision): void;
}

/** Application control only. Native prompts, tools and conversation remain owned by Claude Code. */
export class ControlBroker implements RuntimeControl {
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly hosts = new Map<string, HostBinding>();
  private readonly tokens = new Map<string, HostBinding>();
  private readonly receipts = new Map<string, { hash: string; result: Promise<ObjectValue> }>();
  private readonly launches = new Map<string, { cwd: string; cwdAliases: Set<string>; ended: boolean; hosts: Set<HostBinding> }>();
  private readonly failures: string[] = [];
  private closed = false;

  constructor(private readonly runtime: BridgeRuntime, private readonly store: SessionStore, private readonly approvalTimeoutMs: number) {}

  requestApproval(request: RuntimeApprovalRequest): Promise<RuntimePermissionDecision> {
    if (this.closed || request.signal.aborted) return Promise.resolve({ behavior: "deny", message: "The native permission request has ended." });
    const id = randomUUID();
    const { signal, ...details } = request;
    const view = { ...structuredClone(details), id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.approvalTimeoutMs).toISOString() };
    return new Promise((resolveDecision) => {
      let settled = false;
      const finish = (decision: RuntimePermissionDecision): void => {
        if (settled) return;
        settled = true;
        this.approvals.delete(id);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolveDecision(decision);
      };
      const abort = (): void => finish({ behavior: "deny", message: "The native permission request was cancelled." });
      const timer = setTimeout(() => finish({ behavior: "deny", message: "Approval expired without a decision." }), this.approvalTimeoutMs);
      timer.unref();
      this.approvals.set(id, { view, finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  listApprovals(): ObjectValue[] { return [...this.approvals.values()].map(({ view }) => structuredClone(view)); }

  decide(id: string, input: unknown): void {
    const decision = object(input);
    if (decision.decision !== "allow" && decision.decision !== "deny") throw invalid("decision must be allow or deny");
    if (decision.updatedInput !== undefined) object(decision.updatedInput);
    if (decision.message !== undefined && typeof decision.message !== "string") throw invalid("message must be a string");
    const approval = this.approvals.get(id);
    if (!approval) throw new BridgeError(409, "approval_expired", "This native permission request is no longer pending.");
    approval.finish(decision.decision === "allow"
      ? { behavior: "allow", ...(decision.updatedInput === undefined ? {} : { updatedInput: structuredClone(decision.updatedInput as ObjectValue) }) }
      : { behavior: "deny", message: typeof decision.message === "string" ? decision.message : "Denied by the local controller." });
  }

  cancelApprovals(sessionId: string): void {
    for (const pending of this.approvals.values()) if (pending.view.bridgeSessionId === sessionId) {
      pending.finish({ behavior: "deny", message: "Session cancelled." });
    }
  }

  createLaunch(input: unknown): { launchId: string } {
    const body = object(input);
    if (typeof body.cwd !== "string" || !body.cwd) throw invalid("launch cwd required");
    const launchId = randomUUID();
    const cwd = canonicalWorkspacePath(body.cwd);
    this.launches.set(launchId, { cwd, cwdAliases: new Set([cwd, resolve(body.cwd)]), ended: false, hosts: new Set() });
    return { launchId };
  }

  async endLaunch(launchId: string, cancelled: boolean): Promise<ObjectValue> {
    const launch = this.launches.get(launchId);
    if (!launch) throw new BridgeError(404, "launch_not_found", "Unknown Droid launch.");
    // Closing admission precedes draining; no late SessionStart can escape cancellation.
    launch.ended = true;
    const results = await Promise.allSettled([...launch.hosts].filter((host) => !host.drained)
      .map((host) => this.endHost(host, cancelled, cancelled ? "Factory launch cancelled" : "Factory launch exited")));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Droid launch cleanup reported failures");
    return { ok: true, launchId, ended: true };
  }

  /** Registered opaque hook markers are transport metadata, not native prompt text. */
  prepareRequest(original: MessagesRequest, cwd: string): { request: MessagesRequest; binding?: string } {
    const request = structuredClone(original);
    const found = new Set<HostBinding>();
    let markers = 0;
    const clean = (text: string): string => text.replace(/\[factory-cc-session:([a-f0-9]{64})\]/g, (marker, token: string) => {
      markers += 1;
      const host = this.tokens.get(token);
      if (host && !host.ended) found.add(host);
      return "";
    });
    const blocks = (content: string | ContentBlock[]): string | ContentBlock[] => {
      if (typeof content === "string") return clean(content);
      return content.flatMap((block): ContentBlock[] => {
        if (block.type === "text" && typeof block.text === "string") {
          const text = clean(block.text);
          return text === "" && block.text !== "" ? [] : [{ ...block, text }];
        }
        if (block.type === "tool_result" && (typeof block.content === "string" || Array.isArray(block.content))) return [{ ...block, content: blocks(block.content as string | ContentBlock[]) } as ContentBlock];
        return [block];
      });
    };
    if (request.system !== undefined) request.system = blocks(request.system);
    request.messages = request.messages.flatMap((message) => {
      const content = blocks(message.content);
      return (content === "" && message.content !== "") || (Array.isArray(content) && content.length === 0 && Array.isArray(message.content) && message.content.length > 0)
        ? [] : [{ ...message, content }];
    });
    if (found.size > 1) throw new BridgeError(409, "ambiguous_host_binding", "Multiple live Factory session markers in this request.");
    if (markers > 0 && found.size === 0) throw new BridgeError(409, "stale_host_binding", "This Factory session has ended or its generation is no longer registered.");
    const host = [...found][0];
    if (host && host.cwd !== canonicalWorkspacePath(cwd)) throw new BridgeError(409, "host_workspace_mismatch", "Factory hook and native workspace differ.");
    return { request, binding: host?.token };
  }

  bind(token: string | undefined, bridgeSessionId: string): void {
    if (!token) return;
    const host = this.tokens.get(token);
    if (!host || host.ended) throw new BridgeError(409, "host_session_ended", "Factory session binding has expired.");
    for (const other of this.hosts.values()) if (other !== host && !other.ended && other.bridgeSessions.has(bridgeSessionId)) {
      throw new BridgeError(409, "conflicting_host_binding", "This native session belongs to another live Factory session.");
    }
    host.bridgeSessions.add(bridgeSessionId);
    this.store.update(bridgeSessionId, { factorySessionId: host.sessionId, factoryCwd: host.cwd });
  }

  hostSessionId(token: string | undefined): string | undefined { return token ? this.tokens.get(token)?.sessionId : undefined; }

  factoryPermissionMode(bridgeSessionId: string): string | undefined {
    const session = this.store.get(bridgeSessionId);
    if (!session?.factorySessionId || !session.factoryCwd) return undefined;
    const host = this.hosts.get(`${session.factoryCwd}\0${session.factorySessionId}`);
    if (!host || host.ended || !host.bridgeSessions.has(bridgeSessionId)) return undefined;
    return host.specRestricted ? "spec" : host.permissionMode;
  }

  hostEvent(input: unknown): Promise<ObjectValue> {
    if (this.closed) throw new BridgeError(503, "bridge_shutting_down", "Controller is closed.");
    const envelope = object(input);
    if (typeof envelope.eventId !== "string" || !envelope.eventId || envelope.eventId.length > 200) throw invalid("eventId required");
    const event = object(envelope.event);
    const hash = canonical({ event, bindingToken: envelope.bindingToken, launchId: envelope.launchId });
    const existing = this.receipts.get(envelope.eventId);
    if (existing) {
      if (existing.hash !== hash) throw new BridgeError(409, "conflicting_host_event", "An event ID cannot be reused with different content.");
      return existing.result;
    }
    const result = this.processHostEvent(event, envelope.bindingToken, envelope.launchId);
    this.receipts.set(envelope.eventId, { hash, result });
    // Failed events can be retried after their prerequisite reaches the bridge.
    const eventId = envelope.eventId;
    void result.catch(() => { if (this.receipts.get(eventId)?.result === result) this.receipts.delete(eventId); });
    if (this.receipts.size > 10_000) this.receipts.delete(this.receipts.keys().next().value!);
    return result;
  }

  private async processHostEvent(event: ObjectValue, token: unknown, launchId: unknown): Promise<ObjectValue> {
    if (typeof event.session_id !== "string" || !event.session_id || typeof event.cwd !== "string" || !event.cwd || typeof event.hook_event_name !== "string") throw invalid("Factory session_id, cwd and hook_event_name required");
    const cwd = canonicalWorkspacePath(event.cwd);
    const key = `${cwd}\0${event.session_id}`;
    let host = this.hosts.get(key);
    if (event.hook_event_name === "SessionEnd" && token === undefined && launchId !== undefined) {
      // Factory's interactive client emits SessionEnd outside the agent scope
      // that loaded CLAUDE_ENV_FILE. Only the authenticated wrapper launch may
      // identify that exact session, and only when its generation is unique.
      const launch = typeof launchId === "string" ? this.launches.get(launchId) : undefined;
      if (!launch || launch.cwd !== cwd) throw new BridgeError(409, "invalid_host_launch", "Factory client SessionEnd requires its registered wrapper launch and workspace.");
      const owned = [...launch.hosts].filter((candidate) => candidate.sessionId === event.session_id && candidate.cwd === cwd);
      if (!owned.length) throw new BridgeError(409, "host_not_registered", "Factory session is not registered under this wrapper launch.");
      if (owned.length !== 1) throw new BridgeError(409, "ambiguous_host_generation", "Factory client SessionEnd cannot identify a reused session generation without its binding.");
      // An old launch's late acknowledgement must never select a newer host
      // from the global session map, even when the Factory session ID matches.
      host = owned[0]!;
      token = host.token;
    }
    if (!host && event.hook_event_name === "SessionEnd" && typeof token === "string") {
      const owned = this.tokens.get(token);
      // Once an alias becomes dangling, realpath cannot recover its old target.
      // Only the same authenticated generation may end through an alias already
      // observed at registration; this does not authorize new model requests.
      if (owned?.sessionId === event.session_id && cwd === resolve(event.cwd) && owned.cwdAliases.has(cwd)) host = owned;
    }
    if (event.hook_event_name === "SessionStart") {
      const launch = typeof launchId === "string" ? this.launches.get(launchId) : undefined;
      // Once the bridge is serving wrapper launches, a start with no launch is an unrelated Droid session in the same project.
      if (launchId === undefined && this.launches.size > 0) throw new BridgeError(409, "invalid_host_launch", "Factory SessionStart needs a wrapper launch; this session was not started by run-droid or local.");
      if (launchId !== undefined && (!launch || launch.ended || launch.cwd !== cwd)) throw new BridgeError(409, "invalid_host_launch", "Factory launch is unknown, ended or uses another workspace.");
      if (host && !host.ended && launchId !== host.launchId) throw new BridgeError(409, "conflicting_host_launch", "Factory session is already owned by another launch.");
      // Official compact/handoff SessionStart identifies its predecessor. Retire
      // only that authenticated host generation, so copied transcript markers
      // cannot bind the new session to its predecessor or cause ambiguity.
      // Ordinary starts and same-session compaction do not end sibling sessions.
      if (event.source === "compact" && typeof event.previous_session_id === "string"
          && event.previous_session_id !== event.session_id) {
        const previous = this.hosts.get(`${cwd}\0${event.previous_session_id}`);
        if (previous && !previous.drained) {
          if (previous.launchId !== launchId) throw new BridgeError(409, "conflicting_host_launch", "Factory handoff cannot end a session owned by another launch.");
          await this.endHost(previous, false, "Factory compact handoff");
          // Another authenticated start can complete while draining awaits.
          host = this.hosts.get(key);
          if (launch?.ended) throw new BridgeError(409, "invalid_host_launch", "Factory launch ended during handoff.");
          if (host && !host.ended && launchId !== host.launchId) throw new BridgeError(409, "conflicting_host_launch", "Factory session is already owned by another launch.");
        }
      }
      if (host?.ended && !host.drained) throw new BridgeError(409, "host_session_closing", "The prior Factory session is still draining.");
      if (!host || host.ended) {
        host = { token: randomBytes(32).toString("hex"), sessionId: event.session_id, cwd, cwdAliases: new Set([cwd, resolve(event.cwd), ...(launch?.cwdAliases ?? [])]), bridgeSessions: new Set(), ended: false, terminalResults: new Map(), launchId: typeof launchId === "string" ? launchId : undefined };
        this.hosts.set(key, host);
        this.tokens.set(host.token, host);
        launch?.hosts.add(host);
      }
      host.cwdAliases.add(resolve(event.cwd));
      this.observePermissionMode(host, event);
      return { ok: true, bindingToken: host.token, additionalContext: `[factory-cc-session:${host.token}]` };
    }
    if (!host) throw new BridgeError(409, "host_not_registered", "SessionStart must register the Factory session first.");
    if (token !== host.token) throw new BridgeError(409, "stale_host_event", "Factory event is missing its live session generation or belongs to a prior one.");
    if (host.ended) {
      if (!host.drained) await this.endHost(host, false, "Factory SessionEnd retry");
      return { ok: true, alreadyEnded: true };
    }
    this.observePermissionMode(host, event);

    if (event.hook_event_name === "UserPromptSubmit") {
      // Factory can discard the original SessionStart message during its own
      // automatic compaction. Reattach the authenticated generation at each
      // real user turn instead of inferring ownership from compacted text.
      return { ok: true, additionalContext: `[factory-cc-session:${host.token}]` };
    }

    if (event.hook_event_name === "PostToolUse") {
      if (typeof event.tool_name !== "string" || event.tool_input === undefined || event.tool_response === undefined) throw invalid("PostToolUse needs tool_name, tool_input and tool_response");
      const candidates = [...host.bridgeSessions].flatMap((sessionId) => (this.runtime.pendingHostCalls?.(sessionId) ?? [])
        .filter((call) => call.toolName === event.tool_name && canonical(call.input) === canonical(event.tool_input))
        .filter((call) => event.tool_use_id === undefined || event.tool_use_id === call.toolUseId)
        .map((call) => ({ sessionId, call })));
      if (candidates.length > 1) throw new BridgeError(409, "ambiguous_host_tool", "Identical live tool calls need an explicit tool ID.");
      const match = candidates[0];
      // Native/host-only tools that were never sent through this bridge are observational.
      if (!match) return { ok: true, observed: true, matched: false };
      // Factory exec changes permission_mode *before* executing ExitSpecMode.
      // That optimistic change is not approval. Unlock only after the exact
      // pending host tool has a successful authenticated completion receipt.
      if (event.tool_name === "ExitSpecMode" && !hostToolFailed(event)
          && typeof event.permission_mode === "string" && event.permission_mode !== "spec") {
        host.specRestricted = false;
      }
      if (event.tool_name === "EndFeatureRun") {
        const response = event.tool_response;
        const structuredError = response && typeof response === "object" && !Array.isArray(response)
          && ((response as ObjectValue).isError === true || (response as ObjectValue).is_error === true || (response as ObjectValue).error !== undefined);
        host.terminalResults.set(match.sessionId, { toolUseId: match.call.toolUseId, input: event.tool_input, response, isError: event.is_error === true || Boolean(structuredError) });
      }
      return { ok: true, observed: true, matched: true };
    }

    // idle_prompt also means ordinary idle. It does not authorize cancellation.
    const cancelled = event.hook_event_name === "Notification" && (event.notification_type === "cancelled" || event.notification_type === "session_cancelled");
    if (event.hook_event_name === "SessionEnd" || cancelled) {
      await this.endHost(host, cancelled, `Factory SessionEnd: ${String(event.reason ?? "other")}`);
      return { ok: true, ended: true, sessions: host.bridgeSessions.size };
    }
    return { ok: true, observed: true };
  }

  private observePermissionMode(host: HostBinding, event: ObjectValue): void {
    if (typeof event.permission_mode !== "string") return;
    host.permissionMode = event.permission_mode;
    if (event.permission_mode === "spec") host.specRestricted = true;
  }

  private async endHost(host: HostBinding, cancelled: boolean, reason: string): Promise<void> {
    if (host.ending) return host.ending;
    if (host.drained) return;
    host.ended = true;
    const ending = (async () => {
      const errors: unknown[] = [];
      for (const sessionId of host.bridgeSessions) {
        this.cancelApprovals(sessionId);
        const terminal = host.terminalResults.get(sessionId);
        const call = terminal && this.runtime.pendingHostCalls?.(sessionId).find((call) => call.toolUseId === terminal.toolUseId && call.toolName === "EndFeatureRun" && canonical(call.input) === canonical(terminal.input));
        let disposition: "resumable" | "terminal" | "interrupted" = "interrupted";
        let sdkSessionId: string | undefined;
        // Persist replay prohibition before awaiting any live callback cleanup.
        if (this.store.get(sessionId)) {
          this.store.update(sessionId, { hostEnded: "interrupted", ...(cancelled ? { cancelRequested: true } : {}) });
          if (cancelled) this.store.setState(sessionId, "CANCELLED");
        }
        try {
          if (!cancelled && terminal && call && !terminal.isError && this.runtime.completeHostTool) {
            await this.runtime.completeHostTool(sessionId, { ...call, content: typeof terminal.response === "string" ? terminal.response : JSON.stringify(terminal.response), terminal: true });
            disposition = "terminal";
          } else if (cancelled) await this.runtime.cancel(sessionId, "factory-cancelled");
          else {
            const result = await this.runtime.endHostSession?.(sessionId, reason);
            disposition = result?.resumable ? "resumable" : "interrupted";
            sdkSessionId = result?.sdkSessionId;
          }
        } catch (error) {
          errors.push(error);
          this.failures.push(error instanceof BridgeError ? error.code : "host_cleanup_failed");
          try { await this.runtime.cancel(sessionId, "host-completion-failed"); } catch (cancelError) { errors.push(cancelError); }
        }
        const session = this.store.get(sessionId);
        if (session) {
          this.store.update(sessionId, { pendingToolIds: [], hostEnded: disposition, ...(sdkSessionId ? { sdkSessionId } : {}), notes: [...session.notes, cancelled ? "factory-cancelled" : "factory-session-ended"] });
          // A normal exec exit can be resumed later with the same official native checkpoint.
          if (session.state !== "FAILED" && session.state !== "CANCELLED") this.store.setState(sessionId, "IDLE");
        }
      }
      host.drained = true;
      if (errors.length) throw new AggregateError(errors, "Factory session cleanup reported failures");
    })();
    host.ending = ending;
    try { await ending; } catch (error) { host.ending = undefined; throw error; }
  }

  close(): void {
    this.closed = true;
    for (const approval of this.approvals.values()) approval.finish({ behavior: "deny", message: "Controller shut down." });
  }

  describe(): ObjectValue {
    return { pendingApprovals: this.approvals.size, failures: [...this.failures], activeHostSessions: [...this.hosts.values()].filter((host) => !host.ended).length, boundNativeSessions: [...this.hosts.values()].filter((host) => !host.ended).reduce((n, host) => n + host.bridgeSessions.size, 0) };
  }
}

function hostToolFailed(event: ObjectValue): boolean {
  const response = event.tool_response;
  return event.is_error === true || Boolean(response && typeof response === "object" && !Array.isArray(response)
    && ((response as ObjectValue).isError === true || (response as ObjectValue).is_error === true || (response as ObjectValue).error !== undefined));
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("JSON object required");
  return value as ObjectValue;
}
function invalid(message: string): BridgeError { return new BridgeError(400, "invalid_control_request", message); }
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : item;
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}
