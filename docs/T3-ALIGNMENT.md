# T3-style Relay Bridge

Cola chose T3 Code’s approach: keep Claude Code looking like Claude Code (most stable, least detectable), and only bolt Factory Droid on the side.

## What the previous code did

`SdkRuntime.startQuery` **replaced** the system prompt and **disabled** built-in tools:

- `systemPrompt: { type: "custom", prompt: buildSystemPrompt(...) }` — a full replace. Claude Code’s default `claude_code` prompt was not used.
- The custom string started with “You are running inside Relay Bridge” and “Claude Code built-in file tools are disabled.”
- Droid `system`, role, and Mission appendix were mixed into that same custom string (dynamic prefix → poor cache).
- `tools: []` removed Read / Edit / Bash / Grep / Glob. Every Droid tool was registered as MCP and parked on the mailbox. Claude Code never executed file or shell tools itself.
- `includePartialMessages: false`. HTTP SSE dumped the finished message in one shot (`writeMessageSse`).
- `canUseTool` always returned `allow`.
- `sdkEnv` always overwrote `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and emptied `ANTHROPIC_API_KEY`.

## What it does now

| Lever | T3-style behavior |
|---|---|
| System prompt | `{ type: "preset", preset: "claude_code", append: STABLE_DROID_APPEND, snapshot: true, excludeDynamicSections: true }` |
| Tools | `{ type: "preset", preset: "claude_code" }` — Claude Code runs Read/Edit/Write/Bash/Glob/Grep itself |
| Droid tools | MCP server `droid` exposes **only** Factory-exclusive names: `StartMissionRun`, `ProposeMission`, `EndFeatureRun`, `DismissHandoffItems`, `TaskOutput`, `TaskStop` |
| Droid UI | Claude Code built-in calls are traced as live assistant text (`[Read] path`). Exclusive tools still return native `tool_use` so Droid executes them |
| Permissions | `BRIDGE_PERMISSION=ask` maps write/shell `canUseTool` onto an advertised Droid tool when one exists. BYOK e2e uses `bypass` |
| Streaming | `includePartialMessages: true`; token deltas go out as Anthropic SSE `content_block_delta` while the HTTP request is still open |
| Auth | `BRIDGE_AUTH=subscription` does **not** set or overwrite `ANTHROPIC_BASE_URL` / `AUTH_TOKEN` / `API_KEY` (Cola’s Mac login). Default `byok` keeps MiniMax/GLM injection |
| Cache | Stable append only. Role, user text, and Droid `system` sit at the **end** of the user prompt. Each SDK result logs `cache_creation_input_tokens` and `cache_read_input_tokens` |

## Coexistence decision

1. **Claude Code built-ins win** for anything Claude already has (Read, Edit, Write, Bash, Glob, Grep, Skill, Task). Droid’s `Execute` / `Create` / `LS` are treated as covered; they are not registered as MCP.
2. **Droid-exclusive MCP** is the only path for Mission lifecycle. Those handlers wait on the mailbox; Droid runs the tool and the next Messages request resumes Claude Code.
3. **Do not** echo Claude Code built-in calls as Droid `tool_use`. That would make Droid execute the same work again and deadlock the mailbox. Traces in the streamed text are how Droid’s transcript shows them.
4. **`canUseTool`** surfaces write/shell approval to Droid only when a matching Droid tool is advertised (`Bash`→`Execute`, `Write`→`Create`/`Edit`). Read-only built-ins auto-allow. If nothing maps, Bridge allows and logs `permission_passthrough`.

## Still different from T3

- Relay Bridge is still an Anthropic Messages proxy in front of Droid, not T3’s own UI.
- Mission spawn (`StartMissionRun` synthesis when files exist) is Factory-specific.
- Cloud tests use MiniMax-M2.5 BYOK, not a Claude subscription. Cache hit numbers from MiniMax are **not** representative of Claude prompt cache.
- `settingSources` are not forced empty, but BYOK still isolates `CLAUDE_CONFIG_DIR` under the bridge data dir so host `~/.claude` is not read. Subscription mode leaves `CLAUDE_CONFIG_DIR` alone.
- Droid plugins that are not in the exclusive list never reach Claude Code as MCP tools.
- Token counting remains HTTP 501.
