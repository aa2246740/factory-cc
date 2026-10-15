# Mission planning, work and validation

A user submits a task as a Mission and receives a completed, independently validated result from its orchestrator, worker and validators.

## Sub-features

- `mission-plan` creates the actual plan, skill setup and validation contract.
- `mission-worker` fixes the seeded defect using native Claude Code work.
- `mission-scrutiny` reviews the actual implementation and records a handoff.
- `mission-user-testing` checks the validation contract and records results.
- `mission-complete` completes all features and assertions without hidden runtime errors.
- `mission-recovery` continues the same interrupted Mission using the official session ID.

## How to get to it (user POV)

- Start a Mission through `droid exec --mission` with configured orchestrator, worker and validator models.
- Resume an existing Mission through `droid exec --session-id` using its actual Factory session ID; do not combine it with `--mission`.

## Driving it with the Mission harness

Preconditions:

- Parent skill's explicit BYOK selection and official CLIs are available.
- Allow the one-hour default deadline. The harness starts from an intentionally broken project with original tests; it must not seed Mission plans or completed ledgers.

- **Launch and drive.** Run `npm run test:e2e:mission`. Capture the unique evidence directory printed by the harness.
- **Check work.** Require genuine Factory tool calls and native work for actual orchestrator/worker/validator sessions, with corresponding feature handoffs.
- **Check result.** Require CLI success, Mission `completed`, every feature completed, every assertion passed, original tests/package unchanged and tests green.
- **Check health.** Require no runtime/control errors, pending tool callbacks or approvals before cleanup, and no owned processes after cleanup.
- **Recovery.** For a healthy timeout report only, use `npx tsx scripts/e2e-mission-resume.ts` followed by that run's actual printed evidence directory. The recovery helper validates ownership and the original fixture. Preserve both attempt reports and label success `PASS_WITH_RECOVERY`.

## Gotchas

- The previous recorded Mission needed recovery after the old 20-minute harness timeout. It is not an uninterrupted pass.
- Recovery uses the same Factory Mission and retained completed worker identities; it cannot recreate abandoned in-memory native callbacks.
- Factory can finish a worker before emitting an EndFeatureRun PostToolUse hook. Authentic SessionEnd closes its waiter without inventing a success receipt.
- Restoring a completed ledger or forcing StartMissionRun inside Bridge invalidates acceptance.
- The older Mission harness retains its temporary directories for recovery; unlike the chat verification helper, successful process cleanup does not mean its scratch directories were deleted.
