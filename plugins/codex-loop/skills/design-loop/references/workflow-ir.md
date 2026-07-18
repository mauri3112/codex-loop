# Loop workflow IR

- `agent`: one focused Codex task.
- `map`: fan one task over a discovered collection.
- `join`: wait for upstream results and synthesize them.
- `condition`: route using an explicit expression.
- `loop`: repeat until a measurable stop condition or iteration budget.
- `verify`: independently evaluate evidence against a rubric.
- `gate`: require explicit approval between stages.
- `subworkflow`: invoke a published Loop by id.

Prefer the smallest graph that makes dependencies, verification, and stopping behavior explicit. Use independent verification for high-risk work. Use isolated worktrees when concurrent agents can edit overlapping repositories.
