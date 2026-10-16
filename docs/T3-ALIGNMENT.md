# T3-style Relay Bridge

Relay Bridge borrows T3's integration structure: use the official Agent SDK and unmodified Claude Code, preserve Claude Code's native prompt and tools, and expose host-specific actions through MCP. The purpose is compatibility and maintainability. This architecture does not establish official support, authorization, or any guarantee about account enforcement.

## What the T3 source establishes

The comparison is pinned to T3 commit `339179f50a84dc599cce373dbb48f172f182f44e`:

| Boundary | Pinned source | Application here |
|---|---|---|
| Native session | [Streaming input queue and official query](https://github.com/pingdotgg/t3code/blob/339179f50a84dc599cce373dbb48f172f182f44e/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L731-L794) | Keep Claude Code's live conversation; an HTTP tool handoff is not the end of its query. |
| Native prompt/tools | [Query options and preset append](https://github.com/pingdotgg/t3code/blob/339179f50a84dc599cce373dbb48f172f182f44e/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1117-L1177) | Use the official preset and an explicit host appendix, without rebuilding Claude's internal prompt. |
| External orchestration | [T3-owned orchestration operations](https://github.com/pingdotgg/t3code/blob/339179f50a84dc599cce373dbb48f172f182f44e/docs/orchestration-v2/orchestrator-mcp-server.md#L5-L17) and [namespaced MCP registration](https://github.com/pingdotgg/t3code/blob/339179f50a84dc599cce373dbb48f172f182f44e/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L1223-L1249) | Factory orchestration, skills, task IDs and plugin operations retain Factory ownership behind `mcp__droid__*`. They are not native Claude subagent operations merely because names overlap. |
| Native skills | [Claude skill discovery](https://github.com/pingdotgg/t3code/blob/339179f50a84dc599cce373dbb48f172f182f44e/apps/server/src/provider/Drivers/ClaudeSkills.ts#L1-L11) and [skill dispatch](https://github.com/pingdotgg/t3code/blob/339179f50a84dc599cce373dbb48f172f182f44e/apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts#L43-L78) | T3 discovers Claude-native skills and turns known `$skill` mentions into native slash invocations. It does not translate Factory skills/custom droids. Bridge preserves native slash-command placement; Factory skills execute through Droid's MCP Skill tool. |

T3 also has an application event store, projections, command receipts and transactional outbox described in its [architecture](https://github.com/pingdotgg/t3code/blob/339179f50a84dc599cce373dbb48f172f182f44e/AGENTS.md#L137-L141). Bridge's in-memory mailbox and response queue do not reproduce that durable orchestration system or its recovery guarantees.

## Current integration

| Part | Behavior |
|---|---|
| Query lifetime | One streaming-input `query({ prompt: AsyncIterable, options })` per live session. New user turns enter the same input queue; an HTTP response ending does not end the SDK query. |
| System prompt | Only `{ type: "preset", preset: "claude_code", append: STABLE_DROID_APPEND }`. Prompt recording and dynamic-section handling follow the installed CLI's defaults; the adapter does not explicitly set `snapshot` or `excludeDynamicSections`. |
| Host context | Nonempty Droid system text is preserved as the host's role/skill/workflow instructions in user input, without header-derived role appendices. Workspace context is added separately. Earlier native messages are retained, not rebuilt on each turn. |
| Native tools | Keep `tools: { type: "preset", preset: "claude_code" }`. Only concrete file/shell equivalents in Droid's catalog are covered by native execution: Read/Edit/Write/Create/LS/Grep/Glob/Execute/Bash/MultiEdit/NotebookEdit. |
| Droid MCP | Every other advertised host tool is registered under `mcp__droid__*`, including Factory Skill/Task/ToolSearch/ExitSpecMode, Mission controls and unknown plugin tools. Factory skill definitions and task IDs remain separate from native Claude Skill/Agent. |
| Dynamic catalog | Retain the same SDK MCP server instance and publish complete JSON Schemas. Schema/description changes get deterministic revision names; `tools/list_changed` plus `mcpServerStatus` confirms the exact revision before continuation. Unchanged definitions retain their revision. Ajv validates arguments without coercion, stripping or default filling. |
| Tool round trip | Return the actual host `tool_use` to Droid, keep its MCP callback waiting, and deliver the matching `tool_result` to that callback. Mixed text/base64 images and changed host context are labeled and attached once to the first fresh result, without a separate SDK user turn. Unsupported MCP content, including mixed documents, returns 422 before consuming pending results. |
| Role | `X-Bridge-Role` is a model-configuration/session tag; actual Factory Task subagents can inherit an orchestrator header. Host instructions take precedence. Only absent host instructions enable role fallback, and orchestrator guidance additionally requires real Mission controls. |
| Permissions | Every native call must have a currently advertised Factory equivalent, including in explicit bypass mode. Authenticated Spec stays read-only until its matching successful ExitSpecMode receipt. Default `ask` additionally waits on a live Deferred for calls reaching `canUseTool`, controlled by authenticated local UI/CLI. Expiry, cancellation and old generations deny. |
| Authentication | BYOK requires an explicit endpoint/model/key variable, removes competing backend/auth selectors, and isolates `CLAUDE_CONFIG_DIR`. Missing keys fail closed. Subscription mode preserves host credentials/configuration; no real subscription was exercised in this validation. |
| Recovery | Persist the SDK session ID and use native `resume` after restart or bounded idle-process eviction. Pending MCP callbacks cannot survive a process restart and are rejected with 409. |
| Mission | Real SDK tool calls drive Mission lifecycle. No forced Mission spawn or automatic copying of ledger files from old workspaces occurs in the SDK runtime. Supply the current mission directory explicitly. |

Official references: [streaming input](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [sessions and resume](https://platform.claude.com/docs/en/agent-sdk/sessions), [permissions](https://platform.claude.com/docs/en/agent-sdk/permissions), and [dynamic MCP tool updates](https://code.claude.com/docs/en/mcp#dynamic-tool-updates). The installed SDK version is pinned in `package.json`; its public type documentation distinguishes per-turn `result.usage` from cumulative `result.modelUsage`. Tool-list notification alone is not a refresh acknowledgement: Bridge also checks the CLI-visible names before continuation.

Claude Code can allow operations under its native rules without calling `canUseTool`. The adapter's approval dialog applies to operations that reach that callback, while the separate PreToolUse capability/Spec guard checks every native call. Native Bash does not invoke Factory's risk or Shield classifier; explicit bypass must not be described as Factory auto-low policy.

The [2026-10-16 surface report](FACTORY-SURFACES.md) records the subsequent fixes and current scoped evidence. Factory's automatic/manual compaction now preserves native continuity through authenticated exact history-tail matching. UserPromptSubmit renews the stripped binding marker after Factory drops its initial context, and a real compact/handoff lifecycle event retires only its authenticated predecessor. Ambiguous, active or unrelated sessions are never merged on a similar summary.

## 缓存与压缩验证

2026-10-15, before the latest Factory tool expansion: unmodified Claude Code with GLM-5.2 BYOK was compared with the same SDK path through Bridge. Each path completed three conversational turns and retained a codeword across turns. The raw upstream response fields for turns 2 and 3 were:

| Path | Turn | `input_tokens` | `cache_read_input_tokens` |
|---|---:|---:|---:|
| Native SDK / Claude Code | 2 | 211 | 21,056 |
| Native SDK / Claude Code | 3 | 108 | 21,248 |
| Bridge / Claude Code | 2 | 74 | 21,248 |
| Bridge / Claude Code | 3 | 98 | 21,312 |

Within each path, the system hash and tools hash stayed identical over all three turns. Both paths used the same tool schemas; Bridge's stable append at that time added 546 system-prompt characters, so its system hash correctly differed from native. The current append and host-tool surface have since expanded. These measurements demonstrate cache-read activity and stable prefixes in the recorded runs; they are not current dynamic-catalog acceptance or proof that Bridge is cheaper or universally improves cache hit rate. Generated output and conversation lengths differed.

GLM did not send `cache_creation_input_tokens` in the recorded wire responses. Missing is not measured zero. The SDK may normalize it to zero, so Bridge retains `coverage: partial` and does not compute an exact total cache-hit ratio from those responses. SDK `provider: firstParty` is a transport classification, not evidence that GLM is an Anthropic model or officially supported; `costBasis: unknown` and `costUSD` are not the provider's actual bill.

A real Droid continuation test also passed: two `droid exec` invocations, with the second using the first Droid session ID, retained one Bridge session and one native SDK session. Recall succeeded. Claude Code's observed provider-message usage for the second turn was 196 input tokens and 21,120 cache-read tokens. These are Claude Code-side measurements; Droid's own displayed totals were not used for this conclusion.

A separate Bridge run sent native `/compact Preserve codeword`. The SDK reported `compact_boundary` with `trigger: manual`, `pre_tokens: 21543`, and `post_tokens: 1918`; the next turn correctly recalled the codeword. The compact command returned HTTP 200 with empty text and provider-message usage `unknown`, because that summary request was not exposed as ordinary assistant stream usage. The wire recorder observed a real summary request and the separate SDK cumulative usage increased. **Unknown provider usage does not mean zero tokens or zero cost.**

A later [automatic-compaction test](../evidence/auto-compaction-validation-2026-10-15.json) used the documented `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40` and `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000` only in an isolated probe. After synthetic conversation growth, the official SDK and native transcript both recorded `trigger: auto`, `pre_tokens: 90038`, `post_tokens: 2245`. No `/compact` request was sent. Two subsequent recall checks passed in the same native session, and the next turn reported 155 input / 17,920 cache-read tokens. This verifies native automatic triggering with a lowered threshold; it does not establish default-threshold production behavior or real Claude subscription billing. All probe sessions closed without runtime errors or pending work.

The [sanitized validation summary](../evidence/native-session-validation-2026-10-15.json) records these measurements and the then-current successful offline/build/type checks. Original wire records remain in the isolated validation workspace. These results are separate from the repository's historical MiniMax evidence and do not validate real Claude subscription behavior or the later host-tool expansion.

Additional live GLM checks exercised a native `Read`, its streamed tool trace, and continuation from the full returned history without an explicit bridge session ID; the same session retained the earlier information. An actual official SDK MCP `TaskOutput` call also completed its `tool_use` / `tool_result` round trip. Its external result was a deterministic local fixture, not a real Factory Mission acceptance run.

## Subsequent Factory host validation

The historical [Factory host validation](../evidence/factory-host-validation-2026-10-15.json) records real BYOK hot-add with a deterministic external ToolSearch/FactoryProbe fixture. The newer [schema revision validation](../evidence/native-schema-validation-2026-10-16-r2.json) also verifies exact replacement-schema visibility on the first invocation in the same native query. Revision names resolve the old status API's lack of schema versions; stale proposals are not forwarded. This is a real native SDK probe with a synthetic host fixture, not an actual Factory plugin invocation.

Actual Droid Skill execution also returned and used its full instruction body. Droid Task launched two readiness subagents, and real ProposeMission and StartMissionRun calls succeeded. Those subagents inherited an orchestrator model header, confirming that host instructions must determine the actual workflow role. These checks are distinct from the earlier TaskOutput fixture and historical forced-spawn/ledger-copy results.

An earlier unseeded full Mission failed and was stopped: native MCP rejected incomplete EndFeatureRun arguments, but the old Bridge had already forwarded the assistant event, leading to callback-association errors. The correction publishes only after actual handler entry and joins native call identity with canonical arguments. The evidence's `validatedHandoffRetry` records a passing independent official CLI + GLM BYOK probe: native `-32602` rejected invalid arguments, a corrected EndFeatureRun with reordered fields caused exactly one external fixture execution, and the same SDK session returned the correct final answer. Factory's completed state cannot override an SDK error.

The subsequent [full Mission acceptance](../evidence/mission-validation-2026-10-15.json) is PASS_WITH_RECOVERY. A fresh, unseeded fixture ran through actual orchestrator, worker and validator roles. It reached the old 20-minute harness limit after all five assertions passed, before the final validator completed. Official `droid exec --session-id` continued the same Mission, retained completed feature worker identities and finished in about 130 seconds. All three features completed, original tests/package.json were preserved, and tests passed. Before cleanup there were no native turns, tool callbacks, approvals or Bridge errors. Owned-process cleanup also passed. The timeout and a rejected CLI flag combination are recorded separately; this is not an uninterrupted pass. The harness default is now one hour.

Successful EndFeatureRun can terminate a Factory worker without another tool_result request. The installed official Factory hook adapter now provides a separate authenticated lifecycle channel. SessionStart registers a random generation and supplies it via Factory's environment file; model-visible binding metadata is removed before native input. PostToolUse records the actual tool result, and SessionEnd confirms termination before terminal callback cleanup. Ordinary tool results still use the HTTP continuation so dynamic catalogs and supplemental context cannot race ahead. Normal idle notifications never imply cancellation. The run-droid wrapper registers exact launch ownership and forwards exit/cancel events only to those sessions.

The local `/control` page and CLI implement the T3-style permission Deferred flow. Real official CLI + GLM BYOK checks confirm denial causes no file write and approval causes exactly one native Bash execution. Approval authority is in memory, tied to the original native callback, and cannot be restored from a stale receipt after restart.

REA was reviewed at [c61c108b522de1a2b46e65b59360c9be66fb038e](https://github.com/morluto/rea/tree/c61c108b522de1a2b46e65b59360c9be66fb038e). It is a reverse-engineering MCP/CLI, not a Claude orchestration adapter. Its PendingOperations and process-ownership patterns informed once-only settlement, generation checks and bounded cleanup. No REA implementation dependency or copied source was added.

The fresh [2026-10-16 Mission](../evidence/mission-final-validation-2026-10-16-r3.json) completed uninterrupted in 1126 seconds. All three features and five assertions passed, both required validators ran, each completed worker had a matching EndFeatureRun transcript, original tests were preserved and green, and owned cleanup left no processes. Earlier interrupted attempts remain recorded. The [final summary](../evidence/final-validation-2026-10-16.json) distinguishes its exact runtime fingerprint from three later independently verified changes.

## Accounting and cache boundaries

`UsageLedger` merges `message_start`, partial `message_delta`, and repeated assistant blocks by provider message ID. Missing counters stay unknown. SDK `modelUsage` is kept as a separate latest cumulative snapshot: it can include subagents, sidechains and compaction, inherit usage from a resumed session, or reset after `/clear`. SDK `result.usage` is main-agent per-turn usage and is retained separately. These scopes are never added together.

Changing a session ID alone does not imply a prompt-cache miss. Model/provider cache policy and the actual token prefix matter: tool schemas/order, native system prompt, the stable append, and any dynamic material before a cache boundary. Updating the MCP catalog can change that prefix and cause a miss while preserving the session. Native session continuity keeps prior conversation intact; compaction legitimately changes the history prefix and may require a new cache entry. The adapter leaves prompt-recording behavior to CLI defaults; the recorded request hashes establish prefix stability only in the measured runs.

## Boundaries compared with a native client

- Bridge adds an Anthropic Messages ingress, Droid session matching and Factory MCP handling; it is not the complete T3 application.
- Explicit IDs, a unique complete history prefix, or the narrowly authenticated compaction-tail rule identify continuation. Incompatible model/role/workspace/execution-policy changes are rejected; tool catalogs update in place. A cold history import is reference reconstruction, not restoration of an exact native transcript or signed thinking state.
- Advertised Factory/plugin tools use namespaced MCP unless they are concrete file/shell equivalents. The bridge does not automatically translate Factory skills/custom droids into Claude-native definitions. BYOK's isolated config does not inherit ordinary user-level Claude skills automatically.
- Local UI/CLI approvals are connected, but process loss cannot restore pending MCP callbacks or permission authority. Preserving the SDK session ID does not recover those waiting handlers.
- Live new-tool hot-add, Factory Skill/Task, invalid-call/corrected-retry handoff and full Mission completion with official recovery have been exercised. The recorded Mission needed recovery after a harness timeout; that historical run alone establishes neither uninterrupted completion nor real Claude subscription behavior. The fresh uninterrupted run above now covers completion for its recorded source fingerprint. Historical forced-spawn/ledger-copy results are not current acceptance.
- Token counting remains HTTP 501. See [Compatibility](COMPATIBILITY.md) and [Limitations](LIMITATIONS.md).
