# Architecture

```text
Droid chat / Mission roles
  -> localhost Anthropic Messages (POST /v1/messages)
  -> Relay Bridge
  -> official Claude Agent SDK (sdk mode) or mock/fake runtime
  -> unmodified Claude Code
  -> user-authorized Anthropic service

Claude Code tool_use
  -> Bridge ends the current HTTP response with native tool_use blocks
  -> Droid approves and runs its own tools
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
- `ANTHROPIC_BASE_URL` and proxy variables are stripped before launching Claude Code so the SDK cannot loop back into Bridge.
- `tools: []` removes Claude Code built-ins. That is not OS isolation.

This cloud image cannot create a second OS user or a dedicated network namespace. The gap is recorded in `LIMITATIONS.md`.
