#!/usr/bin/env bash
# Fresh source deployment with commit metadata and the host-side web updater.
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run this installer as root.' >&2; exit 1; }
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
[[ -f .env ]] || { echo 'Create .env from .env.example before installing.' >&2; exit 1; }
command -v docker >/dev/null
docker compose version >/dev/null
command -v python3 >/dev/null || { echo 'Install python3 first.' >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo 'The panel updater requires a systemd control server (for example Debian). Alpine nodes are supported separately.' >&2; exit 1; }
commit="$(git rev-parse HEAD)"
[[ "$commit" =~ ^[a-f0-9]{40}$ ]] || exit 1
verify_source() {
  [[ "$(git rev-parse HEAD)" = "$commit" && -z "$(git status --porcelain --untracked-files=normal)" ]] || {
    echo 'A clean, unchanged source checkout is required to record the running commit accurately.' >&2
    exit 1
  }
}
verify_source
docker compose build --build-arg "INCUDAL_COMMIT=$commit" app
verify_source
docker compose up -d db redis
python3 scripts/panel-updater.py install --project-dir "$project_dir"
docker compose up -d --no-build app
echo 'Panel started. Configure the HTTPS reverse proxy and onboarding gateway as described in README.md.'
