---
name: verify-relay-bridge
description: Verify Relay Bridge through real Factory Droid CLI, native Claude Code, HTTP control, and Mission user paths; capture isolated BYOK evidence and report untested model-call surfaces explicitly.
---

# Verify Relay Bridge

Read [the feature map](features/README.md) before driving anything. This repository is a localhost Anthropic Messages adapter between Factory Droid and the official Claude Agent SDK. Its primary user surface is the Droid CLI; `/control` and the control CLI are secondary surfaces. A passing chat run is not proof of every Factory model call, UI entry point, or Mission workflow.

Generated using [Cursor's create-verification-skill](https://github.com/cursor/plugins/blob/99743e9c151c8537cbbf1f98bb38f34ef3368453/pstack/skills/create-verification-skill/SKILL.md). The generator requires proving one mapped feature; this skill deliberately separates that proof from broader coverage claims.

## Launch

Run from the repository root with Node.js 22+, npm, and the official `droid` and `claude` executables installed. The repository pins `@anthropic-ai/claude-agent-sdk` in package.json. Do not patch either CLI or inspect a real user's Claude/Factory credential files.

```bash
npm ci
npm run build
npm run verify:relay -- --help
npm run verify:relay -- --offline-check
```

If the CLIs are outside PATH, set `BRIDGE_DROID_EXECUTABLE` and `BRIDGE_CLAUDE_EXECUTABLE` to their installed executable paths, then repeat the offline check. Missing executables are a failed prerequisite, not a passing verification. `--offline-check` does not start a model or validate model authorization.

The managed validation environment supplies an authorized `READINESS_MODEL_API_KEY` for `open.bigmodel.cn`. Select it by variable name without printing its value:

```bash
export BRIDGE_AUTH=byok
export BRIDGE_UPSTREAM_BASE_URL=https://open.bigmodel.cn/api/anthropic
export BRIDGE_UPSTREAM_MODEL=glm-5.2
export BRIDGE_UPSTREAM_TOKEN_ENV=READINESS_MODEL_API_KEY
npm run verify:relay -- --feature chat
```

Outside that managed environment, use an explicitly authorized Anthropic-compatible endpoint/model/key-variable triple. Do not substitute another configured key after an authorization failure. Preserve the environment's proxy and CA configuration. The existing `READINESS_MODEL_API_KEY` must never be sent to another provider's domain.

`--feature chat` owns the whole short-lived run: it starts SDK-mode Bridge on an OS-assigned loopback port, allocates empty Factory and workspace directories, isolates Claude configuration, writes private settings, installs official lifecycle hooks, and drives the production `run-droid` wrapper. There are no database migrations. The helper creates its own small read/write fixture as verification scaffolding; it removes that fixture during cleanup. The fixture uses explicit bypass permissions only inside the disposable workspace, so this run does not verify approval behavior.

Ready requires the expected runtime/auth configuration and a successful real Droid result. An HTTP listener or `/healthz` alone is insufficient. The helper tears down its owned instances in `finally`, including failed attempts. Separate processes can run concurrently with different ports/directories. Never call the process-global `startSdkBridge` helper concurrently inside one Node process, and never point a verification run at a user's shared Factory home or project.

## Doctor

Use the chat helper's read-only instance doctor before driving and whenever its run looks wrong. Each live chat run captures this report before its first action. It checks the owned URL/runtime, SDK/BYOK configuration, admin read access, and workspace/config isolation. It must not send a model prompt, approve a tool, or cancel a session. Other dedicated drivers perform their own documented prerequisite/runtime checks.

While the run is active, copy the private manifest path printed at launch into a second terminal:

```bash
read -r -p 'Manifest path printed by this verification run: ' VERIFY_MANIFEST
npm run verify:relay -- --doctor "$VERIFY_MANIFEST"
```

The manifest contains an admin capability, is mode 0600, and is deleted during cleanup. Do not print its contents or publish it. Standalone doctor performs only reads; the launch report separately records CLI versions. After cleanup, an unavailable instance/manifest is expected and is not a reason to restart or reuse it.

`npm run doctor` is a separate installation diagnostic that writes `evidence/doctor.json`; it is not the read-only instance doctor and does not prove a model is usable. Do not use it as the acceptance gate.

If doctor fails, retain the failure evidence and run cleanup. Do not replace the runtime with mock/fake mode to make the real-path journey pass.

## Drive

Start with [chat, native file work and session continuation](features/chat-and-resume.md):

```bash
npm run verify:relay -- --feature chat
```

The helper uses real `droid exec`, reads a fixture whose nonce is not supplied in the prompt, writes an output file through native Claude tools, then starts a second `droid exec --session-id` to recall the earlier value. It independently reads the file and compares session identities. Production entry points and their limitations are in each feature file; do not silently replace an unimplemented recipe with a unit test.

Drive the other mapped surfaces through their dedicated helpers with the same explicit upstream environment. Every summary path below must be new:

```bash
npm run verify:spec -- --adversarial-spec --summary evidence/new-spec.json
npm run verify:custom -- --read-only-custom --summary evidence/new-custom.json
npm run verify:context -- --auto --same-worker-handoff --summary evidence/new-context.json
npm run verify:native-schema -- --summary evidence/new-schema.json
npm run verify:native-policy -- --summary evidence/new-policy.json
npm run verify:auxiliary -- --summary evidence/new-auxiliary.json
node --import tsx scripts/verify-interactive.ts --help
node --import tsx scripts/verify-interactive.ts --natural-generation-only evidence/new-natural-generation.json
npm run verify:mission -- --summary evidence/new-mission.json
```

Mission is a distinct, longer run with a one-hour default deadline. Preserve an initial timeout as a failed/incomplete attempt even if later official session continuation succeeds. Read [Mission's feature recipe](features/mission.md) before running it. Its final verifier also fingerprints the actual runtime sources; do not edit them during acceptance.

The native-schema helper exercises the real SDK with a synthetic host MCP fixture; it is not a Factory command. Context verification drives the real Factory JSON-RPC compaction methods and requires a separate post-boundary turn. Interactive verification uses the actual PTY entry points. Chat's manifest doctor is specific to its running instance; other drivers perform their own prerequisite and lifecycle checks. Read [the current scope](../../../docs/FACTORY-SURFACES.md), and record hosted prerequisites or unknown paths explicitly. Unknown private/server-side Factory paths remain outside an exhaustive denominator.

## Evidence

The helper prints a unique `evidence/local/verify-relay-*` directory. Retain its sanitized action commands, stdout/stderr, exit codes, doctor report, independent file observations, request/session/usage observations, and final result. Proof artifacts must survive cleanup. Raw authorization headers, settings tokens, environment dumps and credential files are not evidence to publish.

For a new, nonexisting shareable summary path, use:

```bash
npm run verify:relay -- --feature chat --summary evidence/new-chat.json
```

Never overwrite an earlier attempt to turn a failure into a pass. If the dated summary already exists, use the command without `--summary`; its unique local directory still retains the new result.

Proof standards:

- Capture the exact action and actual CLI response, plus a separate read of every asserted file side effect.
- Require actual authenticated Bridge traffic and native SDK activity; a canned final string alone does not establish routing.
- Distinguish the Factory session, Bridge session, and native SDK session. A model-role header is not proof of the actual Factory worker role.
- Record real error events, pending approvals/tools, timeout status and owned-process cleanup. A completed Factory ledger cannot conceal an SDK error.
- Keep provider-message usage separate from SDK cumulative totals and from Droid counters. Missing cache-create fields mean unknown coverage, not zero cost or an exact hit ratio.
- Native Claude `/compact` and automatic compact boundaries do not prove Factory's own summarizer/compaction path.
- Do not claim an entry is verified from static strings, a mocked callback, or another entry's success. This harness uses no model-response mock.
- Browser proof requires its own actual actions, screenshot and accessible-state evidence. HTTP/API tests alone cannot close that gap.

Read `evidence/factory-model-surface-2026-10-15.json` for the pinned binary inventory, historical observations and explicit gaps. REA artifact inspection and byte-offset matches establish discoverability, not exhaustive call-graph coverage.

## Cleanup

Normal completion and failure both close the Bridge/native queries and terminate only the process identities this run created. The helper removes its owned temporary workspace, Factory data, private hook/config material and isolated Claude configuration after taking sanitized evidence. It verifies the evidence still exists and reports any cleanup failure as a failed verification. Never kill processes by name or delete a directory inferred from an untrusted report.

If the entire supervisor is killed before `finally`, the run is interrupted, not passed. Preserve its proof directory and inspect recorded ownership before cleanup; do not run `pkill droid`, `pkill claude`, or blanket `/tmp` deletion. The older full Mission harness retains its owned directories to support explicit recovery, so do not apply the chat helper's deletion policy to a Mission you intend to resume.

## Helpers

- `scripts/verify-relay.ts` is the executable helper, invoked by `npm run verify:relay`. Use `--help` for its supported operations; `--offline-check` checks prerequisites without calling a model.
- `scripts/verify-mission-final.ts` is invoked by `npm run verify:mission`; it wraps the real Mission driver and requires completed worker transcripts, validators, stable runtime sources and owned-process cleanup.
- `scripts/verify-spec-custom.ts`, `verify-factory-context.ts`, `verify-native-schema.ts`, `verify-native-tool-policy.ts`, `verify-auxiliary.ts` and `verify-interactive.ts` provide the separate journeys above. Each retains unsuccessful attempts; passing one does not certify another.
- `scripts/verify-browser-control.ts` drives actual Chromium approval controls and takes screenshots; its optional external browser dependencies and invocation are in [permissions and control](features/permissions-and-control.md).
- `scripts/control.ts` is the production client: `npm run control -- approvals` and `npm run control -- sessions` are read-only; approve/deny/cancel mutate the selected live request.

Keep the feature map current with `/maintain-verification-skill` when behavior changes. Updating an entry's status requires new evidence, not just editing its prose.
