# Factory paths verified on 2026-10-16

These checks use Factory Droid 0.242.0, the unmodified official Claude Code 2.1.300, Agent SDK 0.3.300 and an explicitly authorized GLM-5.2 BYOK endpoint. They do not use a real Claude subscription. The [original REA/static inventory](../evidence/factory-model-surface-2026-10-15.json) identifies candidates; it is not proof that every Factory model call was executed.

The [final validation summary](../evidence/final-validation-2026-10-16.json) records 373 passing tests across 43 files, successful typecheck/build, and the real journeys below. The [26-entry followup index](../evidence/factory-model-surface-followup-2026-10-16.json) retains blocked, unknown and historical-only paths without reporting a coverage percentage.

| User path | Actual defect or observation | Result and evidence |
|---|---|---|
| Factory manual compaction | Prefix rewriting created another native session and lost cache continuity. | Authenticated exact retained-turn matching keeps the native session. [Context regression](../evidence/factory-context-regression-2026-10-16.json). |
| Factory automatic compaction | The initial hook marker could be discarded, leaving the next request unbound. | Official UserPromptSubmit renews the authenticated marker. A separate post-boundary turn retains the actual native session and recalls the fixture. [Final context run](../evidence/factory-context-validation-2026-10-16-r3.json). |
| Factory handoff in the same RPC worker | Copied old/new live markers caused HTTP 409. | The authenticated compact SessionStart names its predecessor; only that owned generation is retired. The original failing same-worker flow now succeeds with a distinct native session. [Handoff regression](../evidence/factory-context-handoff-2026-10-16.json). |
| Spec planning and approval | Exec advertised ExitSpecMode but rejected execution without its explicit tool permission. | The production wrapper adds the official permission for Spec, respecting explicit tool exclusions. [Spec/custom attempts](../evidence/spec-custom-validation-2026-10-16.json). |
| Spec read-only phase | Native preset tools needed enforcement independent of model instructions. | Authenticated Spec remains read-only until the matching successful ExitSpecMode receipt. An attempted early Write fails; the approved implementation Write succeeds in the same native session. [Adversarial Spec](../evidence/spec-readonly-validation-2026-10-16.json). |
| Custom Droid and model alias | An actual registered Droid and child model selection needed independent verification. | Real Factory Task invokes the full custom definition and distinct configured model alias; fixture facts return to the parent. Both aliases use the same explicitly selected GLM upstream, not different providers. [Spec/custom evidence](../evidence/spec-custom-validation-2026-10-16.json). |
| Tool restrictions and revocation | Factory Read-only still allowed native Bash to write; revoking Execute did not revoke native authority. | Per-call native-equivalent checks work even in bypass mode. Read-only → Execute → Read-only passes in one native session. Custom read-only Droid also rejects Write. [Tool-policy regression](../evidence/native-tool-policy-validation-2026-10-16.json). |
| Dynamic tool schemas | Conversion dropped constraints; unchanged names could hide a stale schema from the model. | Full JSON Schema validation and revision names confirm the exact client-visible definition. Real native MCP updates succeed on the first invocation without replacing the query. [Native schema evidence](../evidence/native-schema-validation-2026-10-16-r2.json). This probe uses a synthetic host MCP fixture, not a Factory command. |
| BYOK selection | Incomplete selection could probe unrelated ambient credentials; inherited provider/OAuth selectors could override intent. | Production and probes require the explicit endpoint/model/key variable. Missing or vanished keys fail before startup. Competing selectors are removed only in BYOK mode; proxy/CA and subscription environments are preserved. `tests/unit/byok-isolation.test.ts`. |
| Streaming usage | The initial provisional input count stayed zero in the client stream. | Final message_delta now supplies the measured input count with output/cache counters. `tests/unit/sse-stream.test.ts`. |
| Mission | A completed ledger alone could conceal missing validators, handoffs or interrupted execution. | Fresh uninterrupted 1126s run: 3 features, 5/5 assertions, both validators, matching EndFeatureRun worker transcripts, original tests preserved and green, zero runtime errors and no owned processes remaining. [Mission evidence](../evidence/mission-final-validation-2026-10-16-r3.json). Its source fingerprint precedes the three separately verified final fixes identified in the summary. |
| Browser approvals | Real DOM actions needed proof; successful connection still displayed “connecting”. | Real Chromium deny/allow/cancel and stale-approval rejection pass with independent file checks. Connection text is fixed and retested without a model call. [Approval evidence](../evidence/browser-control-validation-2026-10-16.json), [connection regression](../evidence/browser-connect-status-after-2026-10-16.json), [private cleanup](../evidence/browser-control-private-cleanup-2026-10-16.json). |
| RPC title generation | Title calls are distinct from chat and can be conditional. | A real `session_title_updated` event with `llm_generated` and its Bridge request were captured during context verification. This does not certify every title variant. |
| Interactive review, cancellation and generation | Hosted `/droids` generation returns Factory 401 with no Bridge request. Executable-command output also needed an explicit stop instruction to avoid running the newly generated Droid automatically. | Real `/review` finds the known regression; `/relay-droid` creates a usable definition with zero unrequested follow-up tools, then a separate Factory Task runs its distinct native child. Escape stops an independently observed running shell and prevents its delayed write. Strict Task/exit checks, failures, cleanup and scoped title evidence: [final interactive evidence](../evidence/interactive-final-validation-2026-10-16.json). |
| Auto Model | Not a selectable model in this isolated airgap/custom configuration. | Real CLI rejects it before a Bridge model call. [Auxiliary evidence](../evidence/auxiliary-validation-2026-10-16.json), SCOPED_PASS. |
| Risk, Shield and Local Signals | Separate conditional/organization services. Native Bash does not execute Factory's host-side classifiers. | Their inference outputs are not certified by the native execution test. Default native `ask` provides its own approvals; explicit bypass is not Factory auto-low policy. |
| Image generation/editing | The text BYOK route is not an image backend; GenerateImage was not advertised in this configuration. | No alternate credential or text substitute is selected. Independently authorized Factory image tools may still execute as host tools. |
| Specialized output formats | The bridge accepted unsupported probabilities/JSON/media contracts and ignored them. | Such requests now return 422 before creating a session. Ordinary text, input images and delegated host tools remain independent. |

