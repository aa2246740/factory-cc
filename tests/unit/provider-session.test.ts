import { describe, expect, it } from "vitest";
import { historyMessageHashes, resolveSession, sessionContextHash } from "../../src/sessions/correlate.js";
import type { SessionRecord } from "../../src/sessions/state.js";
import type { Message, MessagesRequest } from "../../src/types.js";

const headers = { "x-bridge-role": "chat" };
const cwd = "/tmp/project-a";
const opening: MessagesRequest = {
  model: "sonnet", max_tokens: 100,
  tools: [{ name: "Read", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "Remember the release codename: Pine." }],
};
const completed: Message[] = [...opening.messages, { role: "assistant", content: [{ type: "text", text: "I will remember Pine." }] }];
const continuation = (model: string): MessagesRequest => ({
  ...opening, model, messages: [...completed, { role: "user", content: "What was the codename?" }],
});

function session(model: string, provider?: SessionRecord["provider"]): SessionRecord {
  const request = { ...opening, model };
  return {
    bridgeSessionId: "bridge-a", droidSessionId: "droid-a", sdkSessionId: "sdk-a", role: "chat",
    state: "IDLE", model, ...(provider ? { provider } : {}), toolNames: ["Read"],
    contextHash: sessionContextHash(headers, request, cwd, provider ?? "claude"),
    requestMessageHashes: historyMessageHashes(request.messages),
    historyMessageHashes: historyMessageHashes(completed),
    createdAt: "", updatedAt: "", pendingToolIds: [], cancelRequested: false, notes: [],
    usage: { input_tokens: 0, output_tokens: 0, estimated: true },
  };
}

describe("provider in the session fingerprint", () => {
  it("keeps a Claude fingerprint identical when provider is omitted", () => {
    expect(sessionContextHash(headers, opening, cwd)).toBe(sessionContextHash(headers, opening, cwd, "claude"));
    expect(sessionContextHash(headers, opening, cwd, "cursor")).not.toBe(sessionContextHash(headers, opening, cwd));
  });

  it("still matches a model switch inside one provider", () => {
    const claude = session("sonnet");
    expect(resolveSession([claude], headers, continuation("opus"), { cwd, allowModelSwitch: true, provider: "claude" }))
      .toMatchObject({ match: claude, reason: "history-prefix" });
    const cursor = session("cursor:composer-2.5", "cursor");
    expect(resolveSession([cursor], headers, continuation("cursor:grok-4.7"), { cwd, allowModelSwitch: true, provider: "cursor" }))
      .toMatchObject({ match: cursor, reason: "history-prefix" });
  });

  it("starts a new session when the request changes owner between Claude and Cursor", () => {
    const claude = session("sonnet");
    expect(resolveSession([claude], headers, continuation("cursor:composer-2.5"), { cwd, allowModelSwitch: true, provider: "cursor" }))
      .toEqual({ reason: "new-session" });
    const cursor = session("cursor:composer-2.5", "cursor");
    expect(resolveSession([cursor], headers, continuation("opus"), { cwd, allowModelSwitch: true, provider: "claude" }))
      .toEqual({ reason: "new-session" });
    expect(() => resolveSession([claude], { ...headers, "x-bridge-session": "droid-a" }, continuation("cursor:composer-2.5"), { cwd, allowModelSwitch: true, provider: "cursor" }))
      .toThrowError(expect.objectContaining({ code: "session_context_changed" }));
  });
});
