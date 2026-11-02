import { createHash } from "node:crypto";
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

const TOOL_CALL = /^TOOL_CALL: (\S+) input=(\{.*\})$/;

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
  return block?.type === "text" && typeof block.text === "string" && block.text.startsWith(COMPACTION_SUMMARY) ? block.text : undefined;
}

/** Where the generated summary body may end and Droid's retained lists begin. */
const SUMMARY_BODY_ENDS = ["</summary>", "Current TODO List:", "IMPORTANT: This summary was created"];

/**
 * Identifies which Droid compaction a conversation continues from. The summary
 * message is resent with every request: its generated body stays the same, while the
 * lists after it (todos, skills, images) may change. So only the
 * text before the first such marker is compared, at most 4000 characters of it.
 */
export function compactionSummaryKey(request: MessagesRequest): string | undefined {
  const text = compactedSummaryText(request);
  if (!text) return undefined;
  const end = Math.min(4000, ...SUMMARY_BODY_ENDS.map((marker) => text.indexOf(marker)).filter((index) => index >= 0));
  return createHash("sha256").update(text.slice(0, end)).digest("hex");
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
