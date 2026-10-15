import { describe, expect, it } from "vitest";
import { historyPrefixHash, resolveSession } from "../../src/sessions/correlate.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import { BridgeError } from "../../src/types.js";

function session(partial: Partial<SessionRecord>): SessionRecord {
  return {
    bridgeSessionId: "sess_a",
    role: "chat",
    state: "IDLE",
    model: "relay-probe",
    toolNames: [],
    createdAt: "",
    updatedAt: "",
    pendingToolIds: [],
    cancelRequested: false,
    notes: [],
    usage: { input_tokens: 0, output_tokens: 0, estimated: true },
    ...partial,
  };
}

describe("session correlation", () => {
  it("matches continuation by tool_use_id", () => {
    const req = {
      model: "relay-probe",
      max_tokens: 16,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      ],
    };
    const hit = resolveSession([session({ pendingToolIds: ["toolu_1"] })], {}, req);
    expect(hit.match?.bridgeSessionId).toBe("sess_a");
    expect(hit.reason).toBe("tool-use-id");
  });

  it("rejects identical concurrent prompts without a channel id", () => {
    const req = {
      model: "relay-probe",
      max_tokens: 16,
      messages: [{ role: "user" as const, content: "same" }],
    };
    const hash = historyPrefixHash(req);
    const sessions = [
      session({ bridgeSessionId: "s1", historyHash: hash, state: "GENERATING" }),
      session({ bridgeSessionId: "s2", historyHash: hash, state: "GENERATING" }),
    ];
    expect(() => resolveSession(sessions, {}, req)).toThrow(BridgeError);
  });
});
