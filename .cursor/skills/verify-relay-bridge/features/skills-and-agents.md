# Skills and delegated agents

A user asks Droid to apply a registered skill or delegate work, then uses the returned instructions/results in the parent conversation.

## Sub-features

- `factory-skill` returns the actual registered Factory skill body.
- `factory-task` runs an actual Factory subagent and returns its result.
- `factory-task-summary` tracks a candidate separate summary path after delegated work; its existence and execution remain unestablished.
- `factory-custom-droid` creates/selects a custom Droid, including explicit model overrides.
- `native-skills-agents` uses Claude-native skills/agents as a distinct path.

## How to get to it (user POV)

- Ask Droid to use one of its available skills or delegate a task.
- Run the real Mission workflow, which invokes planning/worker/validator skills and readiness/review/testing agents.
- Use Droid's custom-agent configuration flow to create/select a custom Droid; this requires a separate recipe from built-in Task delegation.

## Driving it with Droid CLI

Preconditions:

- Use a fresh isolated Factory home, known project and actual installed skill/droid definitions.
- Read the Mission recipe before using its longer drive. Do not fabricate tool calls to replace a missing registration.

- **Existing automated path.** Run `npm run test:e2e:mission`. Retain the real Factory transcript and returned skill text, actual Task type/session and handoff records.
- **Skill proof.** Require the invoked registered name, complete body returned by the real callback, and an observable subsequent action using those instructions.
- **Delegation proof.** Require the actual child task identity, child result and parent continuation. Headers such as `X-Bridge-Role` do not establish task type.
- **Custom path.** Run `npm run verify:custom -- --read-only-custom --summary evidence/new-custom.json`. Require the actual Factory Task, separate native child, body-only marker absent from Task prompt, parent without fixture Read/Write, explicit child model alias, correct result and denial of an attempted unadvertised Write. Both aliases map to the same selected upstream; this is not a multi-provider test.
- **Generation.** `node --import tsx scripts/verify-interactive.ts --generation-only evidence/new-generation.json` uses the installed `/relay-droid` executable command, then invokes its generated definition through actual Factory Task. Require the parent Task call and successful matching result, a distinct native child with the exact delegated prompt, nonce absent from that prompt, successful child Read, correct child/parent JSON, and no parent file tools during delegation. The hosted `/droids` generator has a separate Factory authorization requirement. See [the final generation run](../../../../evidence/interactive-generation-validation-2026-10-16.json) and [combined evidence](../../../../evidence/interactive-final-validation-2026-10-16.json).

To create a project Droid outside the fixture, provide the running Bridge's existing `BRIDGE_CLIENT_TOKEN` and `BRIDGE_CONTROL_URL`, then use either entry:

```bash
npm run generate-droid -- --cwd /absolute/project --name json-auditor \
  --description "Read JSON fixtures and check arithmetic"
npm run generate-droid -- --cwd /absolute/project --install-command
```

Restart Droid after command and skill installation, then ask naturally to create a custom agent, or run `/relay-droid --name another-auditor --description "Read JSON fixtures and check arithmetic"`. It creates configuration and reports its path; ask separately to invoke the new child. Names, model selection and tools come from explicit caller options; existing files are never overwritten. The default model is `inherit` and default tools are `Read,LS,Grep,Glob`.

- **Natural-language discovery.** `node --import tsx scripts/verify-interactive.ts --natural-generation-only evidence/new-natural-generation.json` starts a real PTY with the installed companion Factory skill. The initial Chinese request must not mention the skill name, slash command, command path or tool selection. Require actual Factory Skill activation with the full installed body, then successful execution of the installed generator through native Bash, authenticated generator traffic and an independently read definition. Creation must not invoke the new agent or read its input fixture. A separate request must use Factory Task and the child proof above; an ordinary chat turn must not generate another agent. Do not inject extra native credentials in the test: the production Bridge must supply its own local client connection.

Installation adds both the executable command and `.factory/skills/relay-droid/SKILL.md`. Restart Droid for discovery; repeat installation safely to upgrade an unchanged command-only setup. Conflicting files are preserved. Skill selection depends on the model; manually selecting Factory's hosted menu still follows that hosted path.

Require a clean terminal lifecycle as well as zero runtime errors. Factory can emit a client-owned `SessionEnd` without the agent's environment-file binding, then emit an agent-owned event with it. The production wrapper's exact launch/session identity permits only that missing-binding exit case; stale explicit bindings and ambiguous generations remain rejected. `--exit-only` drives two ordinary chat turns and real `/exit` for a focused check. Never treat CLI exit code 0 and eventual cleanup alone as proof that every hook succeeded.

## Gotchas

- `Skill` and `Task` in Factory are not Claude Code's native Skill/Agent operations even when names resemble one another.
- Previous Mission evidence covers specific built-in readiness/review/testing agents, not every custom Droid or tool plugin.
- The old Task-summary observation was misclassified: its prompt is Factory Summarizer. No independent Task-summary helper inference has been established.
- Isolated BYOK Claude config does not automatically inherit the user's native skills.
