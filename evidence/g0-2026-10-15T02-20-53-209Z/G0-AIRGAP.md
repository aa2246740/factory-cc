# G0 Airgap + BYOK probe

- Date (UTC): 2026-10-15T02:21:01.568Z
- Droid: 0.241.1
- Isolated HOME: /tmp/relay-g0-home-4gaG53
- Isolated workspace: /tmp/relay-g0-ws-2eaXg0
- Settings: /tmp/relay-g0-home-4gaG53/.factory/settings.json
- Factory credentials: none
- Claude/Anthropic credentials: unused (mock mode)

## Cases

### A0 — public CLI auth gate without airgap

- airgap env: false
- token: valid
- command: `droid exec -m relay-probe RELAY_TEXT_PROBE`
- exit: 0
- bridge requests this case: 2

stdout (redacted):
```
relay-bridge mock: tool result accepted; canary=present
```
stderr (redacted):
```
(empty)
```

### A1 — airgap env + mock BYOK text

- airgap env: true
- token: valid
- command: `droid exec -m relay-probe RELAY_TEXT_PROBE`
- exit: 0
- bridge requests this case: 2

stdout (redacted):
```
relay-bridge mock: tool result accepted; canary=present
```
stderr (redacted):
```
(empty)
```

### A2 — airgap + wrong local token

- airgap env: true
- token: invalid
- command: `droid exec -m relay-probe RELAY_TEXT_PROBE`
- exit: 1
- bridge requests this case: 1

stdout (redacted):
```
(empty)
```
stderr (redacted):
```
Error during droid execution: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid bridge client token"}}
```

### A3 — airgap + readonly tool roundtrip

- airgap env: true
- token: valid
- command: `droid exec -m relay-probe --list-tools`
- exit: 0
- bridge requests this case: 0

stdout (redacted):
```
Available tools for Relay Probe
Autonomy: read-only

Read
  • DismissHandoffItems (Dismiss Handoff Items) - status: blocked
  • EndFeatureRun (End Feature Run) - status: blocked
  • ExitSpecMode (Propose Specification) - status: blocked
  • Glob - status: allowed
  • Grep - status: allowed
  • LS - status: allowed
  • ProposeMission (Propose Mission) - status: blocked
  • Read - status: allowed
  • StageSettingsChanges (Stage Settings Changes) - status: allowed
  • StartMissionRun (Start Mission Run) - status: blocked
  • TodoWrite (Plan) - status: allowed

Edit
  • Create - status: blocked
  • Edit - status: blocked

Execute
  • Execute - status: allowed
  • Loop - status: blocked
  • Skill - status: allowed
  • Task - status: blocked
  • TaskOutput (Result) - status: blocked
  • TaskStop - status: blocked
  • ToolSearch - status: allowed
```
stderr (redacted):
```
(empty)
```

### A3b — airgap + tool probe prompt

- airgap env: true
- token: valid
- command: `droid exec -m relay-probe RELAY_TOOL_PROBE read CANARY.txt RELAY_CANARY_G0FIXED CANARY_PATH=CANARY.txt`
- exit: 0
- bridge requests this case: 2

stdout (redacted):
```
relay-bridge mock: tool result accepted; canary_mismatch
```
stderr (redacted):
```
(empty)
```

### A4 — airgap Mission initial request only

- airgap env: true
- token: valid
- command: `droid exec --mission -m relay-probe --worker-model relay-probe --validator-model relay-probe --auto high -f MISSION.md`
- exit: 0
- bridge requests this case: 1

stdout (redacted):
```
relay-bridge mock: text probe ok
```
stderr (redacted):
```
(empty)
```

## Authorization notes

- Official airgap documentation describes an enterprise-only build, not this public CLI flag.
- Observed skip-login or BYOK behavior is an experiment result for this installed version only.
- This report does not claim official authorization for public CLI airgap use.

