# Tool roundtrip fixture

`CANARY.txt` is the only-Droid-readable file used by mock/fake probes. The SDK sandbox cwd must not include this directory when proving that Claude Code did not read the canary itself.
