import { collectToolResults, lastUserText, textFromBlocks } from "../protocol/content.js";
import { assistantMessage, estimatedUsage } from "../protocol/messages.js";
import { createToolNameMap } from "../protocol/tool-names.js";
import { maybeForceMissionSpawn } from "./mission-tools.js";
import { toolUseId } from "../relay/ids.js";
import { ToolMailbox } from "../relay/mailbox.js";
import type { ContentBlock } from "../types.js";
import { BridgeError } from "../types.js";
import type { BridgeRuntime, RuntimeEvent, RuntimeRequest, RuntimeTurn } from "./types.js";

interface LiveQuery {
  mailbox: ToolMailbox;
  events: RuntimeEvent[];
  cancelled: boolean;
}

/**
 * In-process stand-in for the Claude Agent SDK query loop.
 * It emits native tool_use blocks, parks the handler on the mailbox,
 * and only continues after a later HTTP request delivers tool_result.
 */
export class FakeRuntime implements BridgeRuntime {
  readonly kind = "fake" as const;
  private readonly queries = new Map<string, LiveQuery>();

  async handle(input: RuntimeRequest): Promise<RuntimeTurn> {
    const query = this.query(input.session.bridgeSessionId);
    if (query.cancelled) throw new BridgeError(409, "session_cancelled", input.session.bridgeSessionId);

    const results = collectToolResults(input.request.messages);
    if (results.length > 0) {
      for (const result of results) {
        if (!query.mailbox.hasCall(result.tool_use_id)) {
          throw new BridgeError(409, "unknown_tool_use_id", result.tool_use_id);
        }
        const status = query.mailbox.submitResult(result);
        query.events.push({ at: now(), type: "tool_result_submitted", data: { id: result.tool_use_id, status } });
      }
      const settled = await Promise.all(results.map((r) => query.mailbox.wait(r.tool_use_id, 5_000)));
      const summary = settled.map((r) => `${r.callId}:${textFromBlocks(typeof r.content === "string" ? r.content : r.content)}`).join(" | ");
      const text = `relay-bridge fake: resumed after tool results (${summary})`;
      query.events.push({ at: now(), type: "assistant_final", data: { text } });
      return {
        response: assistantMessage(input.request.model, [{ type: "text", text }], "end_turn", estimatedUsage(input.request, text.length)),
        pendingToolIds: [],
        events: [...query.events],
      };
    }

    const tools = input.request.tools ?? [];
    if (tools.length === 0) {
      const text = `relay-bridge fake: ${lastUserText(input.request.messages) || "ok"}`;
      return {
        response: assistantMessage(input.request.model, [{ type: "text", text }], "end_turn", estimatedUsage(input.request, text.length)),
        pendingToolIds: [],
        events: query.events,
      };
    }

    const map = createToolNameMap(tools.map((t) => t.name));
    const forced = maybeForceMissionSpawn(input.session.notes, tools, lastUserText(input.request.messages));
    const selected = forced
      ? tools.filter((tool) => tool.name === forced.name).slice(0, 1)
      : tools.slice(0, Math.min(requestedToolCount(lastUserText(input.request.messages)), tools.length));
    const blocks: ContentBlock[] = [];
    const pending: string[] = [];
    for (const tool of selected) {
      const id = toolUseId();
      const inputArgs = forced && tool.name === forced.name
        ? forced.input
        : { nonce: lastUserText(input.request.messages) || tool.name };
      query.mailbox.registerCall({
        callId: id,
        originalName: tool.name,
        mcpName: map.toMcp(tool.name),
        input: inputArgs,
      });
      // Park a waiter without blocking the HTTP response. This is the
      // architectural proof: tool_use is returned while the callback lives.
      void query.mailbox.wait(id, 30 * 60 * 1000).catch(() => undefined);
      pending.push(id);
      blocks.push({ type: "tool_use", id, name: tool.name, input: inputArgs });
      query.events.push({
        at: now(),
        type: "sdk_tool_use",
        data: { id, name: tool.name, mcpName: map.toMcp(tool.name) },
      });
    }

    return {
      response: assistantMessage(input.request.model, blocks, "tool_use", estimatedUsage(input.request, 48)),
      pendingToolIds: pending,
      events: [...query.events],
      notes: ["fake-runtime: returned tool_use without waiting for query completion"],
    };
  }

  describe(): Record<string, unknown> {
    return { kind: "fake" };
  }

  async cancel(sessionId: string, reason: string): Promise<void> {
    const query = this.queries.get(sessionId);
    if (!query) return;
    query.cancelled = true;
    query.mailbox.cancel(reason);
  }

  async deliverResults(
    sessionId: string,
    results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>,
  ): Promise<Array<"accepted" | "duplicate">> {
    const query = this.query(sessionId);
    return results.map((result) => query.mailbox.submitResult(result));
  }

  events(sessionId: string): RuntimeEvent[] {
    return this.queries.get(sessionId)?.events ?? [];
  }

  private query(sessionId: string): LiveQuery {
    let query = this.queries.get(sessionId);
    if (!query) {
      query = { mailbox: new ToolMailbox(), events: [], cancelled: false };
      this.queries.set(sessionId, query);
    }
    return query;
  }
}

function requestedToolCount(text: string): number {
  if (/TWO_TOOLS|two tools/i.test(text)) return 2;
  return 1;
}

function now(): string {
  return new Date().toISOString();
}
