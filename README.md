# Codex Loop

A local, chat-first control plane for reusable Codex workflows. Describe the outcome to the 5.6-Sol Loop Designer; it creates and revises a versioned execution graph, validates it, discovers available skills/apps/MCP/CLI capabilities, and leaves full visual editing behind an explicit **Edit visually** control.

## Run locally

```bash
npm install
codex login status
npm run dev
```

Open `http://127.0.0.1:5173`. The API runs on `http://127.0.0.1:4317`, launches `codex app-server` lazily for the Designer or a real run, and persists versioned Loop definitions, native Codex thread IDs, and immutable per-run execution results to `data/codex-loop.json`.

Prerequisites:

- A current Codex CLI available as `codex`.
- An authenticated local Codex session (`codex login status`).
- A repository working directory. By default agents work in the directory where the server starts.

Optional runtime overrides:

```bash
CODEX_BINARY=/absolute/path/to/codex
CODEX_LOOP_WORKSPACE=/absolute/path/to/repository
CODEX_LOOP_MODEL=gpt-5.4
CODEX_LOOP_DESIGNER_MODEL=gpt-5.6-sol
CODEX_LOOP_SANDBOX=workspace-write # read-only | workspace-write | danger-full-access
CODEX_LOOP_PUBLIC_URL=http://127.0.0.1:4317
CODEX_LOOP_MCP_TOKEN=a-long-random-value
```

Production build and verification:

```bash
npm run build
npm test
npm start
```

## Always-current home-server deployment

Every successful push to `main` runs tests and a production build, publishes a
multi-architecture image to GitHub Container Registry, and creates a matching
GitHub release named `v1.0.<workflow-run-number>`. The `latest` image always
points to that release.

This Mac runs the published image through Docker Compose. The scoped updater
checks GHCR every five minutes and recreates only the Codex Loop container when
a new healthy image is available. Workflow data, the Codex home, and the mounted
projects workspace remain on the host across updates.

```bash
cp .env.example .env
# Set CODEX_LOOP_MCP_TOKEN to a long random value before using MCP over the LAN.
docker compose pull
docker compose up -d
./scripts/check-latest-release.sh
```

The LAN route is `http://codex-loop.home`; release metadata is available at
`http://codex-loop.home/api/version`, and the authenticated Streamable HTTP MCP
endpoint is `http://codex-loop.home/mcp`. Caddy, DNS, and landing-page configuration
live in the sibling `home-server-setup` repository.

The default deployment mounts `/Users/mauri-home/.codex` and
`/Users/mauri-home/Documents/projects`. Adjust `.env` on a different host. This
is a powerful control surface that can launch Codex against the mounted
workspace, so keep it on a trusted LAN and do not expose it to the public
internet without authentication and TLS.

## Documentation

- [Claude Code workflow parity](docs/claude-code-workflow-parity.md) explains what Loop borrows from Claude Code, the higher-level abstraction boundary, and the remaining parity gaps.
- [Attention and intervention](docs/attention-and-intervention.md) documents native user-input handling, proactive guardrails, operator semantics, security invariants, and the prioritized follow-up backlog.

## Create Loops from a Codex task

The repository includes a validated plugin in `plugins/codex-loop` with two skills:

- `design-loop` creates, clarifies, revises, validates, and explicitly publishes Loop definitions.
- `operate-loop` inspects runs and performs only explicitly requested start, pause, resume, stop, or gate actions.

The plugin connects to the `/mcp` endpoint. Its default URL targets the local development server at `127.0.0.1:4317`; for the home-server deployment, change the plugin MCP URL to `http://codex-loop.home/mcp`. Export the same `CODEX_LOOP_MCP_TOKEN` value in the Codex host environment and the Compose `.env`. Secret values never enter a Loop definition: the Designer records named secret requirements and reuses already-authenticated capabilities by reference.

Once installed through a local Codex plugin marketplace, start a new Codex task and ask: “Use `$design-loop` to create a Loop that …”. The skill creates a draft, delegates graph compilation to the persistent Designer, validates it, and returns a deep link. It does not publish or start the Loop unless explicitly requested.

