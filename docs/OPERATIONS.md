# Run the desktop bridge for weeks

## Upgrade an existing installation

Merge the reviewed source into the checkout recorded in the desktop installation, then run these commands from that checkout:

```bash
npm ci
npm test
npm run desktop -- restart
npm run desktop -- status
```

`restart` rebuilds `dist/`, writes the new home-resident launcher and plist, then replaces the service. Existing native turns and in-memory tool callbacks end during replacement. Finish or explicitly stop your current Mission before upgrading. A successful build does not upgrade an already running service.

The LaunchAgent starts `/bin/sh` in its private home-volume state directory. That launcher waits for Node, `dist/index.js`, `dist/desktop-supervisor.js`, and the three token files. Its delay grows from 5 seconds to 60 seconds. It never creates a replacement directory under `/Volumes`.

After files return, the supervisor starts the bridge. Config errors, missing token files, and a port already in use do not trigger a tight launchd loop. Failed child starts back off at 5, 10, 20, 40, then 60 seconds. A child that ran for five minutes resets that backoff. `ThrottleInterval` remains 30 seconds for failures of the launcher or supervisor itself. The supervisor never stops an unrelated listener.

On service termination, the supervisor sends SIGTERM and allows the bridge's own ten-second shutdown to finish. Its separate ownership check waits up to twelve seconds before escalating to group TERM/KILL. A bridge that ignores SIGTERM cannot keep the supervisor waiting indefinitely.

If a Node upgrade removes the installed executable, run `restart` with the new Node executable. Keep the repository at its registered path. Restart does not move the installation to your current worktree.

## Check the service before restarting

```bash
npm run desktop -- status
launchctl print gui/$(id -u)/ai.factory-cc.bridge
```

`status` reads `/healthz` and uses the private admin-token file to summarize `/internal/runtime`. It prints no token or account address. `/healthz` stays limited to `{ ok, mode }`; it does not verify provider access.

Inspect these runtime values together:

- `slotsInUse`, `maxSlots`, and `maxIdleSessions` describe Claude query reservations and registered process trees. A stopping tree keeps its slot until OS exit is verified. The Cursor section reports its agent slots separately.
- `processes.liveProcesses` counts registered roots and observed descendants. It is sampled once per second; `lastScanAt` identifies the sample. `ownedTrees` also includes trees still being verified or retried after cleanup failure.
- `pendingHostCalls`, `pendingApprovals`, `activeNativeTurns`, and `oldestTurnMs` distinguish a generation from a parked Mission. An old turn with a live tool callback is not evidence of a wedged process.
- `processes.reaperKills` counts orphan-owner reclamations, and `reaperFailures` reports failed cleanup or sampling. `cursor.cleanupTimeouts` reports cancellation or store-disposal deadlines.
- `activeRequests`, `retainedSessions`, `workerEndTimers`, `compactionLinks`, and `memory` expose other retained work and process memory.

The bridge samples only PID, PPID, process group, birth identity, and process state. It does not scan process arguments or environments. New Claude queries use the official SDK spawn hook and a dedicated process group. Release closes the SDK/input, waits up to 2 seconds, sends TERM, waits up to 2 seconds, then sends KILL and verifies for up to 1 second. Escalation uses process identity rather than Node's `child.killed` flag. The periodic reaper retries registered owners no live query owns. It never uses `pkill claude` or adopts another application's CLI.

Keep recent idle sessions warm to avoid startup on every turn. The default retains at most four resumable idle Claude queries and four idle Cursor agents; each runtime has a hard limit of 32. The session store also limits active work across providers to 32. LRU eviction preserves the native checkpoint. Requests returning during retirement wait for the old process to die before resuming it. Pending tools, approvals, background tasks, and active requests prevent idle eviction.

If all slots hold live work, expect 429. The bridge does not restart itself or discard callbacks to make that response disappear. Existing idle/max turn watchdogs interrupt stalled generation. A Mission waiting on a person or its workers remains parked until an authenticated end/cancel, confirmed compaction, or its tool deadline. Check the host before ending that work.

## Diagnose startup and provider errors

Read the private `stdout.log`, `stderr.log`, and `bridge-data/logs/bridge.jsonl` under `~/Library/Application Support/factory-cc`. Keep credentials and conversation bodies out of reports.

