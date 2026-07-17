#!/bin/sh
set -eu

app_url="${CODEX_LOOP_URL:-http://codex-loop.home}"
repo="${CODEX_LOOP_REPOSITORY:-mauri3112/codex-loop}"

running_json="$(curl --fail --silent --show-error "${app_url}/api/version")"
latest_json="$(curl --fail --silent --show-error "https://api.github.com/repos/${repo}/releases/latest")"

running="$(printf '%s' "$running_json" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
revision="$(printf '%s' "$running_json" | sed -n 's/.*"revision":"\([^"]*\)".*/\1/p')"
latest="$(printf '%s' "$latest_json" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')"

if [ -z "$running" ] || [ -z "$latest" ]; then
  echo "Could not read release versions." >&2
  exit 2
fi

echo "Running: ${running} (${revision})"
echo "Latest:  ${latest}"

if [ "$running" != "$latest" ]; then
  echo "Codex Loop is waiting for the automatic updater." >&2
  exit 1
fi

echo "Codex Loop is running the latest GitHub release."

