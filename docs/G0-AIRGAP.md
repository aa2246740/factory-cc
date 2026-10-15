# G0 Airgap + BYOK probe

Date (UTC): 2026-10-15. Droid `0.241.1`. Claude Code `2.1.292`. Node `v22.14.0`. SDK `@anthropic-ai/claude-agent-sdk@0.3.300`.

Installers (saved then executed):

- `https://app.factory.ai/cli` → `scripts/official/install-droid.sh` SHA-256 `43f68651f45f6033a0f003b0ebc3baa20aa865a38f23a5b2ee1b39d49a03ccb7`
- `https://claude.ai/install.sh` → `scripts/official/install-claude.sh` SHA-256 `3a68d3406cf674e17bed1733a4dcf37805e2e47d87417700007d7e1aa766a944`

Isolated Droid HOME was a fresh temp directory. No `FACTORY_API_KEY`. Bridge ran in `mock` mode. Tokens were local `BRIDGE_CLIENT_TOKEN` values, not Anthropic keys.

Raw cases: `evidence/g0-2026-10-15T02-20-53-209Z/` and `evidence/g0-supplemental/`.

## Answers required by the plan

1. **Does this public CLI recognize `FACTORY_AIRGAP_ENABLED`?** Yes, on `0.241.1`. The binary contains the name. `droid doctor` with the variable set reports “Airgap Mode forbids hosted requests / release requests / hosted authentication”. Without custom models, `droid exec` says Airgap Mode is enabled and refuses the default Factory-proxy model.

2. **Without Factory credentials, can ordinary exec reach local BYOK?** Yes for `droid exec -m <customModel>` against `http://127.0.0.1:18789` / `18791`. Observed `POST /v1/messages` from `user-agent: factory-cli/0.241.1` with `anthropic-version: 2023-06-01`. The same isolated HOME *without* a custom model and *without* airgap fails: “Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY”.

3. **Can Mission run all three roles under the same condition?** Only the **initial orchestrator request** was observed (`X-Bridge-Role: orchestrator`, Mission tool list including `ProposeMission` / `StartMissionRun` / `Task`). Worker and validator requests were **not** seen. Mock ended the first turn with text and does not invent Mission-control tool calls.

4. **Factory service connection attempts?** `droid doctor` in airgap skipped hosted connectivity and hosted authentication. This run did not install a process-wide egress tap. Conclusion: “not observed in doctor airgap checks; coverage is doctor + localhost request logs, not a zero-telemetry proof.” Official airgap docs say isolation still needs network policy.

5. **Authorization vs observation?** Official [S10] says airgap **builds** are enterprise-only and not on public download channels. The public CLI env var working on `0.241.1` is an experiment result for this version. It is not a claim that anyone may use public CLI airgap permanently, or that Factory authorized this project.

## Matrix

| ID | Factory creds | airgap | Result |
|---|---|---|---|
| Control | none | off | exit 1, must `/login` or `FACTORY_API_KEY` |
| Control | none | on | exit 1, Airgap Mode refuses Factory-proxy default model |
| A0 | none | off | exit 0, 2 localhost Messages requests (BYOK reached without login) |
| A1 | none | on | exit 0, 2 localhost Messages requests |
| A2 | none | on, wrong token | exit 1, HTTP 401 `authentication_error`; no session created |
| A3 | none | on | `--list-tools` exit 0; Read/LS/Grep/Glob allowed |
| A3b | none | on | absolute `file_path` Read; canary `RELAY_CANARY_G0FIXED` in tool_result |
| A4 | none | on | Mission exec exit 0; **one** orchestrator request only |
| A5 | n/a | n/a | not run; no user Factory login provided; no purchase |

Relative `file_path` (`CANARY.txt`) failed with Droid’s own error: “file_path must be an absolute path”. Absolute path succeeded. Droid, not Bridge, executed Read.

## Protocol notes from live Droid

- Path: `POST /v1/messages` (not `/v1/v1/messages`)
- `stream: true`
- `max_tokens: 4096`
- `system` is an array of text blocks
- First user message is a tool-catalog `<system-reminder>`
- `extraHeaders.X-Bridge-Role` is sent
- `apiKey: "${BRIDGE_CLIENT_TOKEN}"` with `authMode: "bearer"` worked
- CLI model id `-m relay-probe` / `-m relay-chat` / `-m relay-orchestrator` matched `customModels[].model`

## Authorization gap (do not blur)

- Observed: public `0.241.1` honors `FACTORY_AIRGAP_ENABLED=1` and can call local BYOK without a Factory account.
- Documented: enterprise airgap **build**, not this public flag.
- Not claimed: official permission, all versions, or “free Factory”.
