# Spec, review and auxiliary model calls

Users also ask Droid to plan/review work and receive helper behavior such as titles, summaries, routing or safety classification. These are separate entry points from ordinary chat and may use separate models or hosted services.

## Sub-features

- `factory-spec-review` covers spec planning/approval and code-review flows.
- `factory-title-variants` covers Mission helper titles and interactive history titles separately.
- `factory-compaction` covers Factory's own summarizer/context compaction.
- `factory-agent-generation` covers model-assisted custom Droid configuration generation.
- `factory-routing` covers automatic model selection rather than a fixed BYOK model.
- `factory-risk-shield` covers command-risk and Droid Shield model classification.
- `factory-local-signals` covers classification associated with compaction, todo completion or session end.
- `factory-image` covers model-backed image generation/editing where available.

## How to get to it (user POV)

- Spec has the public new-session CLI flags `droid exec --use-spec --model` and `--spec-model`. It cannot be combined with `--session-id` or `--fork`; use the actual owned settings/project paths when building its dedicated driver.
- Review is the interactive `/review` entry; there is no established `--review` CLI flag. An ordinary prompt containing “review” is not the same entry point.
- Custom Droid management is interactive `/droids`; configured project definitions live under `.factory/droids/` and are invoked by actual Factory Task delegation. There is no established `--droid` or `--agent` flag for this distribution.
- Interactive history titles and automatic model selection have separate entry paths from fixed-model noninteractive exec.
- Let a sufficiently long Factory conversation reach its own compaction, rather than issuing native Claude `/compact`.
- Use the applicable command/skill requiring risk classification or image generation only when the installed version and authorized provider expose it.
- Exact current CLI forms and static identifiers are recorded in `evidence/factory-model-surface-2026-10-15.json`; do not invent a flag from a string found in a binary.

## Driving it with dedicated Droid journeys

Preconditions:

- Identify the actual public entry point and its provider/auth requirements from the installed version.
- Keep an explicit authorized endpoint and isolated configuration. Hosted-only calls without authorized credentials remain blocked.

- **Inventory first.** Inspect the pinned model-surface evidence. Match the intended journey to its static candidate and any separately observed runtime request.
- **Drive actual entry.** Add a dedicated real CLI/PTY journey with exact action, resulting model request, user-visible output and independent side-effect assertions before changing its status to verified.
- **Missing recipe.** The current chat/Mission drivers do not automate all entries here. Record `NOT_VERIFIED` with the specific missing journey; do not run ordinary chat and rename the result.
- **Factory compaction.** Require a Factory summarizer request and resulting Factory transcript/state. A Claude SDK `compact_boundary` proves only the native Claude path.
- **Hosted/routed calls.** Confirm the observed destination/model without recording credentials. A fixed BYOK request reaching Bridge does not establish that every auxiliary call takes that route.

## Gotchas

- A shipped string or function is a candidate, not evidence it executes under airgap/BYOK. Conditional flags and server-side paths may change reachability.
- The installed CLI is a closed distribution; neither strings nor REA root-artifact inspection establishes a complete model call graph.
- Existing Mission title/Task-summary observations do not cover interactive-only title variants or Factory compaction.
- The generator's one-feature proof requirement does not reduce this map's coverage obligations. Unknown and untested paths stay visible.
