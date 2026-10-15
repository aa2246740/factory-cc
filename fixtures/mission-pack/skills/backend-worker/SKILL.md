---
name: backend-worker
description: Fix the completed filter defect in tiny-tasks
---

# Backend Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## Required Skills and Tools

- TypeScript
- vitest (`npm test`)
- Droid Read, Edit, Execute

## Work Procedure

1. Read `src/store.ts` and `tests/acceptance.test.ts`.
2. Fix `visibleTasks` so `filter === "completed"` returns only completed tasks.
3. Fix `counts` so `completed` is the number of completed tasks.
4. Run `npm test` and keep the existing acceptance tests passing.

## Example Handoff

```json
{
  "salientSummary": "Fixed visibleTasks and counts so the completed filter is honest.",
  "whatWasImplemented": "src/store.ts completed filter now uses task.completed",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      { "command": "npm test", "exitCode": 0, "observation": "acceptance tests pass" }
    ]
  },
  "tests": {
    "added": [],
    "existing": [{ "file": "tests/acceptance.test.ts", "cases": [] }]
  },
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- Tests fail after the intended fix
- Required files are missing
