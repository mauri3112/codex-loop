# Attention and intervention

Codex Loop treats human attention as a separate concern from workflow execution. A workflow may still be `running` while one Agent branch is waiting for an answer, and independent branches may continue. This keeps a local question or suspected stall from being mistaken for a global workflow failure.

The first iteration is deliberately conservative: it surfaces uncertainty and gives the user explicit delivery choices. It does not silently interrupt, approve, redirect, or resume work.

## First-iteration contract

- [x] **Separate attention state.** Attention requests and interventions have their own lifecycle; `WorkflowStatus` remains the execution state.
- [x] **Branch-scoped native input.** A native Codex `requestUserInput` request pauses the affected Agent branch, not every independent branch in the workflow.
- [x] **Explicit delivery.** The user chooses whether guidance should steer the active turn, queue a follow-up turn, or become shared context for selected remaining Agents.
- [x] **Explicit pause.** Requesting or answering input does not pause or resume the whole workflow. Pause remains a separate user action that prevents new nodes from starting while active turns may finish.
- [x] **Secret-safe answers.** Answers marked secret are forwarded to the active app-server request but are redacted from persisted workflow data, audit messages, and logs.
- [x] **Stale-request safety.** Native app-server requests are tied to the live JSON-RPC request and expected turn. If that connection or turn is no longer current, the request is expired instead of being delivered to a different turn.
- [x] **Auditable intervention.** Non-secret request and delivery metadata is recorded so operators can see what required attention, what action was selected, and whether it was delivered or expired.

## User and operator flow

### When Codex asks a question

1. Codex Loop records the native request before presenting it and marks the affected branch as waiting for user input.
2. The loop shows persistent attention UI, highlights the affected Agent, and renders the structured questions (including choices and optional free-form input).
3. The user submits answers. Secret answers are never copied into workflow history.
4. The server validates that the request still belongs to the expected native thread and turn, sends the JSON-RPC response, and records the non-secret outcome.
5. The affected branch continues. Other branches and the workflow's global pause state are unchanged.

If the native app-server process disconnects, the turn finishes first, or the server reports the request as resolved elsewhere, the UI shows the request as expired/resolved. It must not replay the answer into a later turn. The user can start a new instruction instead.

### When the user intervenes proactively

The loop-level **Intervene** action makes the delivery semantics visible before submission:

- **Steer active turn** sends guidance to the selected Agent's current native turn. This is only valid while that exact turn remains active.
- **Queue follow-up** stores the instruction in Loop and starts it once after the current turn completes successfully. If that turn fails or is interrupted without recovery, the queued record is marked failed instead of being replayed into an uncertain state.
- **Share context** creates a manual constraint/question Context Block for explicitly selected recipient Agents. It does not alter an active turn unless the user separately chooses to steer it.
- **Pause workflow** is an independent run-control action. It prevents additional nodes from starting but does not implicitly interrupt active turns.

If a race occurs—for example, the turn completes while a steer is submitted—the server rejects the stale target rather than silently converting the action to a queued turn. The user can then deliberately choose the queue option.

### When Loop suspects a stall

The supervisor can raise a `suspected-stall` attention request when an active turn has produced no meaningful app-server activity for the configured interval. This is an advisory signal, not proof that the process is stuck: long-running commands and tools may legitimately be quiet. The user can inspect the Agent, steer it, queue a follow-up, pause the workflow, or allow it to continue.

A workflow deadlock is stronger: the run still has incomplete nodes, but there are no active turns, no nodes eligible to launch, and no pending native request explaining the wait. Loop surfaces this as attention rather than guessing how to repair the graph.

## Domain model

The exact TypeScript definitions live in `src/domain/types.ts`. Each workflow persists `attentionRequests` and `interventions`, while each thread records `lastActivityAt`. Conceptually the feature adds two durable record types:

### Attention request

An attention request identifies:

- the workflow run, Agent node, Loop thread, native thread, and expected native turn;
- the reason (`user-input`, `suspected-stall`, `deadlock`, `retry-exhausted`, or another observer escalation);
- structured questions and non-secret presentation metadata;
- a lifecycle such as `open`, `resolved`, or `expired`;
- creation, last-activity, resolution, and expiry timestamps.

Attention is additive state. It does not introduce a `needs-attention` workflow status.

### Intervention

An intervention records:

- its target thread or recipient Agent nodes and expected turn;
- its delivery mode (`steer`, `queue`, or `context`);
- recipient Agent IDs for shared context;
- an idempotency key and delivery lifecycle;
- non-secret audit metadata.

