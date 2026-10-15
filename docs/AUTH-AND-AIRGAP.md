# Auth and airgap

## Factory

- Public installer: `https://app.factory.ai/cli`. The current isolated smoke test used Droid `0.242.0` on linux-x64.
- Official airgap page: enterprise-only build, not from public download channels. [S10]
- User-supplied experiment: `FACTORY_AIRGAP_ENABLED=1`.
- Current smoke tests use explicit settings and `FACTORY_HOME_OVERRIDE`. They do not use the operator's Factory login.
- No Factory API key is injected. No Extra Usage is enabled. No purchase path is invoked.

Questions this repo must answer empirically (see `docs/G0-AIRGAP.md`):

1. Does this public CLI version recognize `FACTORY_AIRGAP_ENABLED`?
2. Without Factory credentials, can ordinary exec reach local BYOK?
3. Can Mission start all three roles under the same condition?
4. Were Factory service connections observed?
5. What is documented vs only observed?

## Anthropic

- The current isolated tests used unmodified Claude Code `2.1.300` and Claude Agent SDK `0.3.300`.
- `BRIDGE_AUTH=subscription`: Bridge does not set or overwrite `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_API_KEY`, and does not isolate `CLAUDE_CONFIG_DIR`. Claude Code inherits the machine's authentication environment. Existing API keys or router settings may take precedence, so this mode name does not guarantee subscription billing.
- `BRIDGE_AUTH=byok` (cloud default): injects MiniMax/GLM-compatible `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, empties `ANTHROPIC_API_KEY`, isolates `CLAUDE_CONFIG_DIR`.
- Login must be completed by the user in the official CLI. Agents do not read or proxy `~/.claude` tokens.
- This cloud environment has no authorized Anthropic credential. Official Claude billing stays `BLOCKED_AUTH`.
- BYOK is the isolated validation path, not a recommendation to replace the intended Claude subscription deployment. Its cache counters cannot establish Claude subscription consumption or account-policy eligibility.

## What is forbidden

- Buying, topping up, or enabling billing.
- Switching to a paid API after a subscription failure.
- Patching Droid/Claude auth or license checks.
- Claiming public-CLI airgap is officially blessed because a flag appeared to work.
