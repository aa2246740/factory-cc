# Long-running bridge incident, 2026-10-26

The retained evidence establishes repeated startup failure and missing process ownership checks. It does not establish that all roughly 30 reported Claude children were leaked rather than intentionally idle. The original PID tree and pre-restart launchd job record are no longer available.

## Observed evidence

A read-only audit on 2026-10-27 found 34 `sdk_start_timeout` events in the desktop `bridge-data/logs/bridge.jsonl`. The latest seven occupy lines 533 through 545, from `2026-10-26T10:24:45.711Z` to `2026-10-26T10:36:02.796Z`. Each reports a 60,000 ms startup deadline. There are 181 `auth_verified` entries with `startupMs`: minimum 251 ms, median 1,176 ms, p95 25,653 ms, maximum 51,294 ms. These are successful initialization handshakes, not per-turn model latency; failed starts are a separate population.

`stderr.log` contains 272 SDK permission warnings and 34 startup timeout warnings. It contains no retained token/config/port/missing-directory error explaining exit 78. Current read-only `launchctl print` reports PID 48586, `runs = 1`, and no exit. The accessible seven-day unified log retains only removal/inactive events at `2026-10-26 18:54:33.445`. The earlier report of 54 runs and EX_CONFIG cannot identify its actual cause without older launchd diagnostics. A missing external working directory is a supported failure mechanism before the application can log, not a proven historical cause.

The last old-process listening entry is `2026-10-21T13:44:52.381Z`. Restart entries appear at `2026-10-26T10:54:33.356Z` and `2026-10-26T10:54:36.659Z`. The latest session snapshot has 295 records: 223 IDLE, 65 FAILED, and 7 CANCELLED. It is a post-restart snapshot and cannot reconstruct the ownership/activity of the old 30-child tree.

The reported upstream `API Error: Request rejected (429)` with `rate_limit_error` previously became 502 `sdk_execution_error`, because SDK result errors were wrapped without inspecting upstream status/type. That mapping defect is reproducible independently of gateway quota availability. Official `system/api_retry` messages also used to reset the progress timer while overload kept the request open. The fix hands safe requests back to Droid early and records native retries when callbacks or native work must remain in place. The report's upstream cooldown is external to the bridge.

## Lifecycle audit at baseline `bef7703`

The baseline already calls `abort()`, `interrupt()`, and `query.close()`. The claim that it only closes stdin is incorrect. Installed SDK 0.3.300 schedules a graceful-close window and TERM/KILL for its direct child. The bridge had no PID/birth identity, no process-tree ownership, and no OS exit check. Its idle eviction dropped query references immediately, while terminal sessions stopped consuming runtime capacity. Store capacity counted generating/parked sessions; runtime capacity counted nonterminal query objects. Neither was an OS process count.

| Trigger | Baseline path | Gap addressed |
| --- | --- | --- |
| Completed chat / idle | `consume()` publishes `end_turn` and retains the query | Intentional reuse had no small idle-pool cap; up to 32 resident CLIs could remain. |
| Slot pressure | `ensureQueryCapacity()` evicts a resumable idle query | Close was best effort and references disappeared before verified death. |
| Startup timeout / auth rejection | `verifyDeclaredAuth()` calls `stop()` | Terminal objects released accounting without proving process exit. |
| Cancellation / client disconnect | HTTP cancellation calls runtime `cancel()` / `stop()` | Direct-child SDK close did not establish descendant death; cleanup was not awaited by admission. |
| Turn timeout / interrupt | Interrupt waits for result, then `endHostSession()`; otherwise cancel | A clean result was a checkpoint boundary, not a process-exit receipt. |
| Droid compaction | HTTP `releaseCompacted()` marks interrupted and cancels | Same unverified termination path. |
| Model / effort switch | `selectModel()` / `selectReasoning()` close and resume | Iterator completion or synchronous close did not prove OS process-tree exit. |
| Mission worker end / SessionEnd | Grace timer or authenticated hooks call cancel/end | Same ownership gap; pending callbacks must first be resolved or explicitly rejected. |
| Bridge SIGTERM | `SdkRuntime.close()` waits briefly for iterator; index has a shutdown deadline | Iterator cleanup and the SDK's direct-child timers did not verify all descendants. |
| Cursor failure / cancel | `handle()` rethrows; cancel awaits remote cancellation before agent close | Failed requests could retain agents; a hung remote cancel blocked agent/store cleanup. |

New ownership comes exclusively from the official SDK spawn hook. Recorded detached groups and observed descendant birth identities bound every signal to this bridge's own work. A failed verification retains the registry entry and slot; the reaper retries it. Pending native callbacks, background work, and approvals exclude idle eviction. No all-slots restart was added because it would silently discard live work.

The earlier question about why requests did not evict idle work has two distinct answers. At baseline, resumable idle SDK queries already had an eviction path, but closing them did not establish physical capacity. Parked host tools are different: they count as active store work and are protected while a live host, Mission spawn, or human wait owns them. A process count alone cannot classify either group. The new small idle pool, verified retirement, and process-backed reservation count address the first case; the second still returns backoff when no safe candidate exists.

JSONL logs already rotated at 50 MiB with one archive. The growth gaps were unbounded desktop stdout/stderr, an oversized JSONL record escaping the limit, the full-record session journal, and retained metadata/events/receipts. This change lowers the JSONL default, caps each record and archive, compacts the journal, and prunes only inactive unprotected state.

