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
The operator declares `BRIDGE_AUTH`. The bridge builds Claude Code's environment from that declaration and refuses to start when the process environment would select something else. Errors list variable names, never values.

- `byok` (default): explicit `BRIDGE_UPSTREAM_BASE_URL`, `BRIDGE_UPSTREAM_MODEL` and `BRIDGE_UPSTREAM_TOKEN_ENV`. The child receives that endpoint, `ANTHROPIC_AUTH_TOKEN`, an empty `ANTHROPIC_API_KEY` and the model slots, on a base allowlist. `CLAUDE_CONFIG_DIR` is isolated. An `sk-ant-` token is refused unless the host is `anthropic.com` or a subdomain.
- `subscription`: Claude Code uses the machine login (`CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR` may pass through). Non-empty `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_*`, file-descriptor selectors, gateway tokens, model-slot leftovers and `BRIDGE_UPSTREAM_*` refuse startup. The error suggests `anthropic-api` or `cloud` when those are the conflicting names. `settingSources` is empty. Not live-verified.
- `anthropic-api`: requires `ANTHROPIC_API_KEY`, or an absolute `BRIDGE_API_KEY_HELPER` passed through the SDK `settings.apiKeyHelper` flag layer (SDK 0.3.300). `ANTHROPIC_BASE_URL` is allowed only for `https://api.anthropic.com`. OAuth tokens, `CLAUDE_CODE_USE_*` and third-party base URLs are refused. Model slots may pass through. Not live-verified.
- `cloud`: exactly one of `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`. AWS, Vertex and Foundry credential variables and model slots pass through. API keys, OAuth tokens, `ANTHROPIC_BASE_URL` and `BRIDGE_UPSTREAM_*` are refused. `CLAUDE_CONFIG_DIR` is isolated. Verification is the environment check; account info cannot prove the cloud backend. Not live-verified.
- `inherit`: copies the shell environment, like running `claude` in a terminal, except `BRIDGE_ADMIN_TOKEN` and the bridge lifecycle binding variables. Still refuses a base URL that points at this bridge. Settings load as the CLI default.

Every mode except `inherit` also sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and keeps the existing traffic and timeout defaults. `BRIDGE_ENV_PASSTHROUGH` adds comma-separated names. A name that is forbidden for the current mode throws. Unrelated secrets such as `GLM_CN_API_KEY` are not copied unless listed there.

`npm run doctor -- --auth subscription` (or `anthropic-api`) is the zero-token check: it runs preflight, opens an SDK query whose prompt never yields, and prints masked `accountInfo`. Run that before the first real request. `subscription` and `anthropic-api` also call `accountInfo` before the first user message and return `auth_mode_mismatch` when the reported source does not match. Those live strings are not yet confirmed against a real account, so an unrecognized result fails closed.
- Login must be completed by the user in the official CLI. Agents do not read or proxy `~/.claude` tokens.
- This cloud environment has no authorized Anthropic credential. Official Claude billing stays `BLOCKED_AUTH`.
- BYOK is the isolated validation path, not a recommendation to replace the intended Claude subscription deployment. Its cache counters cannot establish Claude subscription consumption or account-policy eligibility.

## What is forbidden

- Buying, topping up, or enabling billing.
- Switching to a paid API after a subscription failure.
- Patching Droid/Claude auth or license checks.
- Claiming public-CLI airgap is officially blessed because a flag appeared to work.
