# Codex Loop

A local Codex workflow-orchestration surface. Loop adds a visual canvas for coordinating persistent native Codex threads, explicit context handoffs, Observer regions, and execution history inside a faithful Codex-style shell.

## Run locally

```bash
npm install
codex login status
npm run dev
```

Open `http://127.0.0.1:5173`. The API runs on `http://127.0.0.1:4317`, launches `codex app-server` lazily on the first real run, and persists workflows plus native Codex thread IDs to `data/codex-loop.json`.

Prerequisites:

- A current Codex CLI available as `codex`.
- An authenticated local Codex session (`codex login status`).
- A repository working directory. By default agents work in the directory where the server starts.

Optional runtime overrides:

```bash
CODEX_BINARY=/absolute/path/to/codex
CODEX_LOOP_WORKSPACE=/absolute/path/to/repository
CODEX_LOOP_MODEL=gpt-5.4
CODEX_LOOP_SANDBOX=workspace-write # read-only | workspace-write | danger-full-access
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
docker compose pull
docker compose up -d
./scripts/check-latest-release.sh
```

The LAN route is `http://codex-loop.home`; release metadata is available at
`http://codex-loop.home/api/version`. Caddy, DNS, and landing-page configuration
live in the sibling `home-server-setup` repository.

The default deployment mounts `/Users/mauri-home/.codex` and
`/Users/mauri-home/Documents/projects`. Adjust `.env` on a different host. This
is a powerful control surface that can launch Codex against the mounted
workspace, so keep it on a trusted LAN and do not expose it to the public
internet without authentication and TLS.

## Documentation

- [Attention and intervention](docs/attention-and-intervention.md) documents native user-input handling, proactive guardrails, operator semantics, security invariants, and the prioritized follow-up backlog.

## Run modes

The split **Run** control supports three persisted modes:

- **Single run** starts the loop immediately through the native Codex bridge.
- **Scheduled run** starts automatically on selected weekdays and times in the configured IANA time zone. The server checks due schedules every 15 seconds and prevents duplicate starts within the same scheduled minute.
- **Webhook run** exposes a tokenized `GET`/`POST` endpoint at `/api/triggers/:token`. A JSON POST body or GET query values are merged with configured defaults and made available to every Agent in that run.

In development, copy the trigger URL shown in the dialog (normally port `5173`, proxied to the API). With `npm start`, the UI and trigger endpoint share the API origin (normally port `4317`). To accept calls beyond the local machine, start the server with an appropriate `HOST` value and network controls.

## Demo flow

1. Select **Loop** below **Remote**.
2. Enter a repository-level task and generate a workflow, or open **Repository change delivery**.
3. Select Agent nodes, edges, Context Blocks, and the Observer region to edit them in the inspector.
4. Add Agents, connect them with handle dragging or the accessible **Connect** control, and draw an Observer region with the **Observer** tool.
5. Use the split Run control to start once, schedule recurring starts, or activate a webhook trigger, then watch two investigators run in parallel.
6. Follow context creation and access grants in the Activity and Contexts panes.
7. Watch real assistant messages, commands, MCP calls, approvals, file changes, failures, and retries stream into the workflow.
8. Open **Implement the change** to audit its native Codex thread ID, received context, attempts, tool calls, file changes, and final output. The persisted thread is also available to other Codex clients using the same `CODEX_HOME`.
9. Return to Loop, inspect the activity/audit view, save, reload, and reopen the workflow.

Loop schedules nodes whose incoming dependencies have completed. Independent root nodes start in parallel. Pause prevents new nodes from starting, stop interrupts active Codex turns, reset archives the native threads, and run-again resumes each node's persistent thread where possible.

## Architecture

- React, TypeScript, Vite, and `@xyflow/react` for the application and canvas.
- Express API with serialized atomic JSON-file persistence and a server-side Codex bridge.
- Shared workflow domain types for Agents, edges, Observers, context, threads, runs, and immutable audit events.
- `codex app-server` over JSONL/stdin/stdout for native thread creation, resumption, turns, steering, interruption, approval responses, and streamed events.
- Persistent mappings from Loop thread records to native Codex thread and active turn IDs.
- Vitest coverage for API persistence, graph scheduling, native event projection, and approval routing through a fake app-server process.

## Bridge boundary

The browser never launches Codex directly and never receives Codex credentials. Express owns the authenticated app-server subprocess and exposes narrow workflow/thread endpoints to the UI. Each Agent node is mapped to a persisted native Codex thread; `turn/start`, `turn/steer`, and `turn/interrupt` drive real work, while app-server notifications update Loop's messages, tool calls, file changes, attempts, statuses, and audit events.

The deterministic simulator remains in `src/domain/simulation.ts` as a testable reference scenario, but the application Start/Stop/Continue controls now use the native bridge.

## License

Codex Loop is open-source software licensed under the [MIT License](LICENSE).