## Reproduce the scoped checks

Follow [the verification skill](../.cursor/skills/verify-relay-bridge/SKILL.md) to set the explicit authorized BYOK variables and official executable paths. Each harness uses isolated directories and owned-process cleanup. `--summary` paths must be new; failed attempts are retained.

```bash
npm run verify:spec -- --adversarial-spec --summary evidence/new-spec.json
npm run verify:custom -- --read-only-custom --summary evidence/new-custom.json
npm run verify:context -- --auto --same-worker-handoff --summary evidence/new-context.json
npm run verify:native-schema -- --summary evidence/new-schema.json
npm run verify:native-policy -- --summary evidence/new-policy.json
npm run verify:auxiliary -- --summary evidence/new-auxiliary.json
node --import tsx scripts/verify-interactive.ts --help
npm run verify:mission -- --summary evidence/new-mission.json
```

## Generate a custom Droid with BYOK

Start the configured Bridge and provide its existing client token in the command environment. The generator requests prose only with tools disabled; the caller chooses the name, model and tool capabilities. It validates the result and exclusively creates a project Droid without overwriting existing files.

```bash
export BRIDGE_CONTROL_URL=http://127.0.0.1:18787
npm run generate-droid -- --cwd /absolute/project --name json-auditor \
  --description "Read JSON fixtures and check arithmetic" --tools Read,LS,Grep,Glob
npm run generate-droid -- --cwd /absolute/project --install-command
```

After restarting Droid, use `/relay-droid --name another-auditor --description "Read JSON fixtures and check arithmetic"`. The installed executable custom command inherits `BRIDGE_CLIENT_TOKEN` and `BRIDGE_CONTROL_URL`; it stores neither credential. This is a working local replacement for generation, not a modification of Factory's hosted `/droids` menu.

## Scope and cache interpretation

Factory compaction and native Claude compaction have separate evidence. The automatic Factory test lowers its public compaction threshold and uses a small fixture: its automatic boundary trims initial context; manual and handoff summaries carry the tested facts. It does not establish default-threshold or arbitrary long-history semantic fidelity.

The final context run observes Claude input 171 and cache-read 23872 after compaction; the unchanged-schema native run observes input 77 and cache-read 19072. Both retain native identity and show actual cache reuse. The provider omits cache-create counters, so coverage stays partial and an exact cache hit percentage or invoice cost cannot be derived. Actual schema changes can legitimately invalidate part of the cache.

The earlier inventory's “Task-summary helper” was misclassified: its system prompt matches the now-proven Factory Summarizer exactly. It is corrected as a Summarizer observation, not independent proof of a Task-result summarizer. Hidden/server-side paths, unconfigured organization services, other frontends and future extensions remain outside an exhaustive denominator.

Schema compatibility preserves validation constraints, without applying defaults or treating `x-*` annotations as validators. Declare `$schema` when mixing dialect features: without it, a schema containing `$defs` uses 2020-12; draft-07 tuple `items` combined with `$defs` therefore needs an explicit draft-07 declaration. Incompatible forms are rejected before invocation.

The final [BYOK environment test](../evidence/byok-isolation-validation-2026-10-16.json) injects 31 synthetic competing selectors, verifies their removal and nine pinned model slots, then passes actual official Droid/Claude Code file work and resume. Proxy/CA settings remain intact. It does not inspect real credential files or authentication descriptors.
