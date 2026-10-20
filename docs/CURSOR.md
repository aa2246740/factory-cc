# Cursor beside Claude Code

Claude Code stays the default runtime. `BRIDGE_AUTH` is still only the Claude credential. Cursor is a second runtime in the same process. Factory Droid sees one menu and one base URL. The bridge sends each request to the runtime that owns the selected model. `/healthz` still reports `mode: "sdk"`.

Live behavior was checked on 2026-10-20 against `@cursor/sdk` 1.0.35. The notes are [cursor-live/EVIDENCE.md](/Volumes/Workspace/Scratch/factory-cc-provider-feasibility/cursor-live/EVIDENCE.md) and [cursor-live-r2/EVIDENCE.md](/Volumes/Workspace/Scratch/factory-cc-provider-feasibility/cursor-live-r2/EVIDENCE.md). Neither file is part of this repo. Do not copy credentials out of the probe state directory.

## What those runs showed

Probes A–F passed. `Cursor.models.list()` returned 47 models. Composer 2.5 and Grok 4.7 were both present. `Cursor.me()` and the catalog had no usage or token fields. Omitting `settingSources` did not load the machine's `rea` MCP server. The native allowlist kept shell and edit out while a custom tool still ran. Replacing `customTools` on a parked run worked. `Agent.resume` after a process restart reused the agent stored under the bridge data directory. A custom tool left pending for 10 minutes, and another left for 30 minutes, both finished after the result was delivered.

The first Droid end-to-end pass did not. One run advertised `mcp__droid__Execute`, which current `droid exec` rejects, and the model invented the expected word. A later run kept one Droid session through the tool round trip, then opened a new bridge session on the follow-up. The cause was the history fingerprint: Droid omits `is_error` on a successful tool result, then replays that block with `is_error: false`. The text is the same. [Round 2](/Volumes/Workspace/Scratch/factory-cc-provider-feasibility/cursor-live-r2/EVIDENCE.md) fixed that and completed four Droid turns on one bridge session and one Cursor agent. Composer ran with `fast=false`. The 10-minute and 30-minute parks above are the tool-park evidence.

`historyMessageHashes` now drops `is_error: false` and keeps `is_error: true`. That function is shared, so the same miss used to happen on the Claude Code path after a successful Droid tool result. Sessions whose stored history was hashed while `is_error: false` was still part of the fingerprint can miss once after this upgrade and cold-import. The next turn uses the new hash.

## Menu

The default Cursor menu is exactly two entries:

- `cursor:composer-2.5` — `Cursor · Composer 2.5`, `fast=false`
- `cursor:grok-4.7` — `Cursor · Grok 4.7`, `fast=false`, `reasoning_effort=high`, context `256k`

The live catalog does not match those pins by default. Composer 2.5 publishes only `fast`, and its default variant is Fast. Grok 4.7 publishes `reasoning_effort`, `context` (`256k` or `500k`), and `fast`. Its default variant is 500k + high + Fast. There is no value named `standard` and no parameter named `effort` on that row. The pin uses the first non-500k context, which is `256k`. Those pins live in `src/runtime/cursor/pins.ts`.

Both labels use the `Cursor ·` prefix. Claude entries keep `Claude Code ·`. There is no Auto entry and no Claude, GPT, or Gemini entry unless you name it. `auto` is rejected. `all` does not dump the catalog into the menu.

`--cursor-models first-party` adds Composer 2.5 and Grok 4.5/4.6/4.7 with the same pins. `--cursor-models id,id` or `id[key=value,...]` names specific rows, including a third-party model. `composer-2.5-fast` is the one discrete alias, and it maps to `fast=true`.

`cursorLiveCatalogFixture` is the live shape. The older adversarial fixture still uses `effort` and a value named `standard`.

## Login, catalog, and expiry

The key is `CURSOR_API_KEY` or `BRIDGE_DATA_DIR/cursor-auth.json` (mode 0600). `npm run desktop -- cursor login` calls `Cursor.auth.login()` through the lazy loader in `src/runtime/cursor/sdk-load.ts`. The SDK credential store is that bridge file, not `~/.cursor/sdk/auth.json`. The minted key is named `factory-cc (<hostname>)` and uses the SDK's default 90-day TTL. The command prints the login URL and the expiry. It does not print the key. An expired file is logged out.

`npm run desktop -- cursor models [filter]` calls `Cursor.models.list()` with the stored key or `CURSOR_API_KEY`, writes `cursor-catalog.json` (mode 0600), and prints the rows. `install` and `restart` with `--cursor-models` use that fetch for menu validation. With no credential, those commands stop and tell you to run `npm run desktop -- cursor login` first. `install` and `restart` without `--cursor-models` still set up the Claude menu when Cursor is not logged in. Cursor entries are left off, and the command says so in one line.

`npm run desktop -- status` and `npm run desktop -- cursor status` show the expiry. When 7 days or less remain, including an already expired key, they warn and name the login command. If a request finds the stored key expired, or Cursor rejects the key, the error Droid sees says to run `npm run desktop -- cursor login`. The LaunchAgent plist stores the menu file path, not the key.

## Sessions

Sessions record `provider`. The fingerprint includes it for Cursor, and a model switch substitutes only the model. Claude to Cursor starts a new session. The first Cursor send of that session carries the old transcript as reference text. It does not resume the Claude session. Cursor does not set `systemPrompt` and does not load `settingSources`.

Droid tools are in-process `local.customTools`. `execute()` stays pending until `deliverResults` or `completeHostTool`. The assistant message uses the tool name Droid advertised. Current `droid exec` advertises `Execute` and rejects `mcp__droid__Execute`. Native tools are `read`, `grep`, `glob`, `ls`, and `mcp`. Creation fails if `mcp` is missing. Droid's reasoning selector is not mapped.

## Commands

```bash
npm run desktop -- cursor login
npm run desktop -- cursor status
npm run desktop -- cursor models composer
npm run desktop -- install --cursor-models default
npm run desktop -- restart --cursor-models first-party
```

`install` and `restart` without `--cursor-models` only refresh the Claude Code menu.
