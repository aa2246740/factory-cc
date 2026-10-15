# Approvals, cancellation and control

A user inspects a pending native tool's exact input, allows or denies it once, and can cancel the running session.

## Sub-features

- `control-approve` executes an allowed native operation exactly once.
- `control-deny` denies the request without the requested file side effect.
- `control-cancel` cancels a live callback and rejects a late decision.
- `control-browser` exercises the real `/control` page, not just its HTTP API.
- `control-wrapper-signal` ends only the launched process/session tree.

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
- **Current automation gap.** No browser/ask journey is implemented by `verify-relay --feature chat`. Record it as not rerun; use the separate historical live evidence only for its specifically tested native API callbacks.

## Gotchas

- Native policy may allow a tool without invoking the permission callback. No callback means no approval journey was exercised.
- Bypass is not a filesystem sandbox and cannot establish ask-mode behavior.
- An expired/stale decision must not execute a tool. Do not auto-retry a mutation after an uncertain transport response.
- Raw-TTY Ctrl-C handled inside Droid is separate from OS signals observed by the wrapper; Windows descendant cleanup is also a separate unverified platform path.