## Run modes

The split run control keeps one-time execution separate from the configured automatic trigger:

- **Run once** is always available for a saved Loop and opens a dialog for an optional one-time prompt and project folder. It does not replace a configured schedule or webhook.
- **Scheduled run** starts automatically on selected weekdays and times in the configured IANA time zone. The server checks due schedules every 15 seconds and prevents duplicate starts within the same scheduled minute.
- **Webhook run** exposes a tokenized `GET`/`POST` endpoint at `/api/triggers/:token`. A JSON POST body or GET query values are merged with configured defaults and made available to every Agent in that run.

The Loop sidebar marks each Loop with a color for its configured trigger type. Expanding the active Loop shows its threads and execution history; every new run freezes thread messages, tool calls, file changes, final outputs, and audit events so later runs cannot overwrite earlier evidence.

In development, copy the trigger URL shown in the dialog (normally port `5173`, proxied to the API). With `npm start`, the UI and trigger endpoint share the API origin (normally port `4317`). To accept calls beyond the local machine, start the server with an appropriate `HOST` value and network controls.

## Demo flow

1. Select **Loop**, describe the desired outcome, and let the Designer propose the initial graph.
2. Continue in chat to add constraints, change integrations, or refine verification. Inspect assumptions, questions, setup requirements, and validation beside the graph preview.
3. Select **Edit visually** only when you want direct node, edge, Context Block, or Observer controls.
4. Save the validated revision explicitly, then run it once, schedule recurring starts, or activate a webhook trigger.
5. Follow context creation and access grants in the Activity and Contexts panes.
6. Watch real assistant messages, commands, MCP calls, approvals, file changes, failures, and retries stream into the workflow.
7. Open **Implement the change** to audit its native Codex thread ID, received context, attempts, tool calls, file changes, and final output. The persisted thread is also available to other Codex clients using the same `CODEX_HOME`.
8. Return to Loop, open a prior run from the sidebar to inspect its frozen results, then save, reload, and reopen the workflow.

Loop schedules nodes whose incoming dependencies have completed. Independent root nodes start in parallel. Pause prevents new nodes from starting, stop interrupts active Codex turns, and reset archives the native threads without deleting their stored execution results. Starting another run creates fresh native threads so outputs remain isolated by execution.

## Architecture

- React, TypeScript, Vite, and `@xyflow/react` for the application and canvas.
- Express API with serialized atomic JSON-file persistence and a server-side Codex bridge.
- Versioned workflow definitions and mutation history with optimistic revision locking, validation, undo-as-a-new-revision, draft/published lifecycle, and immutable audit events.
- A persistent read-only 5.6-Sol Designer thread that emits schema-constrained proposals compiled into graph revisions.
- An authenticated MCP control surface and packaged `design-loop` / `operate-loop` skills for creation from any Codex task.
- Bounded agent, map, join, condition, loop, verify, gate, and subworkflow execution semantics with budgets and checkpoints.
- `codex app-server` over JSONL/stdin/stdout for native thread creation, resumption, turns, steering, interruption, approval responses, and streamed events.
- Persistent mappings from Loop thread records to native Codex thread and active turn IDs.
- Vitest coverage for API persistence, graph scheduling, native event projection, and approval routing through a fake app-server process.

## Bridge boundary

The browser never launches Codex directly and never receives Codex credentials. Express owns the authenticated app-server subprocess and exposes narrow workflow/thread endpoints to the UI. Each Agent node is mapped to a persisted native Codex thread; `turn/start`, `turn/steer`, and `turn/interrupt` drive real work, while app-server notifications update Loop's messages, tool calls, file changes, attempts, statuses, and audit events.

The deterministic simulator remains in `src/domain/simulation.ts` as a testable reference scenario, but the application Start/Stop/Continue controls now use the native bridge.

## License

Codex Loop is open-source software licensed under the [MIT License](LICENSE).
