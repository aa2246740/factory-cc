# Limitations

- Official Anthropic / Claude login is unused. `sdk` mode is a non-Claude BYOK path (MiniMax, then GLM, then OpenRouter free). Real Claude-branded billing is still `BLOCKED_AUTH`.
- Public `FACTORY_AIRGAP_ENABLED=1` is an experiment input. Official airgap docs describe an enterprise build that is not publicly distributed. A technical skip-login observation is not an authorization.
- First-party Droid web, mobile, and desktop surfaces are out of scope.
- OS-level isolation (separate user / container for Bridge vs Droid project) is not available on this cloud image.
- `tools: []` only removes Claude Code built-in tools from the model context.
- Token counting returns HTTP 501. Usage in mock/fake is estimated.
- `tool_choice`, `stop_sequences`, and signed thinking are not fully mapped.
- SDK `resume` does not restore in-memory mailbox Promises. Restart recovery is best-effort JSONL; if unsafe, Bridge fails closed.
- Tiny Tasks in `fixtures/tiny-tasks` is a locked fixture/reference. It is not a Mission-produced app.
- This repo does not patch Droid or Claude binaries and does not implement license bypasses.
