#!/usr/bin/env bash
# Deny Cursor subagent starts that select Claude/Sonnet/Opus or
# computerUse/browser workers. The Claude Code under test is a CLI/SDK
# process, not a Cursor subagent, and is not gated here.
set -euo pipefail

payload="$(cat || true)"

deny() {
  printf '%s\n' "$1"
  exit 2
}

if [[ -z "${payload}" ]]; then
  exit 0
fi

lower="$(printf '%s' "${payload}" | tr '[:upper:]' '[:lower:]')"

if printf '%s' "${lower}" | grep -Eq '"model"[[:space:]]*:[[:space:]]*"[^"]*(claude|sonnet|opus|gpt-|gemini)'; then
  deny "Blocked subagentStart: only inherit / grok 4.6 is allowed."
fi

if printf '%s' "${lower}" | grep -Eq '"subagent_type"[[:space:]]*:[[:space:]]*"(computeruse|browser)"'; then
  deny "Blocked subagentStart: computerUse/browser workers are denied."
fi

if printf '%s' "${lower}" | grep -Eq '"type"[[:space:]]*:[[:space:]]*"(computeruse|browser)"'; then
  deny "Blocked subagentStart: computerUse/browser workers are denied."
fi

exit 0
