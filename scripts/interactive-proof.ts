export interface NativeProofRow { sdkSessionId: string; type: string; message?: { content?: unknown } }
type Block = Record<string, unknown>;
export function verifyTerminalLifecycleDelivery(terminal: string) {
  const lines = terminal.split("\n"), failures: Array<{ event: string; reason: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    const event = /^\s*Hooks (SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|SessionEnd|Notification|Stop|SubagentStop)\b/.exec(lines[index]!)?.[1];
    if (!event) continue;
    const block = lines.slice(index, index + 5).join("\n");
    const reason = /Exit code [1-9]\d*|Factory lifecycle bridge unavailable; event delivery failed\.|Factory SessionEnd has no agent binding or wrapper launch;[^\n]*/.exec(block)?.[0];
    if (reason && !failures.some((failure) => failure.event === event && failure.reason === reason)) failures.push({ event, reason });
  }
  const reservedFailureMessages = [...new Set(terminal.match(/Factory lifecycle bridge unavailable; event delivery failed\.|Factory SessionEnd has no agent binding or wrapper launch;[^\n]*/g) ?? [])];
  return { status: failures.length || reservedFailureMessages.length ? "FAIL" : "PASS", failures, reservedFailureMessages };
}
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

function conversationTurn(rows: NativeProofRow[], prompt: string): NativeProofRow[][] {
  const sessions = new Map<string, NativeProofRow[]>();
  for (const row of rows) { const group = sessions.get(row.sdkSessionId) ?? []; group.push(row); sessions.set(row.sdkSessionId, group); }
  return [...sessions.values()].flatMap((session) => {
    const start = session.findIndex((row) => row.type === "user" && text(row.message?.content).includes(prompt));
    if (start < 0) return [];
    let end = session.length;
    for (let index = start + 1; index < session.length; index++) if (session[index]!.type === "user" && text(session[index]!.message?.content)) { end = index; break; }
    return [session.slice(start, end)];
  });
}

/** A completed native response, not merely a pause between MCP calls. */
export function nativePromptHasFinalResponse(rows: NativeProofRow[], prompt: string, requiredOpeningText?: string): boolean {
  return conversationTurn(rows, prompt).some((turn) => {
    if (requiredOpeningText && !text(turn[0]?.message?.content).includes(requiredOpeningText)) return false;
    const last = turn.filter((row) => row.type === "assistant").at(-1);
    return Boolean(last && text(last.message?.content).trim() && !blocks(last).some((block) => block.type === "tool_use"));
  });
}

/** Prove that an unhinted request discovered the real Factory skill and that
 * its successful callback preceded the native generator's successful result.
 * The caller separately reads the resulting definition and checks capabilities. */
