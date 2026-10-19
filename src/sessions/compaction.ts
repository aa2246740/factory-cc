import { asBlocks } from "../protocol/content.js";
import type { MessagesRequest } from "../types.js";
import { COMPACTION_SUMMARY } from "../workspace.js";

/**
 * Droid compacts a conversation in two requests. A tool-free summarizer gets the
 * transcript as text, each tool call written `TOOL_CALL: <name> input=<json>` and
 * followed by its `TOOL_RESULT`. Droid then continues with a first message that
 * starts with COMPACTION_SUMMARY and quotes the summary it received.
 */

export interface SummarizedToolCall { name: string; input: unknown }

const TOOL_CALL = /^TOOL_CALL: (\S+) input=(\{.*\})$/gm;

/** The last tool call a summarizer transcript shows answered, or undefined. */
export function lastSummarizedToolCall(request: MessagesRequest): SummarizedToolCall | undefined {
  const text = request.messages.filter((message) => message.role === "user")
    .flatMap((message) => asBlocks(message.content))
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : "")).join("\n");
  let last: RegExpExecArray | undefined;
  for (const match of text.matchAll(TOOL_CALL)) last = match;
  if (!last || !text.slice(last.index! + last[0].length).includes("TOOL_RESULT")) return undefined;
  try {
    return { name: last[1]!, input: JSON.parse(last[2]!) };
  } catch {
    return undefined;
  }
}

/** The text of a compacted conversation's leading summary block, or undefined. */
export function compactedSummaryText(request: MessagesRequest): string | undefined {
  const first = request.messages.find((message) => message.role === "user");
  const block = first ? asBlocks(first.content)[0] : undefined;
  return block?.type === "text" && typeof block.text === "string" && block.text.startsWith(COMPACTION_SUMMARY) ? block.text : undefined;
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
