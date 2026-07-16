# Codex Loop

## Objective

Create a polished prototype of Codex Loop, a proposed native Codex feature for visually orchestrating multiple Codex threads.

The prototype must reproduce the current Codex interface as faithfully as possible. Match its application shell, navigation, typography, spacing, colors, borders, controls, thread presentation, loading states, and interaction patterns.

Do not redesign Codex or create a loosely inspired agent canvas. The result should look as though the Codex team added a new experimental Loop section directly to the existing product.

The intended reaction is:

> This looks like a feature that could already exist in Codex.

## Product concept

Codex Loop lets users:

* Arrange Codex threads as Agent nodes on a visual canvas
* Connect threads into an execution workflow
* Control which context each thread receives
* Supervise groups of threads with Observer regions
* Inspect every thread, tool call, retry, model change, and result
* Open any generated Agent node as a normal Codex thread
* Use a small virtual pet as a visible shared-context manager

Each Agent node represents a real or simulated persistent Codex thread with:

* Task
* Definition of done
* Model
* Connectors
* Context access
* Messages
* Tool calls
* File changes
* Execution history
* Final output

Edges determine how work and context move between threads.

Observer regions supervise groups of Agent nodes and may detect failures, contradictions, stalled work, or insufficient model capability.

The pet manages the workflow’s shared context while making every context change visible and auditable.

## Product positioning

Codex Loop is not:

* A generic automation canvas
* An n8n or LangGraph clone
* A visual programming language
* A replacement for individual Codex threads
* A separate AI-agent product

It is an orchestration layer built around existing Codex concepts:

* Threads
* Tasks
* Models
* Repositories
* Tools and connectors
* Execution logs
* File changes
* Reviews

Every node must remain a first-class Codex thread that can be opened, inspected, continued, stopped, or audited independently.

## Application shell

Replicate the current Codex application shell as closely as practical.

The left navigation should contain the existing Codex sections, plus:

* Threads
* Local
* Remote
* Loop
* Settings

Place Loop directly below Remote.

Only Loop requires complete functionality. Other sections may use convincing static or mocked screens, but they must preserve the visual illusion of navigating the real Codex interface.

Reuse Codex-style components throughout the prototype. Agent nodes should resemble compact Codex thread cards, not generic flowchart boxes.

## Loop landing screen

Selecting Loop should open a native-looking landing screen containing:

* A short explanation of Codex Loop
* Recent workflows
* Saved workflows
* Workflow templates
* A “Create Loop” action
* A text input for generating a workflow from a task

Suggested introduction:

> Coordinate multiple Codex threads in a single workflow. Assign tasks, share context, supervise execution, and inspect every result.

Include templates such as:

* Investigate and fix a failing CI pipeline
* Implement and review a feature
* Refactor a subsystem safely
* Audit a repository
* Resolve pull-request feedback
* Plan, implement, test, and document a change

## Loop workspace

### Left sidebar

Keep the normal Codex sidebar visible.

Show:

* Workflow name
* Threads created by the workflow
* Node and execution status
* Previous workflow runs
* Saved Loop workflows
* Normal manually created threads

Every Agent node must create a corresponding thread entry.

Loop-created threads should have a subtle indicator for:

* Parent workflow
* Node name
* Current status

### Main canvas

The central area becomes a visual workflow canvas containing:

* Agent nodes
* Edges
* Observer regions
* Context blocks
* Context-access indicators
* Execution status
* Approval checkpoints

Support canvas pan and zoom where appropriate.

Required interactions:

* Double-click empty canvas space to create an Agent node
* Drag from one node to another to create an edge
* Drag across empty canvas space to create an Observer region
* Select any object to edit it in the inspector
* Move and resize nodes and Observer regions
* Open an Agent node as a normal Codex thread
* Start, pause, stop, and reset a workflow
* Save and reopen workflows

Avoid interaction conflicts between canvas panning, node dragging, edge creation, and Observer creation.

### Right inspector

Selecting an object opens a Codex-style inspector.

#### Agent settings

* Name
* Model
* Task
* Definition of done
* Connectors
* Context permissions
* Retry behavior
* Status

#### Edge settings

* Source node
* Target node
* Wait period or trigger condition
* Data or context passed
* Number of retries
* Failure behavior
* Whether user approval is required

#### Observer settings

* Name
* Instructions
* Covered nodes
* Intervention conditions
* Retry policy
* Model-upgrade policy
* Escalation behavior

#### Workflow settings

* Workflow name
* Main task
* Default model
* Execution mode
* Shared connectors
* Approval policy
* Maximum retries

### Bottom activity panel

Add a collapsible activity panel styled like Codex execution output.

Display timestamped events for:

* Thread activity
* Tool calls
* Context updates
* Agent handoffs
* Retries
* Errors
* Model changes
* Observer interventions
* User approvals
* Workflow completion

Selecting an event should highlight or open the related node when practical.

## Context system

Represent reusable shared information as visible Context Blocks.

Examples:

* Repository findings
* Acceptance criteria
* Changed files
* Test results
* Architecture decisions
* Unresolved questions
* Implementation constraints

Each block should show:

* Title
* Summary
* Source thread
* Creation time
* Agents that can access it
* Whether it was manually or automatically created

Use small node-shaped stickers or badges to show which Agent nodes can access each block.

Users must be able to inspect and edit context permissions.

