# Skills and delegated agents

A user asks Droid to apply a registered skill or delegate work, then uses the returned instructions/results in the parent conversation.

## Sub-features

- `factory-skill` returns the actual registered Factory skill body.
- `factory-task` runs an actual Factory subagent and returns its result.
- `factory-task-summary` observes the host's summary request after delegated work.
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
- **Unmapped custom path.** Record arbitrary custom Droid generation/selection and model override as `NOT_VERIFIED` until a dedicated registered fixture and real drive are added. The chat helper is not a substitute.

## Gotchas

- `Skill` and `Task` in Factory are not Claude Code's native Skill/Agent operations even when names resemble one another.
- Previous Mission evidence covers specific built-in readiness/review/testing agents, not every custom Droid or tool plugin.
- Receiving a summary request establishes observation; it does not prove all summary inputs, retries and truncation behavior.
- Isolated BYOK Claude config does not automatically inherit the user's native skills.
