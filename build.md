# Build Codex Loop locally with Docker

This is the minimal build path for an agent or developer who needs a local production-style Codex Loop container. It does not use the repository’s release tags, GHCR image, Watchtower updater, Caddy route, external `home-server-proxy` network, or home-server DNS.

## Prerequisites

- Docker Engine or Docker Desktop is running.
- The current directory is the Codex Loop repository.
- The host has an authenticated Codex home at `${HOME}/.codex`. Confirm it with `codex login status` before starting the container.

## Build the image

```bash
docker build -t codex-loop:local .
```

The Dockerfile builds the React application, installs the pinned Codex CLI in the runtime image, and starts the Express server on port `4317`.

## Run one local container

Create the persistent data directory, then run the image:

```bash
mkdir -p data

docker run --detach \
  --name codex-loop-local \
  --publish 4317:4317 \
  --env HOST=0.0.0.0 \
  --env PORT=4317 \
  --env CODEX_HOME=/root/.codex \
  --env CODEX_LOOP_WORKSPACE=/workspace/codex_loop \
  --env CODEX_LOOP_SANDBOX=workspace-write \
  --env CODEX_LOOP_DESIGNER_MODEL=gpt-5.6-sol \
  --mount type=bind,src="$(pwd)/data",dst=/app/data \
  --mount type=bind,src="${HOME}/.codex",dst=/root/.codex \
  --mount type=bind,src="$(pwd)",dst=/workspace/codex_loop \
  codex-loop:local
```

The mounts keep workflow state on the host, reuse the host’s Codex authentication, and make this repository available to workers. To let Loops work across several repositories, replace the final mount source with the absolute path to the desired projects directory and set `CODEX_LOOP_WORKSPACE` to the corresponding container path.

Do not add secrets to the Dockerfile or image. To protect the MCP endpoint, add `--env CODEX_LOOP_MCP_TOKEN=replace-with-a-long-random-value` when starting the container.

## Verify the container

```bash
curl --fail http://127.0.0.1:4317/api/health
curl --fail http://127.0.0.1:4317/api/version
docker logs codex-loop-local
```

Open `http://127.0.0.1:4317`. A local image reports `development`, `unknown`, and `unknown` version metadata unless build arguments are supplied; that is expected for this simple build.

## Rebuild after source changes

```bash
docker stop codex-loop-local
docker rm codex-loop-local
docker build -t codex-loop:local .
```

Then repeat the `docker run` command above. The bind-mounted `data/` directory is not removed when the container is replaced.

## Stop and remove the container

```bash
docker stop codex-loop-local
docker rm codex-loop-local
```

Keep `data/` if existing Loop definitions and run history should survive the next container.