## Throughput and unrelated Mission

Warm Claude turns already reuse one streaming query and do not call `accountInfo()` again. Stable Droid catalogs already avoid refresh notifications. Those behaviors are retained and covered by tests. The new idle cap reduces resident processes while keeping recent queries warm. Cold imports remain necessary when host history cannot prove continuity; replacing them with guessed native state would be unsafe. Startup, history import, and catalog metrics describe bridge work only, not provider reasoning or Factory validation.

The requested Mission `dc6f8002-7077-49f3-b6a5-826b624d8540` uses `custom:CPA-grok-4.7-6` at xhigh and `custom:CPA-gpt-6.1-sol-0` at max, through CPA. It does not use this bridge. Read-only history shows 108 completed worker intervals with a median of 2,204 seconds; intervals include model work, tools, checks, and pauses. They are not model-speed benchmarks. Its project's pre-commit hook runs 16 commands, including full `npm test`, typecheck, lint-staged, architecture/dependency/security checks, API contracts, and docs checks. Its validation contract is roughly 398 KiB and feature inventory roughly 345 KiB.

For that Mission, measure worker time by model waiting, tools, and validation before changing providers. Supply workers with the relevant acceptance IDs and files while keeping the canonical contract available. Use high effort for ordinary implementation and reserve max for difficult validation. Have the project owner move expensive repeated full suites to an appropriate pre-push/CI boundary while retaining fast local checks; do not bypass the current contract in a worker. None of that Mission, its settings, or its project was modified here.

## Acceptance and limits

The PR records compilation, full test counts, offline soak, and isolated live results. The authoritative local progress trail is `/Volumes/Workspace/Scratch/factory-cc-provider-feasibility/long-run/EVIDENCE.md`; owned PIDs are in the adjacent `PIDS.txt`. Raw credential or conversation logs are not committed.

Runtime candidate `2c3e337` passed `npx tsc -p tsconfig.json --noEmit`, `npm run build`, and the full suite: 885 passed / 3 skipped. The suite includes real child trees, a TERM-resistant supervisor child, auth rejection/start timeout, idle/pressure eviction, model/effort resume, compaction, disconnect, worker end, safe backoff retries, pending-callback preservation, exact Cursor SQLite checkpoint deletion, log rotation, retention, and the missing-checkout launcher.

The 1,000-session fake-protocol soak spawned real children and verified all 1,000 exits: zero leaks, zero remaining slots, 32 retained records, and log generations below 64 KiB. Forced-GC retained heap grew 2,080,088 bytes over the sampled run and 542,496 bytes after session 500. This measures an accelerated fixture, not a projected production memory rate.

The unmodified real SDK/CLI against a deterministic localhost provider reused one CLI for three warm turns. Both 429 and 529, exact safe retries, and post-content disconnect passed. Six CLI roots and 15 observed owned PIDs ended with zero leaks and zero slots. Only the SDK-exposed overload delay supplied `Retry-After: 1`; the SDK did not expose the fixture's 429 header, so it was not guessed.

Earlier isolated provider checks returned HTTP 200 for Haiku and eight Composer sessions, confirmed idle agent eviction and cancellation, and forced a real SDK startup timeout with a 1 ms configured limit. The timeout returned 503 after cleanup with zero owned trees/slots. A deliberate one-slot Mission could not admit its worker: Droid classified the 429 as `model_rate_limited`, and the probe was stopped and cleaned. It is evidence of admission/backoff, not Mission completion. Provider and SDK-local harnesses now require fresh output directories, after a final probe correctly rejected stale ended fixture IDs with 409.

The final frozen build completed a real Haiku-orchestrated Composer Mission: implementation, scrutiny, and user testing all completed; validation passed; matching worker handoffs were observed; original tests/package metadata were preserved. Droid recorded one `model_rate_limited` worker outcome and retried it successfully. All eight completion gates passed. The harness took 766,483 ms; bridge SIGTERM exited 0 with zero children before harness cleanup, zero final leaks, and port 18797 free.

That run recorded 92 admissions (median 12 ms), 23 SDK preparations (median 5 ms, 21 warm and two cold imports), two `accountInfo()` starts (416 and 479 ms), one 79 ms SDK import, and one 81 ms catalog refresh. These are diagnostic samples on a shared Mac; admission excludes body upload, preparation excludes model generation, and no before/after speedup is claimed. The native runtime source stayed at `2c3e337`; probe isolation/capacity guards are at `60a2145`. The tested `dist/` digest and machine-readable results are in [the acceptance record](evidence/long-run-2026-10-27.json).

A final read-only OS audit checked 2,334 recorded PID numbers. Twelve numbers had already been reused by processes born after the final live result; they were not owned survivors and were not signalled. This is why process-number-only cleanup is unsafe.

The first isolated probe incorrectly propagated the real `CLAUDE_CONFIG_DIR`. It wrote one test transcript under the real Claude projects directory before the mistake was found. That probe was stopped and the transcript left untouched. Subsequent probes use a temporary CLI config and a read-only helper wrapper. This boundary violation is recorded in the evidence and is not hidden by later passing runs.

Weeks of uninterrupted production operation, macOS login with a physically absent disk, and Droid's graphical approval UI remain separate from the accelerated/fake and isolated CLI tests. Official Anthropic subscription/billing remains `BLOCKED_AUTH`; a helper-backed `claude-config` gateway response does not establish it.