The UI should make it obvious that agents do not automatically receive every message or the entire workflow history.

## Shared-context management

Integrate shared-context management into the existing Activity, Contexts, and inspector surfaces. Do not introduce a separate mascot or persistent header control.

The context system should:

* Summarize completed work
* Track unresolved questions
* Extract reusable findings
* Create Context Blocks
* Distribute context to approved agents
* Detect contradictions
* Warn when shared context is becoming too large
* Explain which agents know what
* Explain what is currently happening

Example activity messages:

> The investigator found a likely race condition. I shared the finding with the implementation and review threads.

> The test thread cannot access the implementation discussion. It only received the changed files and acceptance criteria.

> Two agents produced conflicting explanations. The Observer is reviewing them.

The context system must not hide autonomous decisions. Every context creation, update, or permission change must appear in the activity log, and context size and recipient access should be visible in the Contexts pane.

## Thread behavior

Opening an Agent node should switch to a convincing standard Codex thread view containing:

* Assigned task
* Definition of done
* Selected model
* Available connectors
* Received shared context
* Messages
* Tool calls
* File changes
* Execution attempts
* Final output

The user should be able to:

* Add instructions
* Answer a question
* Stop execution
* Continue manually
* Review changes
* Return to the Loop canvas

Changes made inside the thread should update the corresponding canvas node.

## Execution simulation

Implement a convincing deterministic or state-machine-based workflow simulation.

The primary demo should progress through:

1. User enters a repository-level task
2. Codex generates a proposed workflow
3. Investigation agents run in parallel
4. The pet extracts findings into Context Blocks
5. Context passes to implementation agents
6. One implementation attempt fails
7. An Observer detects the failure
8. The node retries using a stronger model
9. Implementation succeeds
10. A test thread verifies the result
11. A review thread completes the workflow
12. The user opens generated threads to audit their work

Animate:

* Queued, running, waiting, failed, retrying, blocked, and completed states
* Context movement
* Edge activation
* Observer intervention
* Retry count
* Model upgrade
* Completion progress

The simulated execution should be repeatable and polished enough for a live hackathon demonstration.

## Backend and persistence

Provide a backend API and persistent local storage for:

* Workflows
* Nodes
* Edges
* Observer regions
* Context Blocks
* Thread records
* Execution events
* Saved canvas positions
* Workflow runs

Use the project’s existing stack where available. Otherwise choose a simple, maintainable architecture suitable for a hackathon.

Separate the workflow domain model from the rendering layer.

Where technically possible, add an adapter for creating or associating actual Codex threads. If direct Codex integration is unavailable, implement a clean mocked adapter with the same conceptual interface so it can later be replaced.

Do not hard-code the entire demonstration into individual UI components. Model the execution as workflow state and events.

## Mocked capabilities

The following may be simulated:

* Codex authentication
* Real model execution
* Real repository modifications
* Real CLI execution
* Computer use
* Connector authentication
* Secure credential storage
* Multi-user collaboration
* Billing and usage metering

Mocked behavior must still look coherent and produce a complete audit trail.

## Quality requirements

* Faithful reproduction of the current Codex UI
* Responsive layout
* Smooth interactions and transitions
* Clear hover, selected, disabled, loading, error, and empty states
* Strong TypeScript typing if TypeScript is used
* Accessible controls and keyboard behavior
* Persistent workflow state
* Clean component boundaries
* No obvious placeholder styling
* No generic dashboard aesthetic
* No excessive gradients, oversized cards, or unrelated visual patterns
* No broken interactions or dead-end demo states

Use screenshots or existing Codex UI references available in the repository as the visual source of truth. Prefer fidelity over creative reinterpretation.

## Implementation process

Use subagents throughout the task.

First, ask planning subagents to independently analyze:

* Existing repository and stack
* Current Codex interface structure
* Component architecture
* Workflow data model
* Canvas interaction design
* Execution simulation
* Backend and persistence
* Testing and verification

Consolidate their findings into one implementation plan.

Then delegate implementation to focused subagents, for example:

* Codex shell and navigation
* Loop landing screen
* Canvas and interactions
* Inspectors and settings
* Context system and pet
* Execution simulation
* Thread and audit views
* Persistence and API
* Visual polish and testing

Ensure subagents work against compatible interfaces and data models. Review and integrate their work rather than leaving disconnected implementations.

After implementation:

1. Run the application.
2. Test the complete demo flow.
3. Check browser console and server errors.
4. Verify saving and reopening workflows.
5. Verify node, edge, and Observer interactions.
6. Verify Agent nodes appear as normal threads.
7. Verify execution logs and context permissions.
8. Fix visual inconsistencies and broken states.
9. Leave the repository in a runnable, documented state.

## Definition of done

The project is complete when a presenter can:

1. Open a faithful Codex replica.
2. Select Loop below Remote.
3. Create or generate a workflow.
4. Edit Agent nodes and their settings.
5. Connect nodes with edges.
6. Draw an Observer region.
7. Start the workflow.
8. Watch parallel execution and context sharing.
9. See a failure, Observer intervention, retry, and model upgrade.
10. Open an Agent as a normal Codex thread.
11. Return to the canvas.
12. Review the final result and complete audit trail.
13. Save, close, and reopen the workflow successfully.

The final prototype should communicate a technically plausible proposal for how native multi-thread orchestration could work inside Codex.
