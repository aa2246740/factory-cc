# Chat, native file work and continuation

A user asks Droid to work in a project and later continues the same conversation while Claude Code performs the native work.

## Sub-features

- `chat-exec` returns a real answer through the configured Bridge model.
- `chat-native-file` reads existing project content and writes the requested result.
- `chat-resume` recalls prior information through official `--session-id` continuation.
- `chat-cache` captures Claude Code-side observed usage without mixing Droid totals.
- `chat-native-compact` preserves useful context across native manual/automatic compaction.
- `chat-tui-and-stream` covers interactive TUI, stdin and streaming-json entry variants separately.

## How to get to it (user POV)

- Use the configured model in `droid exec` or the interactive `droid` session.
- Continue a previous exec with its returned `session_id` using `droid exec --session-id`.
- The production wrapper is `npm run run-droid -- --cwd "$PROJECT" --airgap 1 -- exec ...` with the user's actual Droid arguments after `--`.

## Driving it with verify-relay

Preconditions:

- Parent skill Launch succeeds and an explicitly authorized BYOK selection is available.
- No shared/user workspace is used; the helper seeds its own random input fixture.

- **Drive.** Run `npm run verify:relay -- --feature chat`. The helper captures the actual production wrapper arguments and both real Droid responses.
- **File work.** Require a native file-read/tool trace and independently compare the output file with the seeded content. The prompt must not disclose the hidden value it asks the model to read.
- **Continue.** The second invocation supplies the actual returned Factory session ID. Require exact recall without repeating the answer in the second prompt, plus the recorded Bridge/native session identities.
- **Observe caching.** Retain provider usage fields and their coverage; nonzero cache-read is observed reuse, not a guaranteed subscription hit rate.
- **Clean up.** Require no owned processes/pending work, no remaining private test directories, and surviving evidence files.

## Gotchas

- `--feature chat` uses JSON exec; it does not verify TUI keyboard behavior, stdin/streaming-json variants, or browser surfaces.
- Historical native manual/automatic compaction proof is in the two compaction evidence files; this chat journey does not rerun those operations.
- Factory summarization is a different model path from Claude Code compaction.
- A fresh Factory session carrying the same prompt is not continuation. A correct answer alone is not proof of native session reuse.
- The helper's bypass fixture does not exercise approval prompts.
