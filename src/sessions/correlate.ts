import { createHash } from "node:crypto";
import { header } from "../security/auth.js";
import { asBlocks, collectToolResults } from "../protocol/content.js";
import type { ContentBlock, Message, MessagesRequest, RoleTag } from "../types.js";
import { BridgeError } from "../types.js";
import { isEnded, type SessionRecord } from "./state.js";
import { canonicalWorkspacePath } from "../workspace.js";

type Headers = Record<string, string | string[] | undefined>;

export function roleFromHeaders(headers: Headers): RoleTag {
  const raw = (header(headers, "x-bridge-role") ?? "").toLowerCase();
  if (raw === "chat" || raw === "orchestrator" || raw === "worker" || raw === "validator") return raw;
  return "unknown";
}

export function explicitSessionId(headers: Headers, request: MessagesRequest): string | undefined {
  const fromHeader = header(headers, "x-bridge-session") ?? header(headers, "x-session-id");
  if (fromHeader) return fromHeader;
  const meta = request.metadata ?? {};
  // user_id identifies a user, not a conversation. Sharing it must never merge
  // that user's independent chat and Mission sessions.
  for (const key of ["session_id", "sessionId"]) {
    const value = meta[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function historyPrefixHash(request: MessagesRequest): string {
  return hash({ system: request.system, messages: request.messages });
}

/** Fingerprint complete messages, including tool inputs/results and images. */
export function historyMessageHashes(messages: Message[]): string[] {
  return messages.map((message) => hash({ role: message.role, content: normalizedContent(message.content) }));
}

/**
 * Execution settings belong to the native session and must remain stable.
 * Droid's system field is host context, not Claude Code's system prompt: it may
 * change between turns and the runtime appends those changes to the conversation.
 * Its tool catalog is dynamic too: ToolSearch can add, remove or replace schemas
 * through the live MCP registry without changing the native conversation.
 * Identity still requires an explicit ID, pending tool ownership, or a unique
 * complete transcript prefix; host context and catalogs never identify a session.
 */
export function sessionContextHash(headers: Headers, request: MessagesRequest, cwd?: string): string {
  const workspace = cwd ?? process.env.BRIDGE_SDK_CWD ?? header(headers, "x-bridge-cwd");
  return hash({
    model: request.model,
    role: roleFromHeaders(headers),
    cwd: workspace ? canonicalWorkspacePath(workspace) : null,
    thinking: request.thinking,
  });
}

export function resolveSession(
  sessions: SessionRecord[],
  headers: Headers,
  request: MessagesRequest,
  options: { cwd?: string; hostSessionId?: string; allowModelSwitch?: boolean } = {},
): { match?: SessionRecord; reason: string } {
  const explicit = explicitSessionId(headers, request);
  const contextHash = sessionContextHash(headers, request, options.cwd);
  const switchingModel = (session: SessionRecord): boolean => options.allowModelSwitch === true && session.model !== request.model;
  // Keep the persisted fingerprint format: old checkpoints include their model.
  // Substitute only that field when checking a requested switch, so role,
  // workspace and thinking configuration remain part of session identity.
  const compatibleContextHash = (session: SessionRecord): string => switchingModel(session)
    ? sessionContextHash(headers, { ...request, model: session.model }, options.cwd)
    : contextHash;
  const assertSelectedContext = (session: SessionRecord, authenticatedThinkingChange = false): void => {
    if (!authenticatedThinkingChange) assertContext(session, compatibleContextHash(session), headers, request);
    if (!switchingModel(session)) return;
    if (isEnded(session)) {
      throw new BridgeError(409, "session_unavailable", "This session has ended; start a new session.");
    }
    if (session.state !== "IDLE" || session.pendingToolIds.length > 0 || session.cancelRequested) {
      throw new BridgeError(409, "model_switch_busy", "Model changes require an idle session with no pending tool calls; finish the current turn first.");
    }
  };
  const results = collectToolResults(request.messages);
  // Factory keeps old tool_results in its history. An ended session can no
  // longer consume one, so it must not own the conversation they appear in.
  const owners = sessions.filter((session) => !isEnded(session)
    && results.some((result) => session.pendingToolIds.includes(result.tool_use_id)));
  if (owners.length === 0) {
    // Only a request that does nothing but return the abandoned tool's result is
    // a retry. Any new user content makes it a new turn over imported history.
    const latest = request.messages.at(-1);
    const latestBlocks = latest?.role === "user" ? asBlocks(latest.content) : [];
    if (latestBlocks.length > 0 && latestBlocks.every((block) => block.type === "tool_result")) {
      const retried = collectToolResults([latest!]);
      const held = (session: SessionRecord): string[] => [...(session.endedToolIds ?? []), ...session.pendingToolIds];
      if (sessions.some((session) => isEnded(session) && retried.some((result) => held(session).includes(result.tool_use_id)))) {
        throw new BridgeError(409, "session_unavailable", "This tool result belongs to a session that was cancelled, timed out or interrupted. Its tool call will not be replayed; send a new message to continue in a new session.");
      }
    }
  }
  const incoming = historyMessageHashes(request.messages);
  const workspace = options.cwd ? canonicalWorkspacePath(options.cwd) : undefined;
  // Factory changes its request-side thinking default when a model is selected.
  // The native runtime does not forward that host setting. Permit this metadata
  // difference only after a complete history or authenticated retained turn
  // proves continuity, and independently prove every other fingerprint field.
  // Explicit IDs alone and tool-free auxiliary requests do not get this exception.
  // contextHash currently contains only model/role/cwd/thinking. Any future
  // execution field added there must also be checked here before this exception.
  const canChangeHostThinking = (session: SessionRecord): boolean => switchingModel(session)
    && Boolean(session.contextHash) && Boolean(options.hostSessionId) && Boolean(workspace)
    && session.factorySessionId === options.hostSessionId && session.factoryCwd !== undefined
    && canonicalWorkspacePath(session.factoryCwd) === workspace
    && session.role === roleFromHeaders(headers)
    && session.toolNames.length > 0 && Boolean(request.tools?.length);
  const historyContextMatches = (session: SessionRecord): boolean => session.contextHash === compatibleContextHash(session)
    || canChangeHostThinking(session);
  const inHostScope = (session: SessionRecord): boolean => !options.hostSessionId || !session.factorySessionId
    || (session.factorySessionId === options.hostSessionId && (!workspace || (session.factoryCwd !== undefined && canonicalWorkspacePath(session.factoryCwd) === workspace)));
  const assertHostScope = (session: SessionRecord): void => {
    if (!inHostScope(session)) throw new BridgeError(409, "cross_host_session", "The native session belongs to another Factory session.");
  };
  const hasCompleteHistory = (session: SessionRecord): boolean => {
    const completed = session.historyMessageHashes;
    // A common opening prompt cannot identify a conversation: require its
    // completed response too, followed by a new user turn.
    return Boolean(completed && completed.length > 0 && completed.length < incoming.length
      && request.messages[completed.length]?.role === "user"
      && completed.every((fingerprint, index) => incoming[index] === fingerprint));
  };
  const tail = incoming.slice(-3);
  const tailMessages = request.messages.slice(-3);
  const hasAuthenticatedTail = (session: SessionRecord): boolean => {
    const completed = session.historyMessageHashes;
    return Boolean(options.hostSessionId && workspace && request.tools?.length
      && tail.length === 3 && tailMessages[0]?.role === "user" && tailMessages[1]?.role === "assistant"
      && tailMessages[2]?.role === "user"
      && !asBlocks(tailMessages[2].content).some((block) => block.type === "tool_result")
      && session.factorySessionId === options.hostSessionId && session.factoryCwd !== undefined
      && canonicalWorkspacePath(session.factoryCwd) === workspace
      && session.sdkSessionId && session.toolNames.length > 0
      && completed !== undefined && completed.length >= 2
      && session.requestMessageHashes?.at(-1) === completed.at(-2)
      && completed.at(-2) === tail[0] && completed.at(-1) === tail[1]);
  };

  if (explicit) {
    const hits = sessions.filter((session) => session.bridgeSessionId === explicit || session.droidSessionId === explicit);
    if (hits.length > 1) throw ambiguous("multiple sessions claim the explicit session ID");
    const hit = hits[0];
    if (owners.some((owner) => owner !== hit)) {
      throw new BridgeError(409, "cross_session_tool_result", "tool_result does not belong to X-Bridge-Session");
    }
    if (hit) {
      assertHostScope(hit);
      assertSelectedContext(hit, canChangeHostThinking(hit) && (hasCompleteHistory(hit) || hasAuthenticatedTail(hit)));
      return { match: hit, reason: "explicit-id" };
    }
    // An explicit new conversation may intentionally share the same prompt.
    return { reason: "new-explicit-session" };
  }

  if (owners.length > 1) throw ambiguous("tool results belong to multiple sessions");
  if (owners[0]) {
    assertHostScope(owners[0]);
    assertSelectedContext(owners[0]);
    return { match: owners[0], reason: "tool-use-id" };
  }

  const candidates = sessions.filter((session) => {
    if (!inHostScope(session)) return false;
    if (isEnded(session)) return false;
    if (!historyContextMatches(session)) return false;
    return hasCompleteHistory(session);
  });
  if (candidates.length > 1) throw ambiguous("multiple transcripts match this history; supply X-Bridge-Session");
  if (candidates[0]) {
    assertSelectedContext(candidates[0], canChangeHostThinking(candidates[0]));
    return { match: candidates[0], reason: "history-prefix" };
  }

  // Factory compaction rewrites the prefix but retains the last complete turn.
  // Reuse native history only with both authenticated host ownership and an
  // exact user/assistant tail, followed by exactly one new user message. Neither
  // a summary-looking prompt nor a host ID alone can establish continuity.
  // Tool-free auxiliary requests remain independent, even if they copy context.
  const authenticatedTail = sessions.filter((session) => {
      return hasAuthenticatedTail(session) && historyContextMatches(session)
        // Identify a genuine model-switch continuation before rejecting busy
        // state; filtering it out would silently fork the native conversation.
        && (switchingModel(session) || (session.state === "IDLE" && !session.cancelRequested && session.pendingToolIds.length === 0))
        && !isEnded(session);
    });
  if (authenticatedTail.length > 1) throw ambiguous("multiple authenticated Factory transcripts match the retained turn; supply X-Bridge-Session");
  if (authenticatedTail[0]) {
    assertSelectedContext(authenticatedTail[0], canChangeHostThinking(authenticatedTail[0]));
    return { match: authenticatedTail[0], reason: "authenticated-history-tail" };
  }

  const activeDuplicates = sessions.filter((session) => {
    if (!inHostScope(session)) return false;
    if (session.state !== "NEW" && session.state !== "GENERATING" && session.state !== "RESUMING") return false;
    if (session.contextHash && session.contextHash !== compatibleContextHash(session)) return false;
    const pending = session.requestMessageHashes;
    return pending
      ? pending.length === incoming.length && pending.every((fingerprint, index) => incoming[index] === fingerprint)
      : session.historyHash === historyPrefixHash(request);
  });
  if (activeDuplicates.length) {
    throw ambiguous("identical concurrent prompts require X-Bridge-Session or distinct tool_use IDs");
  }
  return { reason: "new-session" };
}

function assertContext(session: SessionRecord, contextHash: string, headers: Headers, request: MessagesRequest): void {
  // Legacy records do not have full context fingerprints. Explicit IDs and
  // tool ownership still isolate them, while checking all available metadata.
  const legacyMismatch = !session.contextHash && (
    session.model !== request.model
    || (roleFromHeaders(headers) !== "unknown" && session.role !== roleFromHeaders(headers))
  );
  if (legacyMismatch || (session.contextHash && session.contextHash !== contextHash)) {
    throw new BridgeError(409, "session_context_changed", "model, role, workspace or execution settings changed; start a new session");
  }
}

function ambiguous(message: string): BridgeError {
  return new BridgeError(409, "ambiguous_session", message);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function normalizedContent(content: string | ContentBlock[] | undefined): unknown[] {
  return asBlocks(content).map((block) => {
    // Ignore only the actual protocol annotation. A tool input may legitimately
    // have a field named cache_control, and that field must remain significant.
    const normalized = Object.fromEntries(Object.entries(block).filter(([key]) => key !== "cache_control"));
    if (block.type === "tool_result" && (typeof block.content === "string" || Array.isArray(block.content))) {
      normalized.content = normalizedContent(block.content as string | ContentBlock[]);
    }
    return normalized;
  });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}
