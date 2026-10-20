# Relay Bridge

English | [简体中文](README.zh-CN.md)

Connect Factory Droid's BYOK custom models to the **official Claude Agent SDK and unmodified Claude Code**. Claude Code retains its native system prompt, built-in tools, and sessions; Droid executes its own skills, tasks, plugin tools, and Mission lifecycle operations via namespaced MCP.

In `sdk` mode, a persistent streaming-input `query()` is maintained for each session, with subsequent turns appending only new inputs; tool results are returned directly to the original MCP callback. `BRIDGE_AUTH` must be one of `byok` (server default), `claude-config` (local default), `subscription`, `anthropic-api`, `cloud`, or `inherit`. Bridge assembles the Claude Code environment according to this declaration and refuses to start on any mismatch, reporting only variable names in errors. `subscription`, `anthropic-api`, and `cloud` have not yet been verified against live accounts. Run `npm run doctor -- --auth subscription` first; this check does not send any prompt.

This is an SDK integration approach inspired by T3, not official support, authorization, or an account-status guarantee. Results from third-party compatible endpoints such as GLM do not represent Claude models. See [Integration Alignment](docs/T3-ALIGNMENT.md) and [Limitations](docs/LIMITATIONS.md).

## Droid desktop (always-on)

Run once in this repository (requires Node.js 22+ and an existing working Claude Code configuration):

```bash
npm run desktop -- install
```

The installer reads `~/.claude/settings.json` offline, validates the existing `claude-config` allowlist, does not execute `apiKeyHelper`, and does not contact model services. It builds `dist/index.js`, installs an always-on Bridge that runs after login, and merges Claude Code models into the shared model menu used by Droid desktop. The default address is `127.0.0.1:18787`; to change the port, run `npm run desktop -- install --port 19876`. If the port is in use, it fails immediately without scanning other ports or processes.

Installation modifies or creates the following paths and prints their absolute paths in the command output:

- `~/Library/LaunchAgents/ai.factory-cc.bridge.plist`, which runs the Node binary used at install time and `dist/index.js` from the current repository, saving the install-time `HOME` and `PATH` without storing credentials or upstream helper commands.
- `~/Library/Application Support/factory-cc/` with `0700` permissions; inside it, `client-token`, `admin-token`, `hook-token`, `installation.json`, `models.env`, `stdout.log`, and `stderr.log` are private files with token permissions set to `0600`; `bridge-data/` stores sessions and runtime logs.
- `~/.factory/settings.json`, along with the initial backup `settings.json.relay-bridge.bak` (or `settings.json.relay-bridge.bak.absent` if the original file did not exist) and ownership metadata `settings.json.relay-bridge.models.json`. Each model entry's `apiKey` is Bridge's local client token (file mode `0600`), which can only access the Bridge on `127.0.0.1` on this machine—it is not a model provider API key. `apiKeyHelper` is not used here: Droid strips executable credential commands from runtime settings loaded by Mission workers and validators (logged as `Stripped executable custom-model credential commands`), which would cause all of them to fail with 401 when using a helper. When a Mission starts, Droid snapshots these entries along with the token into `runtime-custom-models.json` (`0600`) inside that Mission's directory.

No user-level or project hooks are installed. The working directory is extracted from `% pwd` in the latest Droid `User system info` system-reminder. Droid typically places this at the start of the first user message; when switching models mid-conversation, it places a new block before the new question; after compaction, it follows Droid's summary. Only contiguous system-reminders at the very beginning of a user message are inspected—content pasted into the user body and tool results are ignored. A missing, invalid, root, or Bridge state directory returns 400 (open a project folder in Droid first); changing directories within the same session returns 409. Requests that disallow all tools (such as Droid's summary-generation request during compaction) do not require a project directory and run in an empty `auxiliary-cwd` directory under the Bridge state directory, where all tools are denied. This origin restriction relies on Droid's request structure and is not identity authentication against arbitrary API clients holding the local token.

Droid desktop requests do not carry a conversation ID. When two conversations have identical completed histories (same project, same role and thinking configuration, and word-for-word identical opening and replies), the earliest idle session continues, preferring the currently selected model; once continued, the two naturally diverge. Sessions that are currently generating, waiting on a tool, or canceled are never taken over. After switching models mid-conversation, compacting, or resuming an old conversation in Droid, the prefix no longer matches, so Bridge starts a new Claude Code session and imports the prior history as reference: the content is remembered, but prior tool details appear as text and the original session's prompt cache cannot be reused.

Mission: the orchestrator model follows the model selected in the current conversation. Workers and validators use Droid's Mission Models settings (`Worker model` / `Validator model`), which are global settings; Droid snapshots them into `model-settings.json` in the Mission directory when the Mission starts. To route workers and validators through Claude Code as well, select a `Claude Code · …` model there.

The desktop profile fixes permissions to `ask` while preserving the Claude Code preset, isolated settings, and MCP. Writing files, executing commands, sub-agents, and plan approvals go through the `mcp__droid__*` tools advertised by Droid, letting Droid apply its own autonomy and spec mode. Native `Read`/`Glob`/`Grep`/`LS` remain governed by the active tool policy; if a native approval would be required, it is rejected immediately with a prompt to route through Droid instead of waiting on the control page.

