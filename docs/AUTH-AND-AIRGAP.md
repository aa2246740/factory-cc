# Auth and airgap

## Factory

- Public installer: `https://app.factory.ai/cli` → Droid `0.241.1` on linux-x64 (this run).
- Official airgap page: enterprise-only build, not from public download channels. [S10]
- User-supplied experiment: `FACTORY_AIRGAP_ENABLED=1`.
- Tests use a new temporary `HOME`. They do not read the operator's `~/.factory` login.
- No Factory API key is injected. No Extra Usage is enabled. No purchase path is invoked.

Questions this repo must answer empirically (see `docs/G0-AIRGAP.md`):

1. Does this public CLI version recognize `FACTORY_AIRGAP_ENABLED`?
2. Without Factory credentials, can ordinary exec reach local BYOK?
3. Can Mission start all three roles under the same condition?
4. Were Factory service connections observed?
5. What is documented vs only observed?

## Anthropic

- Official installer: `https://claude.ai/install.sh` → Claude Code `2.1.292` (this run).
- Login must be completed by the user in the official CLI. Agents do not read or proxy `~/.claude` tokens.
- API-key success is not a substitute for the subscription-login path.
- This environment has no authorized Anthropic credential. SDK-mode live turns are `BLOCKED_AUTH`.

## What is forbidden

- Buying, topping up, or enabling billing.
- Switching to a paid API after a subscription failure.
- Patching Droid/Claude auth or license checks.
- Claiming public-CLI airgap is officially blessed because a flag appeared to work.