Queued instructions belong to Loop until started. Native user-input responses belong to the live app-server JSON-RPC request. Keeping those paths distinct prevents accidental replay or delivery to the wrong turn.

## API boundary

The browser continues to use the Express boundary; it never responds to the Codex app-server directly. The first iteration exposes these mutation routes:

- `POST /api/workflows/:id/interventions` creates an explicit steer, queued follow-up, or shared-context intervention.
- `POST /api/workflows/:id/attention/:attentionId/respond` answers an open native user-input request.

Together with workflow reads, these routes support:

- creating an intervention for a specific workflow run and target;
- answering an open attention request;
- returning current attention records with workflow state;
- rejecting stale `runId`, `requestId`, or `expectedTurnId` preconditions;
- deduplicating submissions by idempotency key.

The server persists the request or intervention transition and emits an audit event around bridge delivery. For native input, the bridge retains the live JSON-RPC request ID only for the lifetime of the app-server connection. A persisted record may explain an expired request after restart, but it cannot make that old request respondable again.

## Stall configuration

The supervisor uses these optional server environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CODEX_LOOP_STALL_THRESHOLD_MS` | `120000` (2 minutes) | Inactivity required before an active turn is classified as a suspected stall. |
| `CODEX_LOOP_SUPERVISOR_INTERVAL_MS` | `5000` (5 seconds) | How often the supervisor checks running workflows. |

For example:

```bash
CODEX_LOOP_STALL_THRESHOLD_MS=300000 \
CODEX_LOOP_SUPERVISOR_INTERVAL_MS=10000 \
npm start
```

A stall signal is based on meaningful app-server activity—turn and item lifecycle events, content deltas, tool activity, approvals, or input requests—not merely on when the workflow record was last saved.

The first iteration uses one general threshold. It does not yet distinguish an ordinary model wait from a known long-running tool; tool-aware heartbeat and timeout policies are tracked below. Any configured threshold should be comfortably longer than routine inference pauses, and operators should treat `suspected-stall` as advisory.

## Security and operational invariants

- An intervention is guidance, not permission escalation. It cannot stand in for a command/file approval.
- A user-input answer cannot resume a globally paused workflow.
- A branch waiting for input must not prevent unrelated runnable branches from progressing.
- Secret answer values must not appear in JSON persistence, audit detail, application logs, or error messages.
- Stop/reset expires pending requests and queued work associated with the stopped run.
- Duplicate submissions must be idempotent.
- Delivery must validate the workflow run and expected native turn immediately before crossing the bridge.

## Follow-up backlog

The following work is intentionally deferred. Priority describes the recommended implementation order after the first iteration.

### P1 — reliability and unattended operation

- [ ] **External notifications.** Notify through configurable desktop/webhook/email-style channels when native input, approval, deadlock, retry exhaustion, or a sustained suspected stall requires attention. Include a safe deep link and no secret content.
- [ ] **Configurable auto-resolution and escalation.** Add per-workflow policies for deadlines, default answers where explicitly safe, escalation order, and whether independent branches may continue. Defaults must remain human-in-the-loop and must never auto-approve privileged actions.
- [ ] **Tool-aware heartbeats and timeouts.** Track the active item/tool class, consume heartbeat/progress events where available, and use tool-specific soft/hard thresholds so long commands do not create noisy false stalls.
- [ ] **Persistent, reconnectable JSON-RPC requests.** Define reconnection/reconciliation with the app-server so a server restart can recover requests when the protocol supports it. Until then, retain the expire-and-reask behavior.

### P2 — governance and policy depth

- [ ] **Organization and permission policies.** Control who may answer, steer, queue, share context, pause, interrupt, or provide secret values; separate intervention privileges from approval privileges.
- [ ] **Richer Observer policies.** Let Observers classify contradictions, context gaps, retry exhaustion, and deadlocks; route them to configurable recipients; and recommend actions without taking over Agent work.
- [ ] **SSE or WebSocket live updates.** Push attention lifecycle and activity timestamps to every open client instead of depending on request/refresh cycles; include reconnect cursors and deduplication.

### P3 — collaborative operations

- [ ] **Multi-user ownership and audit.** Add request claiming, assignees, presence, handoff, conflict handling, attributable responses, and immutable audit history for teams operating the same loop.

When implementing backlog items, preserve the first-iteration invariants above: explicit delivery semantics, stale-target rejection, secret redaction, and separation between attention and workflow execution state.
