# Approvals, cancellation and control

A user inspects a pending native tool's exact input, allows or denies it once, and can cancel the running session.

## Sub-features

- `control-approve` executes an allowed native operation exactly once.
- `control-deny` denies the request without the requested file side effect.
- `control-cancel` cancels a live callback and rejects a late decision.
- `control-browser` exercises the real `/control` page, not just its HTTP API.
- `control-wrapper-signal` ends only the launched process/session tree.
- `native-capability-policy` enforces advertised tool subsets and revocation even in bypass mode.
- `factory-spec-policy` locks native modification until authenticated approval.

## How to get to it (user POV)

- Open `/control` on the Bridge URL, connect with the owned admin token and choose `允许一次`, `拒绝` or `取消会话`.
- Use `npm run control -- approvals` / `sessions`, then approve, deny or cancel the actual listed ID.
- Stop a launch through the production `run-droid` wrapper.

## Driving it with the control CLI and browser

Preconditions:

- Start an owned disposable SDK/BYOK instance with `BRIDGE_PERMISSION=ask`, following the repository README's hooks/wrapper setup. Do not reuse the bypass chat helper.
- Export that instance's `BRIDGE_CONTROL_URL` and `BRIDGE_ADMIN_TOKEN` in the control terminal without printing the token.
- There must be a real pending native request; missing preconditions are a blocked journey.

- **Observe.** Run `npm run control -- approvals` and `npm run control -- sessions`. Retain the exact tool input and selected live ID in sanitized evidence.
- **Decide.** Invoke the corresponding production `approve`, `deny` or `cancel` command with that actual ID; independently inspect the disposable target file and original request result.
- **Browser entry.** Drive the connect form and actual `允许一次`/`拒绝`/`取消会话` buttons in a real browser. Capture the action, screenshot and accessible state; API proof cannot substitute.
- **Tool subset regression.** Run `npm run verify:native-policy -- --summary evidence/new-policy.json`; require a real denied Bash call, no forbidden file, successful Execute grant, then real denial after revocation in the same native session.
- **Spec regression.** Run `npm run verify:spec -- --adversarial-spec --summary evidence/new-spec.json`; verify the denied pre-approval Write and successful post-ExitSpecMode Write independently.
- **PTY cancellation.** Use `scripts/verify-interactive.ts` to start a real delayed command, confirm its started side effect, press Escape and wait beyond its deadline before checking the forbidden late write.
- **Repeatable browser proof.** Install `playwright-core` into a disposable tooling directory outside the production package and use an installed Chromium executable. The helper starts its own isolated ask-mode Bridge; only the explicit `BRIDGE_UPSTREAM_BASE_URL`, `BRIDGE_UPSTREAM_MODEL`, `BRIDGE_UPSTREAM_TOKEN_ENV` selection and official `BRIDGE_CLAUDE_EXECUTABLE` are used. Set the following browser paths for your machine:

  ```bash
  browser_tools_dir=$(mktemp -d)
  npm install --prefix "$browser_tools_dir" --no-save --package-lock=false playwright-core
  BRIDGE_BROWSER_MODULE="$browser_tools_dir/node_modules/playwright-core/index.mjs" \
  BRIDGE_BROWSER_EXECUTABLE=/usr/bin/chromium \
  node --import tsx scripts/verify-browser-control.ts --summary evidence/new-browser-control.json
  ```

  The helper uses real DOM `fill`/`click` interactions for connect, deny, allow once, cancel, a stale tab's late allow, and disconnect. It checks each actual native Bash command and its independently read file effect. A second tab's polling clock is frozen to exercise the stale-button race; the old approval must return 409. Screenshots omit the cleared token input; raw model replies stay in ignored `evidence/local/`. After owned processes exit, the private `claude-config` directory is removed and the independent `privateConfigRemoved` gate must pass; sanitized Bridge logs remain for review. This is a direct Bridge/Claude browser-control fixture, separate from a Droid TUI run. `--help` makes no browser/model call. Existing summary files are never overwritten.
- **Recorded browser run.** [2026-10-16 Chromium evidence](../../../../evidence/browser-control-validation-2026-10-16.json) contains the seven PASS gates and screenshot paths/hashes; [supplemental private-config cleanup](../../../../evidence/browser-control-private-cleanup-2026-10-16.json) records removal after that historical run without changing its hashes; the separate [connection-status regression reproduction](../../../../evidence/browser-connect-status-before-2026-10-16.json) intentionally fails before the UI fix. The [post-fix Chromium run](../../../../evidence/browser-connect-status-after-2026-10-16.json) passes connection text, refresh, disconnect, private-config removal and owned-process cleanup with zero model requests. Use `--connect-only` to repeat that UI check.
- **Chat driver scope.** `verify-relay --feature chat` still does not exercise ask/browser controls; use the dedicated helper above and require its own gates.

## Gotchas

- Native policy may allow a tool without invoking the permission callback. No callback means no approval journey was exercised.
- Bypass is not a filesystem sandbox and cannot establish ask-mode behavior.
- An expired/stale decision must not execute a tool. Do not auto-retry a mutation after an uncertain transport response.
- Raw-TTY Ctrl-C handled inside Droid is separate from OS signals observed by the wrapper; Windows descendant cleanup is also a separate unverified platform path.
