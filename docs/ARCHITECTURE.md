# Architecture

```text
Droid chat / Mission roles
  -> localhost Anthropic Messages (POST /v1/messages)
  -> Relay Bridge
  -> official Claude Agent SDK (sdk mode) or mock/fake runtime
  -> unmodified Claude Code
  -> configured Anthropic-compatible BYOK endpoint or existing Claude authentication

Claude Code built-in Read/Edit/Bash
  -> executed inside unmodified Claude Code (T3-style)
  -> Bridge streams token deltas + tool traces as live SSE

Droid-owned tool_use (Skill, Task, ToolSearch, ExitSpecMode, Mission, plugins, …)
  -> namespaced mcp__droid__* call in Claude Code
  -> Bridge ends the current HTTP response with native tool_use blocks
  -> Droid approves and runs that Factory tool
  -> next Messages request carries tool_result and optional host text/images
  -> Bridge attaches labeled host continuation to the first fresh result
  -> mailbox resumes the parked SDK/MCP callback
  -> Claude Code continues
```

## Modes

| Mode | Upstream | Purpose |
|---|---|---|
| `mock` | none | G0 protocol and airgap probes. Zero model cost. |
| `fake` | in-process query stand-in | Prove cross-request tool relay without Claude auth. |
| `sdk` | `@anthropic-ai/claude-agent-sdk` + installed `claude` | Native Claude Code execution with explicitly configured BYOK or the user's existing CLI authentication. |

The HTTP response that carries `tool_use` is finished immediately. The SDK query is not awaited to completion first.

Each live bridge session owns one streaming SDK query and input queue. A native `result` ends one user turn, not the process. Later turns append input, while MCP results resolve the original waiting handler. Completed sessions can release an idle process and resume its exact persisted SDK session ID. A pending MCP callback cannot survive a bridge restart; that case returns an explicit conflict instead of replaying the operation.

Only concrete file/shell equivalents from Droid's tool catalog are covered by native execution: Read/Edit/Write/Create/LS/Grep/Glob/Execute/Bash/MultiEdit/NotebookEdit. Every native invocation checks current advertised authority in PreToolUse, including bypass and post-approval revocation. Authenticated Spec stays read-only until a matching successful ExitSpecMode receipt. Other advertised tools stay with Droid, including its Skill/Task registries, ToolSearch, ExitSpecMode and plugins. The Claude preset is preserved, but its Skill/Agent tools do not acquire authority from similarly named Factory entities.

Each live query keeps one mutable `droid` MCP server instance. A new tool catalog updates registrations and sends `tools/list_changed`; it does not change session identity. Schema/description changes get deterministic revision names, so the `mcpServerStatus` name barrier confirms the exact revision before continuation. Real BYOK new-tool and replacement-schema probes both succeeded on the first continuation. Full JSON Schema constraints are advertised through the public MCP list handler and validated without coercion/default filling by Ajv. Unchanged definitions keep stable names; genuine prefix changes can miss prompt cache. Model, role-configuration tag, workspace and execution policy still define a compatible session.

Nonempty Factory `system` instructions own the actual role, skills and workflow. Bridge preserves them without adding header-derived role instructions: real Task subagents can inherit an orchestrator header. Only missing host instructions enable role fallback, with actual Mission controls required for orchestrator guidance. `X-Bridge-Role` remains a model-configuration/session tag.

Mixed tool-result requests carry supplementary host text/base64 images inside a labeled real MCP result, rather than an extra native user turn. Documents and unsupported MCP content are validated before submission and return 422 without consuming pending results. Actual Droid Skill full-body delivery, Task subagents and Mission proposal/start passed live checks. Earlier premature-handoff failures remain in the [Factory host evidence](../evidence/factory-host-validation-2026-10-15.json); the historical [Mission](../evidence/mission-validation-2026-10-15.json) completed with official recovery, and the fresh [2026-10-16 Mission](../evidence/mission-final-validation-2026-10-16-r3.json) passed uninterrupted with source fingerprints and complete cleanup.

The handoff correction waits for actual MCP handler entry and joins it with the native assistant call using canonical arguments before publication to Droid. Native schema or permission rejection must remain inside the SDK. An independent official CLI + GLM BYOK probe passed native `-32602` rejection followed by a corrected, field-reordered EndFeatureRun: exactly one external fixture execution and the correct final answer in the same SDK session. Complete Mission acceptance remains unpassed.

The application control channel is independent of model requests:

```text
Factory SessionStart -> authenticated hook endpoint -> generation binding
Factory PostToolUse -> observe the actual result (no early model continuation)
Factory SessionEnd -> settle terminal result and close the owned native query
Native canUseTool -> pending local approval -> allow/deny -> native execution
Owned Droid launch signal/exit -> scoped cancellation/close -> native cleanup
```

Factory's official environment file carries generation identity to later hooks. Binding markers are stripped before native input. Session-end results and approval decisions are once-only and bound to current ownership. Normal idle events never authorize cancellation; missing or ambiguous tool identities fail closed. The controller does not persist authority to replay provider side effects after restart.

## Isolation

- Bridge listens on `127.0.0.1` by default.
- Droid tests use explicit settings and `FACTORY_HOME_OVERRIDE` rather than the operator's Factory login.
- SDK cwd defaults to `tmp/bridge-data/sandbox`. For a real Droid project, explicitly set `BRIDGE_SDK_CWD` to the same workspace used by the hook; mismatched workspaces are rejected.
- `BRIDGE_AUTH=byok` (default) points Claude Code at a probed Anthropic-compatible endpoint via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (`ANTHROPIC_API_KEY` empty). `BRIDGE_AUTH=subscription` does not touch those three variables.
- That URL is never the Bridge listen address.
- System prompt is Claude Code’s `claude_code` preset plus a stable Droid append. Built-in tools stay enabled.
- Mission tools run only when Claude Code actually calls a registered Droid MCP tool. The bridge does not synthesize `StartMissionRun` or copy artifacts from unrelated missions.
- Permissions default to `ask`. Native rules remain active; unresolved decisions pause on the authenticated control UI/CLI. The runtime checks callback generation again before allowing execution. Expiry and cancellation deny. Explicit `bypass` uses the SDK's native permission mode.
- See `docs/T3-ALIGNMENT.md`.

Configuration-directory isolation is not an operating-system sandbox. Native settings, hooks, plugins and tools must be included in the deployment's trust boundary. See `LIMITATIONS.md` for remaining protocol boundaries and validation scope.
