# AGENTS.md

## Release and deployment

- Every push to `main` is a release event. Keep `.github/workflows/release.yml`,
  `Dockerfile`, `docker-compose.yml`, and the deployment section in `README.md`
  aligned.
- A successful release publishes immutable `v1.0.<run-number>` and moving
  `latest` images to GHCR, then creates the matching GitHub release.
- The local Compose deployment joins the external `home-server-proxy` network;
  Caddy and LAN DNS are owned by the sibling `home-server-setup` repository.
- Runtime state under `data/` and the mounted Codex home/workspace must survive
  image replacement. Never bake credentials or workflow data into an image.
- Validate changes with `npm test`, `npm run build`, `docker build`, and
  `docker compose config`. For deployment changes, also verify `/api/health`,
  `/api/version`, and `scripts/check-latest-release.sh` against the live route.

## Home-server cross-reference

- Application container ownership: this repository.
- Caddy route, landing page, DNS guidance, and operator documentation:
  `/Users/mauri-home/Documents/projects/home-server-setup`.
- Update the sibling repository's `README.md` and `SETUP.md` whenever the route,
  container name, network, port, or deployment procedure changes.

## Safety

- Codex Loop can launch native Codex agents against the mounted workspace.
  Expose it only on a trusted LAN or private network; do not forward it from the
  public internet without adding authentication and TLS.
- Do not commit `.env`, Codex credentials, workflow state, tokens, or secrets.

