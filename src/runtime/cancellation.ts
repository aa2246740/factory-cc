import type { ContentBlock } from "../types.js";

/**
 * Droid's whole result when the user picks "No, cancel" (each locale of its
 * common:toolExecution.cancelledByUser) or interrupts a tool. Droid sends it as
 * "Error: <text>" and then ends its own turn without another request.
 */
const USER_CANCELLATIONS = new Set([
  "Tool execution cancelled by user", "工具执行已被用户取消", "ツール実行がユーザーによりキャンセルされました",
  "사용자가 도구 실행을 취소했습니다", "Esecuzione dello strumento annullata dall'utente",
  "Tool execution was interrupted", "Request interrupted by user",
]);
export const CANCELLED_TOOL_NOTE = "The user cancelled or interrupted this tool call in Droid. Preserve any work already done. Do not retry it or try another way. Acknowledge the cancellation in one short sentence, then end your turn.";
export const CANCELLED_TURN_DENIAL = "BRIDGE_USER_CANCELLED: The user cancelled the previous tool call in Droid. Do not retry it or use any other tool now; acknowledge the cancellation and end your turn.";

export function allToolsCancelled(
  pendingIds: readonly string[],
  results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>,
): boolean {
  return pendingIds.length > 0 && pendingIds.every((id) => {
    const receipts = results.filter((result) => result.tool_use_id === id);
    return receipts.length > 0 && receipts.every((result) => isUserCancellation(result.content, result.is_error));
  });
}

export function isUserCancellation(content: string | ContentBlock[] | undefined, isError: boolean | undefined): boolean {
  if (!isError) return false;
  const text = typeof content === "string" ? content
    : (content ?? []).map((block) => block.type === "text" && typeof block.text === "string" ? block.text : "\u0000").join("");
  // Droid's session file stores the bare text; only its API request adds the prefix.
  return USER_CANCELLATIONS.has(text.trim().replace(/^Error:\s*/, ""));
}
