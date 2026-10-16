export interface NativeProofRow { sdkSessionId: string; type: string; message?: { content?: unknown } }
type Block = Record<string, unknown>;
function blocks(row: NativeProofRow): Block[] { return Array.isArray(row.message?.content) ? row.message.content as Block[] : []; }
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return (value as Block[]).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}
function correctJson(value: string, expected: { sum: number; nonce: string }): boolean {
  return [...value.matchAll(/\{[^{}]*\}/g)].some(([candidate]) => {
    try { const parsed = JSON.parse(candidate); return Object.keys(parsed).sort().join(",") === "nonce,sum" && parsed.sum === expected.sum && parsed.nonce === expected.nonce; } catch { return false; }
  });
}

/** Join actual parent tool call/result and a distinct native child's prompt,
 * Read call/result and final JSON. Strings alone cannot prove delegation. */
export function verifyGeneratedDroidDelegation(rows: NativeProofRow[], expected: { sum: number; nonce: string }, name = "relay-json-auditor") {
  const sessions = new Map<string, NativeProofRow[]>();
  for (const row of rows) { const group = sessions.get(row.sdkSessionId) ?? []; group.push(row); sessions.set(row.sdkSessionId, group); }
  const candidates: Array<Record<string, unknown>> = [];
  for (const [parentId, parent] of sessions) {
    const start = parent.findIndex((row) => row.type === "user" && text(row.message?.content).startsWith("Use Factory Task to delegate to the project custom droid"));
    if (start < 0) continue;
    let end = parent.length;
    for (let index = start + 1; index < parent.length; index++) if (parent[index]!.type === "user" && text(parent[index]!.message?.content)) { end = index; break; }
    const turn = parent.slice(start, end);
    const calls = turn.flatMap((row) => row.type === "assistant" ? blocks(row) : []).filter((block) => block.type === "tool_use");
    const parentNoNativeFileAccess = !calls.some((call) => /(?:^|__)(?:Read|Grep|Glob|LS|Bash|Execute|Write|Create|Edit)$/.test(String(call.name)));
    for (const call of calls) {
      const input = call.input as Record<string, unknown> | undefined;
      if (call.name !== "mcp__droid__Task" || input?.subagent_type !== name || input.await !== true || typeof input.prompt !== "string") continue;
      const callback = turn.flatMap((row) => row.type === "user" ? blocks(row) : []).find((block) => block.type === "tool_result" && block.tool_use_id === call.id);
      const successfulTaskResult = Boolean(callback && callback.is_error !== true && correctJson(text(callback.content), expected));
      const factoryChildSessionId = callback ? /session_id:\s*([a-f0-9-]{36})/i.exec(text(callback.content))?.[1] : undefined;
      for (const [childId, child] of sessions) {
        if (childId === parentId) continue;
        const firstUser = child.find((row) => row.type === "user" && text(row.message?.content));
        const opening = text(firstUser?.message?.content);
        if (!opening.includes(input.prompt)) continue;
        const read = child.flatMap((row) => row.type === "assistant" ? blocks(row) : []).find((block) => block.type === "tool_use" && block.name === "Read"
          && /(?:^|\/)input\.json$/.test(String((block.input as Record<string, unknown> | undefined)?.file_path)));
        const readResult = read && child.flatMap((row) => row.type === "user" ? blocks(row) : []).find((block) => block.type === "tool_result" && block.tool_use_id === read.id);
        const readSucceeded = Boolean(readResult && readResult.is_error !== true && text(readResult.content).includes(expected.nonce));
        const childFinal = child.filter((row) => row.type === "assistant" && text(row.message?.content)).at(-1);
        const parentFinal = turn.filter((row) => row.type === "assistant" && text(row.message?.content)).at(-1);
        const checks = { parentFactoryTask: true, awaited: true, taskResultSucceeded: successfulTaskResult,
          factoryChildSessionIdPresent: Boolean(factoryChildSessionId), distinctNativeChild: true, childTaskPromptMatches: true,
          nonceAbsentFromChildPrompt: !opening.includes(expected.nonce), childReadSucceeded: readSucceeded,
          childFinalJsonCorrect: correctJson(text(childFinal?.message?.content), expected), parentFinalJsonCorrect: correctJson(text(parentFinal?.message?.content), expected),
          parentNoNativeFileAccessDuringDelegation: parentNoNativeFileAccess };
        candidates.push({ status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", checks, parentSdkSessionId: parentId, childSdkSessionId: childId,
          factoryChildSessionId, taskCallId: call.id, childReadCallId: read?.id, expected,
          observedChain: { parentTaskCall: call, parentTaskResult: callback, childReadCall: read, childReadResult: readResult,
            childFinalText: text(childFinal?.message?.content), parentFinalText: text(parentFinal?.message?.content) },
          scope: "Parent did not access files during the delegation turn. Earlier generation-command turns may have read the fixture." });
      }
    }
  }
  return candidates.find((candidate) => candidate.status === "PASS") ?? { status: "FAIL", candidates, reason: "No complete matching parent Task and distinct child Read/result chain." };
}
