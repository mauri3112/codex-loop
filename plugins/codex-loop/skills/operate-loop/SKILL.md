---
name: operate-loop
description: Inspect, start, pause, resume, stop, diagnose, or report on a Codex Loop run. Use when a user asks about Loop status, failures, stalled agents, checkpoints, setup requirements, runtime evidence, or explicitly requests a run-control action.
---

# Operate Loop

Use the `codex-loop` MCP server to inspect and safely control an existing Loop.

## Workflow

1. Call `loop_get` and report the exact revision, lifecycle, validation state, run status, open attention, and missing capability or secret bindings.
2. For diagnosis or status, remain read-only. Distinguish definition readiness from live runtime success.
3. Before starting or resuming, call `loop_validate`. Do not proceed with validation errors, missing required bindings, or a draft the user has not asked to run.
4. Treat `loop_start`, `loop_resume`, and `loop_stop` as consequential actions. Invoke them only when the user explicitly requests that operation. Describe likely external effects before starting when the Loop can modify repositories or external systems.
5. `loop_pause` stops scheduling new work; it does not claim active work was rolled back. `loop_stop` may interrupt active agents; report what completed checkpoints remain recoverable.
6. Resolve an approval node with `loop_gate_decision` only after the user explicitly approves or declines that named gate. Never infer approval from the original request.
7. After a control action, call `loop_get` again and report the observed state rather than assuming success.

Never publish, redesign, or patch a Loop through this skill. Use `$design-loop` when the definition itself must change. Read [runtime-safety.md](references/runtime-safety.md) before any start, resume, or stop operation.
