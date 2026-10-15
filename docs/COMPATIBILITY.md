# Compatibility matrix

Each row: whether Droid is known to send the field, the SDK counterpart, how Bridge adapts it, the test, and the limit.

| Field | Droid sends? | SDK counterpart | Adaptation | Test | Limit |
|---|---|---|---|---|---|
| `system` string / blocks | **Yes** on `0.241.1` (array of text blocks) | `systemPrompt` preset `claude_code` + stable append | Droid `system` is **not** prepended. It is placed at the end of the user prompt so the Claude Code prefix stays cacheable. | `tests/unit/system-prompt.test.ts` | Block-level cache_control on system is not forwarded. |
| `messages` roles / order / multimodal | **Yes** (user/assistant, tool_result, cache_control ephemeral; first user msg is a tool-catalog reminder) | Streaming input user messages | Text and image blocks preserved. History is mapped per session, not blindly replayed in full. | G0 + protocol + fake relay | Cold-start rebuild of arbitrary edited history is a documented reconstruction mode. |
| `tools` / `input_schema` | **Yes** (Read uses required `file_path` absolute) | `tools: { type: "preset", preset: "claude_code" }` plus MCP for exclusive Droid names | File/shell tools execute in Claude Code. Only Mission lifecycle tools wait on the mailbox. | `tests/unit/droid-tools.test.ts` | Droid `Execute`/`Create` are not MCP’d; they are covered by Bash/Write. |
| `tool_choice` (force / none) | Not present on captured exec requests | No Messages-equivalent force in SDK query | **Not silently treated as honored.** Recorded as unsupported. Prompt text is not used as a fake force. | G0 request summary | May affect Mission roles if Droid relies on forced tools. |
| `stream` | **Yes** (`stream: true`) | `includePartialMessages: true` + live SSE | Token deltas flush as `content_block_delta` while Claude Code is still working. | `tests/unit/sse-stream.test.ts` + protocol SSE | Distinguishes HTTP reply end vs SDK query end. |
| `max_tokens` | Required by Messages | No strict per-HTTP cap | **Not claimed as a hard SDK max.** `maxTurns` is a separate limit. | docs | Do not use Bridge usage as a billing cap. |
| `thinking` / `effort` | Unknown | Claude Code thinking settings | **Not remapped.** Signed thinking is never rewritten. | — | If Droid requires thinking blocks, this is a compatibility boundary. |
| `stop_sequences` | Unknown | none | **Unsupported.** | — | |
| `temperature` / `top_p` / `top_k` | Possible via extraArgs | limited | Passed through only if a live Droid request includes them; `top_k` has no SDK mapping. | — | |
| `cache_control` | Possible | Claude prompt cache | Prefix is kept stable; cache tokens are logged per request when the SDK reports them. MiniMax numbers are not Claude. | `tests/unit/usage.test.ts` | |
| `usage` | Response | SDK result usage | Mock/fake mark `estimated: true`. SDK copies only checkable event fields. | protocol | Session totals are not repeated on every HTTP reply. |
| signed thinking | n/a | Anthropic-signed blocks | Never forged. | — | |
| `stop_reason` / errors | n/a | HTTP mapping | `end_turn`, `tool_use`, 401/409/422/501/502. | protocol | Auth failures do not start the SDK. |

Live Droid request paths and model selector IDs are written into `docs/G0-AIRGAP.md` after the G0 run. `/v1/models` is not used as a health check.
