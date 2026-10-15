import { createHash } from "node:crypto";
import { header } from "../security/auth.js";
import { collectToolResults, lastUserText } from "../protocol/content.js";
import type { MessagesRequest, RoleTag } from "../types.js";
import { BridgeError } from "../types.js";
import type { SessionRecord } from "./state.js";

export function roleFromHeaders(headers: Record<string, string | string[] | undefined>): RoleTag {
  const raw = (header(headers, "x-bridge-role") ?? "").toLowerCase();
  if (raw === "chat" || raw === "orchestrator" || raw === "worker" || raw === "validator") return raw;
  return "unknown";
}

export function explicitSessionId(headers: Record<string, string | string[] | undefined>, request: MessagesRequest): string | undefined {
  const fromHeader = header(headers, "x-bridge-session") ?? header(headers, "x-session-id");
  if (fromHeader) return fromHeader;
  const meta = request.metadata ?? {};
  for (const key of ["session_id", "sessionId", "user_id"]) {
    const value = meta[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function historyPrefixHash(request: MessagesRequest): string {
  const digest = createHash("sha256");
  digest.update(JSON.stringify({ system: request.system, messages: request.messages }));
  return digest.digest("hex");
}

export function resolveSession(
  sessions: SessionRecord[],
  headers: Record<string, string | string[] | undefined>,
  request: MessagesRequest,
): { match?: SessionRecord; reason: string } {
  const explicit = explicitSessionId(headers, request);
  if (explicit) {
    const hit = sessions.find((s) => s.bridgeSessionId === explicit || s.droidSessionId === explicit);
    if (hit) return { match: hit, reason: "explicit-id" };
  }

  const results = collectToolResults(request.messages);
  if (results.length > 0) {
    const matches = sessions.filter((s) => results.some((r) => s.pendingToolIds.includes(r.tool_use_id)));
    if (explicit && matches.length && matches.some((s) => s.bridgeSessionId !== explicit && s.droidSessionId !== explicit)) {
      throw new BridgeError(409, "cross_session_tool_result", "tool_result does not belong to X-Bridge-Session");
    }
    if (matches.length === 1) return { match: matches[0], reason: "tool-use-id" };
    if (matches.length > 1) {
      throw new BridgeError(409, "ambiguous_session", "multiple sessions claim the same tool_use_id");
    }
  }

  const role = roleFromHeaders(headers);
  const text = lastUserText(request.messages);
  const identical = sessions.filter((s) => {
    if (s.historyHash !== historyPrefixHash(request)) return false;
    if (s.state === "CANCELLED" || s.state === "FAILED") return false;
    return role === "unknown" || s.role === "unknown" || s.role === role;
  });
  if (identical.length > 1 && !results.length && !explicit) {
    throw new BridgeError(
      409,
      "ambiguous_session",
      "identical concurrent prompts require X-Bridge-Session or distinct tool_use ids",
    );
  }

  if (!results.length && text && identical.length === 1 && identical[0]?.state === "IDLE") {
    return { match: identical[0], reason: "idle-history-hash" };
  }

  return { reason: "new-session" };
}
