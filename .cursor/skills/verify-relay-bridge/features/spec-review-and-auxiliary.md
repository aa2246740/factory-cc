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
- In isolated airgap/BYOK, hosted `/droids` → Generate with Droid returned Factory HTTP 401 without a Bridge request. The local `generate-droid` CLI and its installed project `/relay-droid` executable command use the configured local Bridge instead.
- Interactive history titles and automatic model selection have separate entry paths from fixed-model noninteractive exec.
- Use the public Factory JSON-RPC `droid.compact_session` method and automatic context threshold; native Claude `/compact` is a separate surface.
- Use the applicable command/skill requiring risk classification or image generation only when the installed version and authorized provider expose it.
- Exact current CLI forms and static identifiers are recorded in `evidence/factory-model-surface-2026-10-15.json`; do not invent a flag from a string found in a binary.

## Driving it with dedicated Droid journeys

Preconditions:

- Identify the actual public entry point and its provider/auth requirements from the installed version.
- Keep an explicit authorized endpoint and isolated configuration. Hosted-only calls without authorized credentials remain blocked.

- **Inventory first.** Inspect the pinned model-surface evidence. Match the intended journey to its static candidate and any separately observed runtime request.
- **Spec.** Run `npm run verify:spec -- --adversarial-spec --summary evidence/new-spec.json`. Require a denied pre-approval Write, a real successful ExitSpecMode receipt, and the correct implementation Write in the same native session.
- **Custom Droid.** Run `npm run verify:custom -- --read-only-custom --summary evidence/new-custom.json`. Require the actual Factory Task, independent child session, full definition and enforced Read-only capability. Distinct aliases sharing one upstream are not different-provider verification.
- **Context/title.** Run `npm run verify:context -- --auto --same-worker-handoff --summary evidence/new-context.json`. Require real Factory Summarizer calls, automatic/manual boundaries, a separate post-boundary turn, authenticated continuation identity, and semantic recall. Its lowered threshold and small fixture do not prove arbitrary long-history fidelity.
- **Auxiliary.** Run `npm run verify:auxiliary -- --summary evidence/new-auxiliary.json`; retain exact unavailable entry or unmet hosted prerequisite. SCOPED_PASS does not mean those hosted services ran successfully.
- **Interactive review/generation/cancel.** See `node --import tsx scripts/verify-interactive.ts --help` for actual PTY actions and focused checks. Hosted `/droids` may require separate Factory authorization; local `/relay-droid` is a distinct working alternative.
- **Missing recipe.** Record `NOT_VERIFIED` for uncovered entry points; do not run ordinary chat and rename the result.
- **Factory compaction.** Require a Factory summarizer request and resulting Factory transcript/state. A Claude SDK `compact_boundary` proves only the native Claude path.
- **Hosted/routed calls.** Confirm the observed destination/model without recording credentials. A fixed BYOK request reaching Bridge does not establish that every auxiliary call takes that route.

Run the actual interactive surfaces through a Linux PTY with Python 3 and `pexpect`, after setting the explicit BYOK selection and official executable paths from the main skill:

```bash
node --import tsx scripts/verify-interactive.ts evidence/new-interactive.json
node --import tsx scripts/verify-interactive.ts --generation-only evidence/new-generation.json
node --import tsx scripts/verify-interactive.ts --cancel-only evidence/new-escape.json
```

Each summary filename must be new. The full journey selects the real `/review` menu, verifies the builtin review Skill in native input, checks a known division regression and an unchanged fixture, and separately reproduces the hosted generator's HTTP 401 with zero added Bridge requests. Generation must create the definition with no unrequested native tool calls, then prove a successful Factory Task, distinct native child, independent Read/result and correct child/parent JSON. Escape waits for a shell-written start marker before interruption, then waits beyond the delayed write to prove no late file appears. All modes require normal PTY/driver exit and owned-process cleanup.

The [final interactive evidence](../../../../evidence/interactive-final-validation-2026-10-16.json) links the actual runs and hashes. Preserve the initial [failed harness attempt](../../../../evidence/interactive-validation-2026-10-16.json): it incorrectly expected executable-command stdout to be printed verbatim in the TUI. The corrected gate checks the created file and native command context. The [strict trace recheck](../../../../evidence/interactive-proof-recheck-2026-10-16.json), [marker-first Escape run](../../../../evidence/interactive-cancel-validation-2026-10-16.json), and [final generation-only run](../../../../evidence/interactive-generation-validation-2026-10-16.json) establish their stated scopes; the earlier weaker Escape gate is not final acceptance evidence.

## Gotchas

- A shipped string or function is a candidate, not evidence it executes under airgap/BYOK. Conditional flags and server-side paths may change reachability.
- The installed CLI is a closed distribution; neither strings nor REA root-artifact inspection establishes a complete model call graph.
- The old “Task-summary helper” observation has the same system prompt as the proven Factory Summarizer. It is not independent evidence of a Task-result summarizer. RPC-generated titles also do not certify every interactive title variant.
- The generator's one-feature proof requirement does not reduce this map's coverage obligations. Unknown and untested paths stay visible.
- The PTY runs observe persisted first-message interactive titles. First-file-edit and fallback-model title variants remain independently unverified. The hosted `/droids` menu itself is unchanged; `/relay-droid` is the working BYOK replacement.
- Factory executable commands feed their output back to the agent. The generator's completion message tells it to report the path and stop; a fresh real run confirms zero follow-up tool calls. This instruction does not replace tool-permission enforcement.
