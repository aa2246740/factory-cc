# Validation Contract — Tiny Tasks

## VAL-FILTER-001
`visibleTasks(tasks, "completed")` returns only tasks where `completed` is true.

Tool: vitest
Evidence: `npm test`

## VAL-COUNTS-001
`counts(tasks).completed` equals the number of completed tasks, not the total length.

Tool: vitest
Evidence: `npm test`
