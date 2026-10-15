# Architecture

```text
Droid chat / Mission roles
  -> localhost Anthropic Messages (POST /v1/messages)
  -> Relay Bridge
  -> official Claude Agent SDK (sdk mode) or mock/fake runtime
  -> unmodified Claude Code
  -> user-authorized Anthropic service

Claude Code built-in Read/Edit/Bash
  -> executed inside unmodified Claude Code (T3-style)
  -> Bridge streams token deltas + tool traces as live SSE

Droid-exclusive tool_use (StartMissionRun, …)
  -> Bridge ends the current HTTP response with native tool_use blocks
  -> Droid approves and runs that Factory tool
  -> next Messages request carries tool_result
  -> mailbox resumes the parked SDK/MCP callback
  -> Claude Code continues
```

## Modes

| Mode | Upstream | Purpose |
|---|---|---|
| `mock` | none | G0 protocol and airgap probes. Zero model cost. |
| `fake` | in-process query stand-in | Prove cross-request tool relay without Claude auth. |
| `sdk` | `@anthropic-ai/claude-agent-sdk` + installed `claude` | Real Claude Code path. Requires user login. |

The HTTP response that carries `tool_use` is finished immediately. The SDK query is not awaited to completion first.

## Isolation

- Bridge listens on `127.0.0.1` only.
- Droid tests use a temporary `HOME` and do not read the operator's `~/.factory`.
- SDK cwd is `BRIDGE_SDK_CWD` / `tmp/bridge-data/sandbox`, not the Droid project.
- `BRIDGE_AUTH=byok` (default) points Claude Code at a probed Anthropic-compatible endpoint via `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (`ANTHROPIC_API_KEY` empty). `BRIDGE_AUTH=subscription` does not touch those three variables.
- That URL is never the Bridge listen address.
- System prompt is Claude Code’s `claude_code` preset plus a stable Droid append. Built-in tools stay enabled.
- First Mission orchestrator turn still emits native `StartMissionRun` when mission files exist, so Worker/Validator sessions start.
- See `docs/T3-ALIGNMENT.md`.

This cloud image cannot create a second OS user or a dedicated network namespace. The gap is recorded in `LIMITATIONS.md`.