export function verifyNaturalDroidGeneration(rows: NativeProofRow[], expected: {
  prompt: string; skillBody: string; skillDescription: string; generatedPath: string;
}) {
  const candidates: Array<Record<string, unknown>> = [];
  for (const turn of conversationTurn(rows, expected.prompt)) {
    const ordered = turn.flatMap((row) => blocks(row).map((block) => ({ rowType: row.type, block })));
    const calls = ordered.filter(({ rowType, block }) => rowType === "assistant" && block.type === "tool_use");
    const opening = text(turn[0]?.message?.content);
    // Factory abbreviates long descriptions with an ellipsis in its actual
    // available-skills reminder. Match the exact registered name and advertised
    // prefix against installation metadata, then require the complete callback.
    const advertisedDescription = /^relay-droid: (.+)$/m.exec(opening)?.[1]?.trim();
    const advertisedPrefix = advertisedDescription?.replace(/(?:…|\.\.\.)$/, "");
    const registryMatches = opening.includes("Available skills (name:") && Boolean(advertisedPrefix && advertisedPrefix.length >= 40)
      && (advertisedDescription === expected.skillDescription || Boolean(advertisedDescription?.endsWith("…") || advertisedDescription?.endsWith("...")) && expected.skillDescription.startsWith(advertisedPrefix!));
    const skillIndex = ordered.findIndex(({ rowType, block }) => rowType === "assistant" && block.type === "tool_use"
      && block.name === "mcp__droid__Skill" && (block.input as Block | undefined)?.skill === "relay-droid");
    const skill = ordered[skillIndex]?.block;
    const skillResultIndex = skill ? ordered.findIndex(({ rowType, block }) => rowType === "user" && block.type === "tool_result" && block.tool_use_id === skill.id) : -1;
    const skillResult = ordered[skillResultIndex]?.block;
    const shellIndex = ordered.findIndex(({ rowType, block }, index) => index > skillResultIndex && rowType === "assistant" && block.type === "tool_use"
      && block.name === "Bash" && String((block.input as Block | undefined)?.command).includes(".factory/commands/relay-droid.sh"));
    const shell = ordered[shellIndex]?.block;
    const shellResultIndex = shell ? ordered.findIndex(({ rowType, block }) => rowType === "user" && block.type === "tool_result" && block.tool_use_id === shell.id) : -1;
    const shellResult = ordered[shellResultIndex]?.block;
    const final = turn.filter((row) => row.type === "assistant" && text(row.message?.content)).at(-1);
    const checks = {
      unhintedNaturalRequest: !/relay-droid|\bskill\b|\.factory|(?:^|\s)\/[a-z]/i.test(expected.prompt),
      discoveredRegisteredSkill: registryMatches,
      realFactorySkillCall: skillIndex >= 0,
      completeSuccessfulSkillCallback: skillResultIndex > skillIndex && skillResult?.is_error !== true && Boolean(expected.skillBody.trim()) && text(skillResult?.content).includes(expected.skillBody.trim()),
      generatorAfterSkillCallback: shellIndex > skillResultIndex && skillResultIndex > skillIndex,
      nativeGeneratorSucceeded: shellResultIndex > shellIndex && shellResult?.is_error !== true && text(shellResult?.content).includes("RELAY_DROID_GENERATION_COMPLETE")
        && text(shellResult?.content).includes(`Created Droid: ${expected.generatedPath}`),
      noAutomaticChildInvocation: !calls.some(({ block }) => /(?:^|__)(?:Task|Agent)$/.test(String(block.name))),
      noDirectDefinitionWrites: !calls.some(({ block }) => /(?:^|__)(?:Write|Create|Edit|MultiEdit)$/.test(String(block.name))),
      noPrematureFixtureRead: !calls.some(({ block }) => /(?:^|__)(?:Read|Grep|Glob)$/.test(String(block.name)) && /(?:^|\/)input\.json$/.test(String((block.input as Block | undefined)?.file_path ?? (block.input as Block | undefined)?.path))),
      finalResponsePresent: nativePromptHasFinalResponse(turn, expected.prompt),
    };
    candidates.push({ status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", checks, parentSdkSessionId: turn[0]?.sdkSessionId,
      observedChain: { advertisedSkill: advertisedDescription ? `relay-droid: ${advertisedDescription}` : undefined, skillCall: skill, skillResult, generatorCall: shell, generatorResult: shellResult, finalText: text(final?.message?.content) },
      scope: "One ordinary Chinese creation request; no explicit command or skill hint. Generated capabilities and file side effects are checked independently by the PTY harness." });
  }
  return candidates.find((candidate) => candidate.status === "PASS") ?? { status: "FAIL", candidates, reason: "No complete natural-request → Factory Skill → native generator chain." };
}

export function verifyOrdinaryChatRouting(rows: NativeProofRow[], prompt: string, expectedAnswer: string) {
  const candidates = conversationTurn(rows, prompt).map((turn) => {
    const calls = turn.flatMap((row) => row.type === "assistant" ? blocks(row) : []).filter((block) => block.type === "tool_use");
    const final = turn.filter((row) => row.type === "assistant" && text(row.message?.content)).at(-1);
    const checks = { finalAnswerCorrect: text(final?.message?.content).trim() === expectedAnswer, noToolsInvoked: calls.length === 0,
      finalResponsePresent: nativePromptHasFinalResponse(turn, prompt) };
    return { status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", checks, parentSdkSessionId: turn[0]?.sdkSessionId, finalText: text(final?.message?.content), toolCalls: calls };
  });
  return candidates.find((candidate) => candidate.status === "PASS") ?? { status: "FAIL", candidates, reason: "Ordinary chat invoked a tool or did not return the requested answer." };
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