By default, the menu follows the alias mappings in `~/.claude/settings.json` (the models pointed to by `opus`, `sonnet`, `haiku`, and `fable`). If you want to pin specific models in Droid without changing Claude Code's own settings, pass actual model IDs via `--models`, e.g., `npm run desktop -- install --models claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5`, which displays menu items such as `Claude Code · Opus 5.5 (claude-opus-5-5)`. An existing installation can be updated via `npm run desktop -- restart --models ...`, and subsequent `restart` runs without `--models` will keep that list. Model IDs are passed as-is to Claude Code; if the upstream gateway does not serve a model, the first message will return an error. Claude Code's own small background tasks still follow the `haiku` mapping in its settings.

Cursor can sit beside those Claude Code entries. Log in once with `npm run desktop -- cursor login` (the URL is printed; the key is written to the Bridge data directory at mode 0600 and is not printed). Then `npm run desktop -- install --cursor-models default` adds exactly `Cursor · Composer 2.5` (`fast=false`) and `Cursor · Grok 4.7` (`fast=false`, high effort unless Droid's selector says otherwise, 256k context). Droid's reasoning selector is forwarded: Grok maps `off` to `low` and `max` to `xhigh`, and Composer ignores it. Claude Code receives the same level as the SDK `effort` option (`off` disables thinking). Without `--cursor-models`, install and restart still set up Claude Code and leave Cursor entries off the menu. `BRIDGE_AUTH` stays the Claude credential. The plist stores a menu-file path, not a Cursor key. `npm run desktop -- cursor status` prints the expiry and warns when a week or less remains. See [Cursor](docs/CURSOR.md).

After editing `~/.claude/settings.json`, restart Bridge to reload the auth helper and model mappings and synchronize the menu; active conversations will be interrupted. The installer does not copy credentials or other environment variables from your current shell into `launchd`.

```bash
npm run desktop -- status
npm run desktop -- restart
npm run desktop -- uninstall
```

Uninstalling stops the service first, removes only the models and selections owned by Bridge while preserving any other settings added or modified by the user after installation, and then deletes the plist and its own state directory, including Bridge sessions and logs. If settings were otherwise untouched, the initial backup is restored.

The current repository resides on an external volume (`/Volumes/Workspace`). The service cannot start when this volume is unmounted, and the Node installation path must also remain present. Before moving or archiving this worktree, run `uninstall` first and then reinstall from a permanent location. `status` reports the state of the plist, `launchd`, the repository entrypoint, and `/healthz` on the configured port; a healthy response does not prove upstream authentication or live tool approvals have passed.

Offline tests do not verify the live desktop workflow. After installation, refresh or restart Droid desktop and confirm that the Claude Code models appear; ask for the current directory in two different projects and verify each path; perform a file edit and a command execution to verify Droid's approval UI; in spec mode, confirm that writing or executing is blocked before approval and only proceeds after exiting spec mode. Finally, modify a model mapping, run `restart`, and verify that the menu synchronizes. These live checks invoke your own model configuration and should be run locally by you.

## Existing Claude Code and Droid: Direct Launch

Requires Node.js 22+. Neither CLI needs to be reinstalled; run in this repository:

```bash
npm ci
npm run local -- /path/to/your/project
```

By default, this follows your Claude Code configuration (`--auth claude-config`). If your `claude` CLI already works, simply run the command above. Bridge reads only `$CLAUDE_CONFIG_DIR/settings.json` (or `~/.claude/settings.json` when unset), importing the auth helper, upstream URL, model mappings, and allowed proxy and CA environment variables. If same-named URL, model, or credential variables in your shell conflict with `settings.json`, startup is refused and the error lists only the variable names; proxy and CA variables follow `settings.json` just like Claude Code. For cloud routing, use manual `BRIDGE_AUTH=cloud`.

For every newly spawned Claude Code process, Bridge waits for it to report its account via `accountInfo()` and verifies it before sending any prompt. This step waits for process startup to finish; because Mission runs launching multiple workers and Tasks concurrently have taken over 10 seconds, Bridge waits up to 60 seconds (capped by `BRIDGE_REQUEST_TIMEOUT_MS`). If it still has not started when the timeout expires, Bridge returns 503 `sdk_start_timeout` (retryable, not treated as an authentication failure, logged as `sdk_start_timeout`); only an account verification failure or mismatch returns 401 `auth_mode_mismatch`. Successful `auth_verified` log entries include `startupMs`.

User hooks, permissions, MCP servers, plugins, `CLAUDE.md`, and other environment variables are not carried into Droid sessions. Bridge maintains its own approval flow and MCP isolation. Literal `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` values in `settings.json` are discarded; when `apiKeyHelper` is configured, Claude Code runs the helper as-is, otherwise you will be prompted for hidden input at startup or can specify your own environment variable with `--key-env NAME`. Keys and helper commands are never written to disk or shown in summaries. To avoid reading stored tokens for comparison, startup is also refused if the same credential variable name appears in both the shell and `settings.json`; unset that name in your shell and use a separate dedicated variable with `--key-env`.

Before starting, Bridge displays the settings path, target host, credential source, model list, default model, and any ignored configuration keys. Mappings for Opus, Sonnet, Haiku, and Fable display their resolved model IDs while requests still pass the corresponding alias for Claude Code to resolve. When no model mappings exist, `sonnet`, `opus`, and `haiku` are used. Login-only paths must confirm subscription or API authentication before the first prompt; if not logged in, run the official `claude` CLI first to log in.

To use an isolated GLM/BYOK configuration, specify it explicitly:

```bash
npm run local -- /path/to/your/project --auth byok
```

This mode preserves the interactive endpoint/model prompts and `provider.json` preferences. The default international Z.AI endpoint is `https://api.z.ai/api/anthropic` with default model `glm-5.2`; Zhipu China uses `https://open.bigmodel.cn/api/anthropic`. The API key must belong to the selected service; input is not echoed or saved to disk and must be re-entered on the next launch.

This single command starts Bridge, configures an isolated Droid data directory and real model list, and installs lifecycle hooks and the `relay-droid` skill. On subsequent runs, simply execute `npm run local -- /path/to/your/project`. Exiting Droid stops the Bridge service for that run and removes its hooks while preserving any existing project hooks.

The `local` entrypoint pins the working directory via the project path argument; for global installation and automatic per-project working directories in Droid desktop, see the always-on section above.

`/model` now lists actual models instead of exposing internal roles like Relay Chat, Orchestrator, or Worker as models. Regular chat selects its model here; Mission selects from the same list independently for its Orchestrator, Worker, and Validator settings. Previously saved per-role selections are preserved.

For example, to expose two actual models from the same BYOK endpoint:

```bash
npm run local -- /path/to/your/project --auth byok --models glm-5.2,glm-4.7 --model glm-5.2
```

The menu displays `GLM-5.2` and `GLM-4.7`, and requests are routed to the corresponding model. The model list is remembered for future runs. When idle, you can switch models within the same conversation using the official Claude SDK's `resume` to preserve the native session; if there are pending tools, approvals, or background tasks, finish the current work first. Switching models may not reuse the previous model's prompt cache, and cross-model cache hits are not guaranteed.

Claude integrations use `sonnet`, `opus`, `haiku`, or specific version IDs your account can access. For `subscription` and `anthropic-api`, the default display names are `Claude Sonnet`, `Claude Opus`, and `Claude Haiku`. The model list is an explicitly configured set of options, not an automatic enumeration of account entitlements. Running `npm run local -- /path/to/your/project --auth subscription` or `--auth anthropic-api` skips the endpoint and key prompts, defaults to those three aliases, and does not isolate `CLAUDE_CONFIG_DIR`. If `BRIDGE_AUTH` in the environment conflicts with `--auth`, startup fails immediately rather than silently falling back to BYOK. A BYOK key starting with `sk-ant-` when the upstream host is not `anthropic.com` is also rejected.

When native tool operations require approval, open the control page URL printed at startup; the admin token is stored in the private file path printed alongside it. Approvals remain per-invocation by default. Endpoint URLs and models can be remembered, while upstream API keys are never written to disk; explicit BYOK mode never uses your Claude subscription login.

See `npm run local -- --help` for more options. First-time users do not need to manually edit the environment variables or settings described below.

[Historical Local Entry Validation](evidence/local-entry-validation-2026-10-16-r2.json): real Linux PTY, GLM BYOK conversation, and clean exit records from the earlier role-menu design. The current model selection design has replaced it as described above.

[Current Model Selection Design & Live Screenshots](docs/ACTUAL-MODEL-SELECTION.md): real model menus, in-session switching, per-role Mission selection, and preserved failure and fix records.

[Historical File Read/Write Screenshots](docs/LOCAL-VISUAL-PROOF.md): Claude Code native `Write` approval, on-disk results, and live BYOK upstream from the earlier menu design.

## Manual Operation & Diagnostics

Requires Node.js 22+; live mode also requires the official `claude` and `droid` CLIs to be installed.

Check the default config-following path without sending a prompt:

```bash
npm run doctor -- --auth claude-config
```

This prints the same redacted summary as the launcher, along with `classification` and `promptSent: false`. `doctor` does not prompt for keys; literal keys in `settings.json` must first be replaced with shell credentials or an `apiKeyHelper`. This command starts the official SDK and calls `accountInfo()`, so it is not a purely static check. This feature has only been tested against offline fixtures and has not yet been verified with a live login, gateway, or helper.

Using your own Claude subscription: first open the official `claude` CLI yourself and follow the prompts to log in to your Pro or Max account; never hand your login credentials to Bridge. Then verify authentication in this repository without sending a prompt:

```bash
npm run doctor -- --auth subscription
```

The expected output must include `"ok": true`, `"classification": { "kind": "subscription", ... }`, and `"promptSent": false`. Proceed only when all three match:

```bash
npm run local -- /path/to/project --auth subscription
```

If an error lists `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `BRIDGE_UPSTREAM_*`, or cloud routing variables, your current shell still has residual auth or endpoint variables set. Open a clean shell or `unset` the listed variables and retry. A `classification.kind` of `unknown` means account info is insufficient to confirm a subscription and the first prompt will be rejected—do not proceed based on `ok: true` alone. If not logged in, return to the official `claude` CLI to log in first, then re-run the check above. Live subscription startup and conversations have not yet been verified.

Configure an isolated Droid settings file first, then start the zero-cost protocol mock mode:

```bash
npm ci
umask 077
mkdir -p tmp/relay-local
export BRIDGE_CLIENT_TOKEN="$(openssl rand -hex 24)"
export BRIDGE_ADMIN_TOKEN="$(openssl rand -hex 24)"
export BRIDGE_HOOK_TOKEN="$(openssl rand -hex 24)"
printf 'export BRIDGE_CLIENT_TOKEN=%s\nexport BRIDGE_ADMIN_TOKEN=%s\nexport BRIDGE_HOOK_TOKEN=%s\n' "$BRIDGE_CLIENT_TOKEN" "$BRIDGE_ADMIN_TOKEN" "$BRIDGE_HOOK_TOKEN" > tmp/relay-local/tokens.env
npm run configure-droid -- --settings "$PWD/tmp/relay-local/settings.json" --base-url http://127.0.0.1:18787 --model glm-5.2
BRIDGE_MODE=mock BRIDGE_MODELS=glm-5.2 npm start
```

The script writes the **literal token value** into the JSON rather than a `${BRIDGE_CLIENT_TOKEN}` placeholder. Configuration and backup files are created with mode `0600`, and modification is refused if any token is missing. `BRIDGE_CLIENT_TOKEN`, `BRIDGE_ADMIN_TOKEN`, and `BRIDGE_HOOK_TOKEN` must all be distinct or startup fails immediately. By default, Bridge listens only on loopback addresses (`127.0.0.1`, `localhost`, `::1`, or any `127.x.x.x`). To listen on non-loopback addresses in non-`subscription` modes, you must additionally set `BRIDGE_ALLOW_REMOTE=1`; this exposes the process's credentials to other clients, and the operator is solely responsible for terms-of-service compliance. When listening on `0.0.0.0` or `::`, you must also set `BRIDGE_ALLOWED_HOSTS` (comma-separated hostnames or IPs without ports) listing the exact hostnames clients will use so `Host` and `Origin` checks can validate them, otherwise startup fails; this variable takes effect only when `BRIDGE_ALLOW_REMOTE=1`. `subscription` mode may never be exposed to other machines or users. `GET /healthz` returns only `{ "ok": true, "mode" }`; runtime details require the admin token at `GET /internal/runtime`. `POST /v1/messages` accepts JSON or SSE requests. When admin or hook tokens are not provided in the environment, `sdk` mode writes generated values to `admin-token` and `hook-token` (`0600`) in the data directory and logs only their file paths at startup.

In a second terminal, enter this repository, source the same private token file, and run Droid against that configuration (`tmp/` is gitignored; do not regenerate tokens or commit the file):

```bash
source tmp/relay-local/tokens.env
FACTORY_AIRGAP_ENABLED=1 droid exec --settings "$PWD/tmp/relay-local/settings.json" -m glm-5.2 "RELAY_TEXT_PROBE"
```

Revert the configuration:

```bash
npm run configure-droid -- --settings "$PWD/tmp/relay-local/settings.json" --revert
```

Before switching to live BYOK, stop the mock server in the first terminal with `Ctrl-C`. The example below pins an upstream using `GLM_CN_API_KEY` already set in the environment; the URL must be an **Anthropic-compatible endpoint** supported by Claude Code and must not point back to Bridge. OpenAI-compatible URLs used when Droid connects directly to models cannot be used here.

```bash
source tmp/relay-local/tokens.env
export PROJECT=/absolute/path/to/project
export BRIDGE_MODE=sdk
export BRIDGE_AUTH=byok
export BRIDGE_PERMISSION=ask
export BRIDGE_SDK_CWD="$PROJECT"
export BRIDGE_UPSTREAM_BASE_URL=https://open.bigmodel.cn/api/anthropic
export BRIDGE_UPSTREAM_MODEL=glm-5.2
export BRIDGE_MODELS=glm-5.2
export BRIDGE_UPSTREAM_TOKEN_ENV=GLM_CN_API_KEY
export BRIDGE_MODEL_ID=glm-5.2
npm start
```

For BYOK, the endpoint, model, and key environment variable must all be explicitly configured; if any is missing or invalid, startup fails immediately without probing other environment keys. Except in `inherit` mode, Claude Code child processes receive only an allowlisted environment (`PATH`, `HOME`, proxy, CA, locale, etc.) rather than inheriting the entire parent environment. Additional variables can be passed via `BRIDGE_ENV_PASSTHROUGH=NAME1,NAME2`, but names forbidden by the active auth mode will cause an immediate error. In `subscription` mode, seeing `ANTHROPIC_API_KEY` suggests switching to `anthropic-api`, and seeing `CLAUDE_CODE_USE_*` suggests switching to `cloud`.

When configuring manually, `subscription` and `anthropic-api` use `BRIDGE_MODELS=sonnet,opus,haiku`. `cloud` and `byok` require explicit model names. `configure-droid --auth` accepts all six modes. These manual paths have only been tested offline and have not been verified with live subscriptions, official API keys, or cloud provider accounts. Run `npm run doctor -- --auth subscription` first.

For international Z.AI, use `https://api.z.ai/api/anthropic` and `ZAI_CODING_PLAN_KEY`; change both the endpoint and variable name together, and ensure the key belongs to that service. `BRIDGE_UPSTREAM_TOKEN_ENV` takes the **name** of the environment variable while the actual secret stays in that variable.

`ask` is the default permission policy. Native tools requiring approval pause inside the SDK `canUseTool` callback; open `http://127.0.0.1:18787/control`, enter `BRIDGE_ADMIN_TOKEN`, inspect the exact arguments, and choose allow-once or deny. Once approved, Claude Code executes the tool. From the CLI, you can also use `npm run control -- approvals`, `approve <id>`, `deny <id>`, and `cancel <sessionId>`. Expired, canceled, stale-session, or duplicate approvals cannot re-execute a tool. `BRIDGE_PERMISSION=bypass` must still be set explicitly.

Install official Factory lifecycle hooks and launch via the cancellation-aware wrapper:

```bash
# In the second terminal, run from this repository; PROJECT must match the one used to start Bridge.
source tmp/relay-local/tokens.env
export PROJECT=/absolute/path/to/project
npm run configure-hooks -- --hooks "$PROJECT/.factory/hooks.json" --config "$PWD/tmp/relay-local/hooks-control.json"
npm run run-droid -- --cwd "$PROJECT" --airgap 1 -- exec --settings "$PWD/tmp/relay-local/settings.json" -m glm-5.2 "Inspect this project"
# Removing only deletes hooks owned by this Bridge without overwriting user hooks added later.
npm run configure-hooks -- --hooks "$PROJECT/.factory/hooks.json" --config "$PWD/tmp/relay-local/hooks-control.json" --remove
```

`configure-hooks` reads `BRIDGE_HOOK_TOKEN`, which must match the running Bridge and follows the same handling rules as `BRIDGE_ADMIN_TOKEN`. This token is accepted only by `POST /internal/host-events`; all other `/internal/*` endpoints require the admin token. Bridge and the wrapper must share the same `BRIDGE_ADMIN_TOKEN` / `BRIDGE_CLIENT_TOKEN` / `BRIDGE_HOOK_TOKEN` set and point `BRIDGE_SDK_CWD` to the target project. The wrapper preserves `HOME` and isolates Factory data via `FACTORY_HOME_OVERRIDE`; on exit or cancellation, it cleans up only the sessions owned by that launch. Use the wrapper for interactive launches: Factory UI's exit hook cannot inherit session bindings from inside the Agent process and needs the launch identity to terminate the corresponding session accurately. If a process is force-killed before it can send a termination event, use the control page to cancel any lingering session.

`BRIDGE_REQUEST_TIMEOUT_MS` (default 10 minutes) is now an **idle** timeout rather than an absolute deadline for a single response: every SDK message, text delta, or tool event resets the timer, so it times out only when there is sustained lack of progress; the timer pauses while waiting for control-page approval, which has its own deadline `BRIDGE_APPROVAL_TIMEOUT_MS` (default 30 minutes). There is also an absolute turn cap `BRIDGE_TURN_MAX_MS` (default 2 hours). On timeout, Bridge first calls SDK `interrupt()`: if the turn winds down within 5 seconds, the session returns to `IDLE` and remains resumable; otherwise it is marked `FAILED` and the process is terminated. Streaming responses immediately emit `message_start` followed by `event: ping` every 15 seconds. Note: if a native tool produces no output and does not finish for a long time (e.g., a test suite running for over 10 minutes), that also counts as idle—increase `BRIDGE_REQUEST_TIMEOUT_MS` if needed. When a session is parked on an external tool round-trip (Droid running a long tool or a Mission worker executing), it is not stopped for idleness and is bounded only by the 14-day absolute per-tool limit (`BRIDGE_TOOL_WAIT_MS`). Bridge reclaims a session only when session capacity (`BRIDGE_MAX_SESSIONS`, default 32) is exhausted and a new request would otherwise receive 429, and only if the candidate simultaneously satisfies all of the following: parked on a tool with no request currently in flight; idle since its last state update for at least `BRIDGE_TOOL_WAIT_TIMEOUT_MS` (default 12 hours); not bound to a live Factory host; and not waiting on `StartMissionRun`, `ProposeMission`, `Task`, or human input via `AskUser`. Among eligible sessions, the least-recently-active one is marked interrupted; if none qualifies, Bridge returns 429 as usual. Tool calls from reclaimed, canceled, or post-restart sessions are never replayed: if Droid later posts back the same tool result, it receives 409, whereas a new text message starts a fresh session and imports the prior history as reference. Official termination events release sessions immediately without waiting for timers.

These defaults were relaxed based on empirical Droid Mission telemetry: a worker invoked the model up to 342 times for a single feature (42% exceeded 64 turns), an orchestrator waited up to 4.7 hours on `StartMissionRun` and 5.2 hours on `AskUser`, and one orchestrator session spanned 238 hours with 14 compactions. Accordingly, `BRIDGE_MAX_TURNS` defaults to `0` (no limit on Claude Code model turns per message); set a positive integer to enable a cap.

When Droid compacts a long conversation, it first sends the conversation as text to a toolless summary request and then continues in a new first message starting with `"A previous instance of Droid has summarized…"` that embeds that summary. From Bridge's perspective, this looks like a brand-new conversation while the old session's pending tool result has already been folded into the summary—leaving the old session holding onto its process and slot forever (especially since sessions waiting on `StartMissionRun` are never evicted by timeout). Therefore, when the last answered `TOOL_CALL` in a summary request uniquely matches a session parked on that exact call, Bridge records the summary; once Droid continues with a message carrying that summary, Bridge releases the old session and logs `compacted_session_released`. If there is no match, multiple sessions match, or Droid does not continue, nothing is released.

After a Mission worker reports feature completion via `EndFeatureRun`, Droid immediately terminates that worker and marks the tool call as canceled without ever sending the tool result back. That would otherwise leave the worker's Claude Code process waiting indefinitely. Therefore, when a session has only `EndFeatureRun` pending, no request in flight, no pending approval, and no live bound Factory host, Bridge releases the process after `BRIDGE_WORKER_END_GRACE_MS` (default 2 minutes) and logs `mission_worker_released`. If `EndFeatureRun` fails, Droid returns the error within a few seconds, the worker continues working, and the grace timer is canceled. If Droid somehow returns that result after release, it receives 409 just like any other interrupted session.

Logs are written under `logs/` in the data directory with file mode `0600` and rotate to `.1` (keeping one generation) once a file exceeds 50 MB. By default, request logs record only the request body's SHA-256, byte length, and tool names without messages or prompts; set `BRIDGE_LOG_BODIES=1` to log full (redacted) request bodies.

Install the custom Agent generator entrypoint in a target project:

```bash
npm run generate-droid -- --cwd "$PROJECT" --install-command
```

This installs both the `/relay-droid` command and the Factory-discoverable `relay-droid` skill. After restarting Droid, you can ask in natural language—e.g., `"Create a read-only JSON auditing sub-agent named json-auditor"`—and Droid will select the local BYOK generator based on the skill description. It stops after generating the configuration; issue a separate request when you want to execute it, and existing Agents continue to be invoked via Factory `Task`. Regular chat, Missions, and Agent Readiness do not require creating an Agent first.

The installer is idempotent and can also backfill the skill for projects that previously installed only the command; existing files or symlinks with different content cause an error rather than overwriting user configuration. The installed command references the current repository path, so check the installation path if you move the repository. Factory's built-in `/droids` management menu remains untouched, and manually entering its hosted generation flow still requires Factory authorization; the skill does not intercept that menu. Explicit `/relay-droid --name json-auditor --description "Read JSON fixtures"` remains available.

When the natural-language skill invokes the generator via native `Bash`, it uses the current session's active model. Factory's explicit `/relay-droid` shell command inherits the startup `BRIDGE_MODEL_ID` and does not track subsequent `/model` changes; manual wrapper launches should also export that variable in the second terminal. The generator's `--model` flag specifies the model for the newly created Agent (default `inherit`), not the model used to generate the definition itself.

[Natural-Language Entry Validation](evidence/relay-droid-discovery-validation-2026-10-16.json) records live commandless Droid creation, subsequent independent `Task` invocation, negative regular-chat cases, and clean exit using only isolated BYOK, preserving both initial failure records and post-fix evidence.

## Sessions & Tools

- Prefers `X-Bridge-Session` from responses; also accepts `X-Session-Id` or `session_id` / `sessionId` in metadata. `user_id` is never used as a session ID.
- When no ID is provided, resumes the unique complete history prefix or owning pending tool. When Factory compaction rewrites the prefix, resumption is also permitted for an authenticated session belonging to the same Factory session and working directory with no pending tools whose last complete user/assistant turn matches exactly; repeated short prompts will not merge sessions.
- When `BRIDGE_MODELS` is configured or `local` is used, idle sessions support live model switching: Bridge closes the old query, waits for its consumption loop to exit, and resumes with the same SDK session ID—appending only the new input without replaying full history. Switching is explicitly rejected if persistence is disabled, a checkpoint is missing, or work is still in flight, leaving the existing session usable; if the old query cannot be closed safely, the session is terminated. Legacy manual setups without a configured catalog retain fixed-model behavior, and `GET /v1/models` does not advertise model-switching support for them.
- Changing the role configuration tag, working directory, or execution policy still returns 409 and requires a new session. The tool catalog is not part of session identity: Bridge keeps the same SDK MCP server instance, dynamically adds/removes tools and updates schemas per request, emits `tools/list_changed`, and waits for SDK `mcpServerStatus` to confirm the tool name list before proceeding. When a schema or description changes, a versioned MCP name is used so name confirmation also confirms the active schema version; full JSON Schema constraints are exposed through the public MCP interface and validated by Ajv without rewriting arguments. Live BYOK first-call execution after a same-name schema update has been verified. Unchanged definitions and restored catalogs keep stable names to avoid unnecessary cache invalidation, though actual catalog changes can still cause cache misses.
- Changes in Droid host context are injected into user input without mutating the native system prefix. If a request carries both `tool_result` and supplementary text or base64 images, the supplementary content is tagged as a host continuation and attached to the first new tool result in that batch before returning to the real MCP callback, without fabricating extra user turns. Mixing in `document` blocks or other unsupported MCP content returns 422 before submission without consuming pending tool results.
- Idle CLI processes are bounded and reclaimed via LRU while preserving their official SDK session IDs, using SDK `resume` when a persistent transcript exists. Busy sessions are never evicted to make room.
- Across process restarts, in-flight MCP tool round-trips return 409. Importing history without a native session reconstructs context for reference only and is not equivalent to restoring Claude Code's full internal state.
- Native `PreToolUse` checks current Factory tool permissions on every invocation, even when `bypass` is enabled. Advertising only `Read` forbids `Bash`/`Write`; omitting `tools`, passing an empty list, or setting `tool_choice: none` grants no tool permissions. Tool permissions can expand or shrink within the same session, and native `Agent`/`Skill` cannot bypass Factory's `Task`/`Skill`. Spec mode locks sessions to read-only via authenticated hooks and unlocks only upon a matching successful `ExitSpecMode` receipt.
- Among tools passed by Droid, only explicit file/command equivalents are executed natively by Claude Code: `Read`/`Edit`/`Write`/`Create`/`LS`/`Grep`/`Glob`/`Execute`/`Bash`/`MultiEdit`/`NotebookEdit`. Factory `Skill`, `Task`, `ToolSearch`, `ExitSpecMode`, Mission controls, and any other declared plugin tools are delegated back to Droid via `mcp__droid__*`, preserving Factory's skill registry and task IDs; they remain separate from Claude's native `Skill`/`Agent`.
- Claude Code invokes `mcp__droid__*` tools sequentially because none of them is marked read-only. Since native `Agent` tools launch sub-agents concurrently and Droid also executes multiple `Task` calls from the same response concurrently, when Bridge encounters a `Task` call it waits for the current assistant message stream to finish and batches any immediately contiguous `Task` calls to hand back to Droid together; the batch stops at any non-`Task` tool or any `Task` whose input would be rejected by its handler. Each `Task` still passes through its own handler and receives its corresponding result from Droid in original order. Droid responds to a `Task` batch with `"started in background"` first and delivers each sub-agent's output as a new message once finished—this is Droid's native parallelism model. The `task_batch` event in the turns log records the call IDs delivered together. `Task` is not marked read-only as a result, and Droid's approval behavior is unchanged.
- When Factory supplies a non-empty `system` prompt, Bridge preserves its role, skills, and workflow instructions verbatim without guessing roles from headers or appending role templates; `X-Bridge-Role` serves only as a model-config/session tag, as real `Task` sub-agents inherit the orchestrator header. Role fallbacks are used only when host instructions are absent, and the orchestrator fallback additionally requires Mission control tools to be present (`Task` alone is insufficient). The production SDK path never synthesizes `StartMissionRun` or copies Mission ledgers from leftover directories.

## Current Verification Scope

See [Factory Surfaces Validation](docs/FACTORY-SURFACES.md) for the live paths and fixes added on 2026-10-16: Factory native compaction and handoff, Spec read-only lock and exit, custom Droids, interactive review, tool permission revocation, schema updates, and prompt caching all have independent evidence. All live validations exclusively use isolated GLM BYOK.

The latest [Fresh Mission Run](evidence/mission-final-validation-2026-10-16-r3.json) passed continuously in a single run: 18 minutes 46 seconds, completing implementation, scrutiny, and user-testing across three features with 5/5 verification checks passing, original tests and `package.json` preserved intact, zero runtime errors, and zero lingering processes. It records the runtime source fingerprint; three subsequent targeted fixes and the final verification scope are summarized in [Final Validation Summary](evidence/final-validation-2026-10-16.json). Earlier records of manual interruptions and environment disconnects are preserved.

The 2026-10-15 GLM-5.2 BYOK validation covers: successful regular replies across Droid → Bridge → Claude Code; three-turn context retention in both native SDK and Bridge; native `Read` and streaming traces, plus full-history resumption without an explicit session ID preserving the same session and memory; and a live SDK MCP `TaskOutput` round-trip (using a local fixture for the external tool result). Bridge's native manual `/compact` produces a `compact_boundary` and recalls information agreed upon prior to compaction on the next turn. [Native Session Validation Summary](evidence/native-session-validation-2026-10-15.json) preserves the measurements and offline check results from that run.

Subsequent [Factory Host Validation](evidence/factory-host-validation-2026-10-15.json) confirmed that newly discovered tools become available on the first continuation turn, full `Skill` bodies are delivered intact, and `Task` sub-agents and Missions launch properly. Issues discovered and fixed during testing—such as premature handoff before tool validation, title-helper requests executing tools without authorization, and hanging native callbacks after worker termination—remain documented alongside their failure records.

The historical [Full Mission Validation](evidence/mission-validation-2026-10-15.json) recorded **PASS_WITH_RECOVERY**: starting from a defective project with no pre-existing Mission artifacts, a live orchestrator, worker, and validator completed 3 features and 5 verification assertions while keeping original tests and `package.json` intact and passing. After hitting the old 20-minute test harness timeout on the first run, the same Mission was resumed via official `droid exec --session-id` and finished in ~130 seconds; this was not a single uninterrupted run. At completion, active native runs, pending tools, pending approvals, and Bridge errors were all zero, and all child processes were cleaned up. The updated verification script defaults to a 1-hour total deadline and never synthesizes startup events or copies ledgers to fabricate completion.

Factory lifecycle events are connected to an independent control channel via official [hooks](https://docs.factory.com/harness/hooks). `SessionStart` registers a random generation ID and passes it to subsequent hooks through the official environment file; the tag is stripped before reaching Claude's native prompt. `PostToolUse` records the actual result received, and `SessionEnd` releases native waits once termination is confirmed; if Factory exits early and skips `PostToolUse`, the wait is interrupted rather than fabricating a successful result, while regular tools still wait for the next HTTP continuation so `ToolSearch` catalog updates and supplementary content are delivered together. Clean session exits can resume from native checkpoints, and terminated workers reject late-arriving results.

[Control Channel Validation](evidence/control-validation-2026-10-15.json) further confirmed: denying a native tool performs no write, approving executes it exactly once, and canceling a pending approval causes subsequent approval attempts to return 409. Clean exit and resumption with hooks preserves the same native session, with Claude Code recording `input_tokens=278` and `cache_read_input_tokens=21760` on the resumed turn; termination events from stale generations are rejected without affecting the new session. A live Claude subscription has still not been used.

[Auto-Compaction Validation](evidence/auto-compaction-validation-2026-10-15.json) also passed: lowering the trigger threshold via official configuration inside an isolated test process (without sending `/compact`) produced a native `trigger: auto` compaction from 90,038 → 2,245 tokens, and the same session accurately recalled prior facts across two subsequent turns. This test verifies the auto-compaction pipeline and does not represent default thresholds or token consumption on a live Claude subscription.

In the raw cache responses from the comparison above, the native path recorded `input_tokens` of 211 / 108 and `cache_read_input_tokens` of 21,056 / 21,248 across turns 2 and 3, while Bridge recorded 74 / 98 and 21,248 / 21,312. Both paths maintained stable system/tools hashes across all three turns with identical tool schemas; at the time, Bridge's stable append added 546 characters. Because the append and tool catalog have since expanded, those numbers are retained as point-in-time measurements from that run. The upstream endpoint did not return `cache_creation_input_tokens`, so an exact overall cache hit rate is not reported; SDK `costUSD` is an estimate rather than a billing statement. See [Cache & Compaction Evidence](docs/T3-ALIGNMENT.md#缓存与压缩验证) for details.

Earlier MiniMax Mission `PASS` records in historical `REPORT.md` and `evidence/` belong to a previous implementation and do not endorse the current Mission architecture. Cache hit rates computed from legacy mixed-usage ledgers are likewise not used as current statistics.

## Testing

The repository's primary verification entrypoint is `npm run verify:relay -- --feature chat`. Following the [verification skill](.cursor/skills/verify-relay-bridge/SKILL.md), it starts an isolated instance, runs a read-only `doctor`, verifies file read/write and same-session resumption through the real Droid CLI, and finally cleans up processes and private configs while preserving redacted evidence. Configure an explicit BYOK upstream per the skill first; `--offline-check` validates local prerequisites only without invoking any model.

[Verification Skill Execution Record](evidence/verification-skill-validation-2026-10-16-r2.json) captures the live chat/resume results after the final BYOK isolation fixes; see [Factory Surfaces Validation](docs/FACTORY-SURFACES.md) for scenario-specific entrypoints and coverage. Historical false positives and failure records remain preserved.

**A pinned BYOK setup must not be mistaken for full coverage of Factory's hosted model capabilities.** [Factory Surfaces Validation](docs/FACTORY-SURFACES.md) distinguishes verified fixes, available alternative entrypoints, and standalone service prerequisites; the [Early Static Surface Inventory](evidence/factory-model-surface-2026-10-15.json) is not a list of currently passing runtime flows. Static binary/file inspection (REA) is not a complete call graph, and the total number of hidden or server-side entrypoints remains unknown.

| Command | Scope | Invokes Live Model? |
|---|---|---|
| `npm test` | Unit, protocol, fake relay, SDK adapter injected events, resilience | No |
| `npm run test:protocol` | Messages, SSE, errors, and authentication | No |
| `npm run test:sdk-probes` | Cross-request tool relay against fake runtime | No |
| `npx vitest run tests/sdk-runtime` | Real adapter code with injected SDK events; not live model validation | No |
| `npm run test:resilience` | Retries, cancellation, images | No |
| `npm run tiny-tasks:test` | Tiny Tasks reference fixture | No |
| `npm run doctor` | Redacted diagnostics | No |
| `npm run verify:relay -- --feature chat` | Live CLI file operations, session resumption, and cleanup evidence | Yes, isolated BYOK |
| `npm run verify:spec -- --adversarial-spec` | Spec read-only enforcement and write after real exit | Yes, isolated BYOK |
| `npm run verify:custom -- --read-only-custom` | Custom Droid, model selection, and tool restrictions | Yes, isolated BYOK |
| `npm run verify:context -- --auto` | Factory compaction, handoff, resumption, and auto-trigger | Yes, isolated BYOK |
| `npm run verify:native-schema` / `npm run verify:native-policy` | In-session schema versioning and tool permission changes | Yes, isolated BYOK |
| `npm run verify:auxiliary` | Auxiliary entrypoint reachability and capability denial checks | Yes, isolated BYOK |
| `npm run verify:mission -- --summary evidence/new-mission.json` | Independent fresh Mission validation without overwriting old evidence | Yes, isolated BYOK |
| `npm run test:g0` | Installed Droid airgap behavior | Depends on probe |
| `npm run probe:upstream` | BYOK upstream tool-calling probe | Yes |
| `npm run test:e2e:chat` / `npm run test:e2e:mission` | Live chat / Mission validation | Yes, run separately and record results |

See [Compatibility](docs/COMPATIBILITY.md) for additional protocol boundaries. `FACTORY_AIRGAP_ENABLED=1` in the public CLI is an observed technical behavior, not an official authorization statement.