- For `desktop_waiting_for_files`, check the external volume, registered repository and Node paths, built entrypoints, and nonempty private token files. Do not recreate the mountpoint on the internal disk.
- For `desktop_retry`, inspect the preceding child error. `EADDRINUSE` means another listener owns the port. A token-file read error or config validation error needs the named local file or setting corrected. The supervisor retries without killing the port owner.
- For `sdk_start_timeout`, inspect CPU/memory pressure and process/slot counts. No prompt was sent. `startupMs` measures the `accountInfo()` initialization handshake, not model generation or total HTTP latency. `request_admitted.admissionMs` covers parsing/correlation/state writes after body upload. `sdk_turn_prepared.preparationMs` covers runtime preparation through prompt submission, with `queryReused`, `coldImport`, and imported message counts. `sdk_imported.importMs` and changed `droid_catalog_updated.catalogMs` isolate first import and catalog refresh. The default startup limit is 60 seconds, capped by the turn's idle limit.
- For HTTP 429 `rate_limit_error`, wait for `retry-after` when supplied. Explicit SDK `api_retry` events can hand back 429/529 early, using the SDK delay when available. Exact accepted requests with complete prior client history can retry through a fresh query after verified cleanup. Only requests without unresolved callbacks, background tasks, or native work qualify; previous tool results become reference history, never re-executed callbacks. If native work prevents safe reimport, the SDK keeps its retry and `upstreamBackoffs` reports why. HTTP 529 is `overloaded_error`. The bridge translates explicit upstream types/statuses and does not guess a cooldown from arbitrary prose. Failed queries are closed and their OS ownership remains until verified dead.
- For an error after SSE content began, inspect the Anthropic `error` event. HTTP headers cannot change after content. Before the first content, the bridge can return a JSON error with its real HTTP status and known `retry-after`; keepalive pings start with the stream.
- For old launchd exit 78, inspect launchd diagnostics as well as application logs. A missing `WorkingDirectory` can fail before Node starts and leave no application error. A `runs` count alone does not identify the configuration error.

## Keep state bounded

JSONL logs default to 10 MiB per file plus one `.1` generation. An individual record larger than the cap becomes a size-only omission marker. Desktop stdout and stderr each retain 2 MiB plus one generation; the supervisor reopens files for every append, so rotation does not leave it writing to a renamed file descriptor. Private file modes remain 0600.

Every minute, the bridge expires inactive session metadata older than seven days and retains at most 1,000 inactive records. It protects active requests, authenticated live hosts, native background work, approvals, and pending callbacks. The journal compacts after 256 writes or 8 MiB of updates. A snapshot itself can exceed 8 MiB when retained records require it. Active work can exceed the retention count; the count is not permission to delete it.

Expired Cursor checkpoints are removed through the SDK store's exact `agentIds` filter, after closing an inactive agent. A checkpoint referenced by another retained session is preserved. Never delete an open SQLite file or use an empty delete filter. Claude transcripts outside the bridge data directory belong to Claude Code and are not deleted by bridge retention. Long active native transcripts can still consume disk.

Completed mailbox records retain at most 256 calls and 2 MiB of payloads. Older duplicate results fail closed. Request/completion fingerprints use SHA-256. SDK/Cursor event arrays retain 1,000 recent entries; usage deduplication retains 4,096 recent provider-message identities and cumulative counters. After that window, usage coverage is marked partial rather than claiming exact historical deduplication.

For a directly launched bridge, the relevant environment overrides are `BRIDGE_MAX_SESSIONS`, `BRIDGE_MAX_IDLE_SESSIONS`, `BRIDGE_SDK_START_TIMEOUT_MS`, `BRIDGE_LOG_MAX_BYTES`, `BRIDGE_SESSION_MAX_RECORDS`, and `BRIDGE_SESSION_RETENTION_MS`. The desktop plist uses the defaults and intentionally does not import arbitrary shell environment variables. Do not put provider keys into the plist.

## Reproduce the isolated acceptance checks

Run the offline soak with real owned Node children and a fake SDK protocol:

```bash
npm run test:soak -- 500
npm run test:soak:sdk-local
```

Both fixtures use port 18797, isolated state under `tmp/`, bounded logs, and explicit process ownership. The fake-protocol soak has a ten-minute deadline and forced-GC heap samples. It asserts zero surviving child processes, zero slots after close, and bounded retained state. The fake recorder keeps only recent query objects so the test does not measure its own history retention. The real SDK/CLI localhost fixture has a five-minute deadline and verifies warm reuse, 429/529 with safe retries, and cancellation after stream content.

The provider check requires an existing helper-based Claude configuration and the bridge-owned Cursor credential. It reads the original helper configuration at execution time, runs that helper in its original HOME, and gives the actual CLI a temporary HOME and configuration directory. It does not copy keys or the original helper command. `BRIDGE_CURSOR_AUTH_FILE` is a read-only credential source override; writes/login still target the test data directory.

```bash
npm run verify:long-run -- --run --mission
```

This command spends configured provider quota. It checks port 18797 before starting, launches `dist/index.js`, records owned PIDs, forces SDK startup timeout, runs short Haiku/Composer sessions, cancels a real stream, drives isolated Droid, and attempts one tiny Claude-orchestrated Composer Mission. Its total deadline is 25 minutes. Inspect its `result.json`, private logs, and cleanup result; a product test alone does not certify Mission completion. Native browser/desktop GUI acceptance and weeks of wall-clock soak are separate checks.

The Mission profile uses four slots so its orchestrator can park while workers run. Without `--mission`, the profile uses one slot to force idle eviction. `--mission --mission-only` runs just the Haiku check and Mission. Provider and SDK-local fixtures refuse nonempty output directories; use a fresh path for each `BRIDGE_LIVE_DIR` or `BRIDGE_SOAK_DIR`. `BRIDGE_EVIDENCE_DIR` and `BRIDGE_EVIDENCE_PIDS` can point to a separate append-only evidence trail.
