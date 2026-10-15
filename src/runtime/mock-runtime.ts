import { collectToolResults, lastUserText, textFromBlocks } from "../protocol/content.js";
import { assistantMessage, estimatedUsage } from "../protocol/messages.js";
import { toolUseId } from "../relay/ids.js";
import { ToolMailbox } from "../relay/mailbox.js";
import type { ContentBlock } from "../types.js";
import { BridgeError } from "../types.js";
import { pickSafeReadonlyTool } from "./safe-tools.js";
import type { BridgeRuntime, RuntimeRequest, RuntimeTurn } from "./types.js";

const TEXT_OK = "relay-bridge mock: text probe ok";
const TOOL_OK_PREFIX = "relay-bridge mock: tool result accepted";

export class MockRuntime implements BridgeRuntime {
  readonly kind = "mock" as const;
  private readonly mailboxes = new Map<string, ToolMailbox>();
  private readonly expected = new Map<string, string>();

  constructor(private readonly canaryPath: string) {}

  async handle(input: RuntimeRequest): Promise<RuntimeTurn> {
    const mailbox = this.mailbox(input.session.bridgeSessionId);
    const results = collectToolResults(input.request.messages);
    if (results.length > 0) {
      const statuses: Array<"accepted" | "duplicate"> = [];
      for (const result of results) {
        if (!mailbox.hasCall(result.tool_use_id)) {
          throw new BridgeError(409, "unknown_tool_use_id", result.tool_use_id);
        }
        statuses.push(mailbox.submitResult(result));
      }
      const body = results.map((r) => textFromBlocks(typeof r.content === "string" ? r.content : r.content)).join("\n");
      const expected = this.expected.get(input.session.bridgeSessionId);
      const verified = expected ? body.includes(expected) : body.length > 0;
      const text = verified
        ? `${TOOL_OK_PREFIX}; canary=${expected ?? "present"}`
        : `${TOOL_OK_PREFIX}; canary_mismatch`;
      return {
        response: assistantMessage(input.request.model, [{ type: "text", text }], "end_turn", estimatedUsage(input.request, text.length)),
        pendingToolIds: [],
        notes: [`mock-tool-results:${statuses.join(",")}`],
      };
    }

    const userText = lastUserText(input.request.messages);
    const wantsTool = /RELAY_TOOL_PROBE|read the canary|use a tool|list tools/i.test(userText);
    if (wantsTool || (input.request.tools?.length && /RELAY_/.test(userText))) {
      const picked = pickSafeReadonlyTool(input.request.tools, extractPath(userText) ?? this.canaryPath);
      if (!picked.plan) {
        throw new BridgeError(422, "no_safe_tool", picked.error ?? "no safe tool", {
          tools: picked.schemas.map((t) => ({ name: t.name, input_schema: t.input_schema })),
        });
      }
      const id = toolUseId();
      mailbox.registerCall({ callId: id, originalName: picked.plan.tool.name, mcpName: picked.plan.tool.name, input: picked.plan.input });
      const canary = extractCanary(userText);
      if (canary) this.expected.set(input.session.bridgeSessionId, canary);
      return {
        response: assistantMessage(
          input.request.model,
          [{ type: "tool_use", id, name: picked.plan.tool.name, input: picked.plan.input }],
          "tool_use",
          estimatedUsage(input.request, 32),
        ),
        pendingToolIds: [id],
        notes: [picked.plan.reason],
      };
    }

    return {
      response: assistantMessage(input.request.model, [{ type: "text", text: TEXT_OK }], "end_turn", estimatedUsage(input.request, TEXT_OK.length)),
      pendingToolIds: [],
      notes: ["mock-text"],
    };
  }

  async cancel(sessionId: string): Promise<void> {
    this.mailboxes.get(sessionId)?.cancel("mock-cancel");
  }

  async deliverResults(
    sessionId: string,
    results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>,
  ): Promise<Array<"accepted" | "duplicate">> {
    const mailbox = this.mailbox(sessionId);
    return results.map((result) => mailbox.submitResult(result));
  }

  private mailbox(sessionId: string): ToolMailbox {
    let box = this.mailboxes.get(sessionId);
    if (!box) {
      box = new ToolMailbox();
      this.mailboxes.set(sessionId, box);
    }
    return box;
  }
}

function extractPath(text: string): string | undefined {
  const match = text.match(/CANARY_PATH=(\S+)/);
  return match?.[1];
}

function extractCanary(text: string): string | undefined {
  const match = text.match(/RELAY_CANARY_([A-Za-z0-9]+)/);
  return match ? `RELAY_CANARY_${match[1]}` : undefined;
}
