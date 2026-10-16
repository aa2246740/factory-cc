# Relay Bridge verification map

This is the maintained map of user paths, not a declaration that all paths pass. Read the parent skill's Launch and Doctor instructions first. Use only owned, isolated BYOK instances. Preserve every failed attempt and its unmet precondition.

## Baseline preconditions

- Install dependencies/build, official Droid and Claude Code; run the helper's offline check.
- Set an explicitly authorized upstream endpoint/model/key-variable triple. Never read real subscription credentials.
- The automated chat helper allocates port 0, fresh Factory/Claude configurations and a disposable seeded workspace.
- The chat helper requires its live instance doctor before driving. Other drivers perform their own explicit prerequisite/runtime checks. A listener does not establish model authorization.
- For longer/manual recipes, record the exact project, Factory home, Bridge process and chosen port before driving. Never reuse the chat helper's directories after it cleans up.

## Proof and status

- `VERIFIED` applies only to the named entry/configuration and linked evidence.
- `OBSERVED` means a call or response was seen without full end-state assertions.
- `STATIC_CANDIDATE` means shipped code/strings identify a possible path; it may be disabled or hosted-only.
- `NOT_VERIFIED` means no adequate real-path proof; `BLOCKED` must name the actual missing prerequisite.
- Record CLI action/stdout/stderr/exit code and independent file/ledger state. UI paths additionally need real browser/PTY evidence.
- No coverage percentage is valid while the complete Factory call-site denominator is unknown.

## Features

| Feature | Maintained automated drive | Scope |
|---|---|---|
| [Chat and continuation](chat-and-resume.md) | `npm run verify:relay -- --feature chat` | Real exec, native file work and official session resume; TUI and streaming variants remain separate. |
| [Skills and agents](skills-and-agents.md) | `npm run verify:custom -- --read-only-custom` plus real Mission | Factory Skill/Task are distinct from native Claude skills/agents; the dedicated custom fixture checks actual Task identity, complete body, model alias and restricted tools. |
| [Mission](mission.md) | `npm run verify:mission -- --summary NEW.json` | Genuine planning, worker, scrutiny, user testing and completion; recovery is reported separately. |
| [Permissions and control](permissions-and-control.md) | `npm run verify:native-policy`; control CLI; PTY driver | Native approve/deny/cancel probes exist; browser and raw-TTY journeys are not inferred from API proof. |
| [Spec, review and auxiliary calls](spec-review-and-auxiliary.md) | `verify:spec`, `verify:context`, PTY and auxiliary drivers | Explicitly tracks Factory compaction, title variants, routing, risk/shield, signals and image paths. |

Current fixes and scope are in [the surface report](../../../../docs/FACTORY-SURFACES.md). The original static model-call inventory is `evidence/factory-model-surface-2026-10-15.json`. Factory's closed/conditional/hosted paths prevent an assertion of exhaustive internal coverage. A new candidate stays unverified until driven through its actual user entry point.
