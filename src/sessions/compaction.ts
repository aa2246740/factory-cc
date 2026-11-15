import { asBlocks, systemText } from "../protocol/content.js";
import type { MessagesRequest } from "../types.js";
import { isDroidCompactionSummary } from "../workspace.js";

/**
 * Droid compacts a conversation in two requests. A tool-free summarizer gets the
 * transcript as text, each tool call written `TOOL_CALL: <name> input=<json>` and
 * followed by its `TOOL_RESULT`. Droid then continues with a first message that
 * starts with one of Droid's summary headings and quotes the summary it received.
 */

export interface SummarizedToolCall { name: string; input: unknown }

const TOOL_CALL = /^TOOL_CALL: (\S+) input=(\{.*\})$/;

/** A first compaction may summarize only startup context, before any tool call. */
export function isDroidSummarizerRequest(request: MessagesRequest): boolean {
  if (request.messages.length !== 1 || request.messages[0]?.role !== "user") return false;
  const blocks = asBlocks(request.messages[0].content);
  if (!blocks.length || blocks.some((block) => block.type !== "text")) return false;
  const text = blocks.map((block) => block.type === "text" ? block.text : "").join("\n").trim();
  const system = systemText(request.system);
  return text.startsWith("Please summarize the following conversation:\n```\n")
    && text.endsWith("\n```\n\nRemember to wrap your final summary in <summary> tags.")
    && system.includes("Summarize this conversation or agent trajectory so the assistant can continue effectively after compaction.")
    && system.includes("Return the summary inside <summary> tags.");
}

/** The last tool call a summarizer transcript shows answered, or undefined. */
export function lastSummarizedToolCall(request: MessagesRequest): SummarizedToolCall | undefined {
  const text = request.messages.filter((message) => message.role === "user")
    .flatMap((message) => asBlocks(message.content))
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : "")).join("\n");
  let actor: string | undefined;
  let last: { match: RegExpExecArray; answered: boolean } | undefined;
  for (const row of text.split(/\r?\n/)) {
    const header = /^(USER|ASSISTANT|TOOL): /.exec(row);
    if (header) actor = header[1];
    const line = header ? row.slice(header[0].length) : row;
    // Calls inside a tool's returned transcript are data, not outer host calls.
    if (actor === "ASSISTANT" || actor === undefined) {
      const match = TOOL_CALL.exec(line);
      if (match) last = { match, answered: false };
    }
    if (last && (actor === "TOOL" || actor === undefined) && /^TOOL_RESULT\b/.test(line)) last.answered = true;
  }
  if (!last?.answered) return undefined;
  try {
    return { name: last.match[1]!, input: JSON.parse(last.match[2]!) };
  } catch {
    return undefined;
  }
}

/** The text of a compacted conversation's leading summary block, or undefined. */
export function compactedSummaryText(request: MessagesRequest): string | undefined {
  const first = request.messages.find((message) => message.role === "user");
  const block = first ? asBlocks(first.content)[0] : undefined;
  return block?.type === "text" && typeof block.text === "string" && isDroidCompactionSummary(block.text) ? block.text : undefined;
}

/** What Droid quotes of a summary: it replaces the closing tag with its own TODO list. */
export function summaryQuote(summary: string): string {
  return summary.trim().replace(/<\/summary>\s*$/, "").trim();
}

export function sameToolInput(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}
