import { createHash } from "node:crypto";
import { header } from "../security/auth.js";
import { asBlocks, collectToolResults } from "../protocol/content.js";
import type { ContentBlock, Message, MessagesRequest, RoleTag } from "../types.js";
import { BridgeError } from "../types.js";
import type { SessionRecord } from "./state.js";
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
  options: { cwd?: string; hostSessionId?: string } = {},
): { match?: SessionRecord; reason: string } {
  const explicit = explicitSessionId(headers, request);
  const contextHash = sessionContextHash(headers, request, options.cwd);
  const results = collectToolResults(request.messages);
  const owners = sessions.filter((session) => results.some((result) => session.pendingToolIds.includes(result.tool_use_id)));
  const workspace = options.cwd ? canonicalWorkspacePath(options.cwd) : undefined;
  const inHostScope = (session: SessionRecord): boolean => !options.hostSessionId || !session.factorySessionId
    || (session.factorySessionId === options.hostSessionId && (!workspace || (session.factoryCwd !== undefined && canonicalWorkspacePath(session.factoryCwd) === workspace)));
  const assertHostScope = (session: SessionRecord): void => {
    if (!inHostScope(session)) throw new BridgeError(409, "cross_host_session", "The native session belongs to another Factory session.");
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
      assertContext(hit, contextHash, headers, request);
      return { match: hit, reason: "explicit-id" };
    }
    // An explicit new conversation may intentionally share the same prompt.
    return { reason: "new-explicit-session" };
  }

  if (owners.length > 1) throw ambiguous("tool results belong to multiple sessions");
  if (owners[0]) {
    assertHostScope(owners[0]);
    assertContext(owners[0], contextHash, headers, request);
    return { match: owners[0], reason: "tool-use-id" };
  }

  const incoming = historyMessageHashes(request.messages);
  const candidates = sessions.filter((session) => {
    if (!inHostScope(session)) return false;
    if (session.state === "CANCELLED" || session.state === "FAILED" || session.hostEnded === "terminal" || session.hostEnded === "interrupted") return false;
    if (session.contextHash !== contextHash) return false;
    const completed = session.historyMessageHashes;
    // Require the actual previous response as well as its request. Matching a
    // common opening user prompt alone can attach a new conversation to another
    // user's active process. Appended messages must start a user turn.
    return completed && completed.length > 0 && completed.length < incoming.length
      && request.messages[completed.length]?.role === "user"
      && completed.every((fingerprint, index) => incoming[index] === fingerprint);
  });
  if (candidates.length > 1) throw ambiguous("multiple transcripts match this history; supply X-Bridge-Session");
  if (candidates[0]) return { match: candidates[0], reason: "history-prefix" };

  const activeDuplicates = sessions.filter((session) => {
    if (!inHostScope(session)) return false;
    if (session.state !== "NEW" && session.state !== "GENERATING" && session.state !== "RESUMING") return false;
    if (session.contextHash && session.contextHash !== contextHash) return false;
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
