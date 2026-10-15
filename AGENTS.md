# Relay Bridge

Local Anthropic Messages bridge from Factory Droid BYOK into the official Claude Agent SDK and unmodified Claude Code.

## Rules

- Do not launch Cursor subagents on Claude/GPT/Gemini. See `.cursor/CLOUD.md`.
- Do not buy, top up, or enable billing. Do not spend unauthorized API keys.
- Do not patch Droid or Claude binaries, auth, or license checks.
- Do not read `~/.claude` tokens or commit credential files.
- Official Claude billing stays `BLOCKED_AUTH`. Non-Claude BYOK (MiniMax/GLM) e2e may be marked PASS when those providers actually ran.
- `BRIDGE_AUTH=subscription` must not override `ANTHROPIC_BASE_URL` / `AUTH_TOKEN` / `API_KEY`. Default cloud path is `byok`.
- SDK mode uses `claude_code` preset + append. Do not go back to `tools: []` or a full custom system prompt.
- `FACTORY_AIRGAP_ENABLED=1` is an experiment, not an official public-CLI entitlement.

## Commands

```bash
npm install
npm run doctor
npm test
npm run test:protocol
npm run test:sdk-probes
BRIDGE_MODE=mock BRIDGE_CLIENT_TOKEN=dev npm start
```
