#!/usr/bin/env bash
#
# Deploys Just Play It to an always-on Debian host over SSH.
#
#   ./deploy/deploy.sh thundergui@10.0.0.64
#
# Assumes key-based SSH (run `ssh-copy-id <user>@<host>` once first).
#
# Safe to re-run: it syncs the source, rebuilds, and restarts. Runtime data on
# the target is never overwritten once it exists — see MIGRATE_DATA below.
set -euo pipefail

TARGET="${1:-}"
REMOTE_DIR="${REMOTE_DIR:-/home/${TARGET%@*}/justplayit}"
# Set MIGRATE_DATA=1 to copy this machine's data/ (database + WhatsApp session)
# to the target. Only meaningful on the very first deploy.
MIGRATE_DATA="${MIGRATE_DATA:-0}"

if [[ -z "$TARGET" ]]; then
  echo "usage: $0 user@host" >&2
  exit 1
fi

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Checking connectivity to $TARGET"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" 'echo connected; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; uname -m'

say "Ensuring Docker is installed and starts at boot"
ssh "$TARGET" 'bash -se' <<'REMOTE'
set -euo pipefail
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found — installing from get.docker.com"
  curl -fsSL https://get.docker.com | sudo sh
fi
# The compose plugin is separate on some Debian builds.
if ! docker compose version >/dev/null 2>&1; then
  sudo apt-get update -qq && sudo apt-get install -y docker-compose-plugin
fi
# This is what actually brings the container back after a power cut: Docker
# starts at boot, then restores every container with a restart policy.
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER" || true
docker --version && docker compose version
REMOTE

say "Syncing source to $REMOTE_DIR"
ssh "$TARGET" "mkdir -p '$REMOTE_DIR'"
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'data/' \
  --exclude 'tmp-*/' \
  --exclude '.env' \
  "$SRC/" "$TARGET:$REMOTE_DIR/"

if [[ "$MIGRATE_DATA" == "1" ]]; then
  say "Migrating runtime data (database + WhatsApp session)"
  # Refuse to clobber an existing installation's state.
  if ssh "$TARGET" "[ -f '$REMOTE_DIR/data/justplayit.db' ]"; then
    echo "Target already has a database. Refusing to overwrite it." >&2
    echo "Move it aside on the target first if you really mean to replace it." >&2
    exit 1
  fi
  # The WhatsApp session may only be live in one place at a time, so the local
  # bot must be stopped before this runs. See DEPLOYMENT.md.
  rsync -az "$SRC/data/" "$TARGET:$REMOTE_DIR/data/"
fi

say "Building and starting"
ssh "$TARGET" "cd '$REMOTE_DIR' && docker compose up -d --build"

say "Waiting for health"
ssh "$TARGET" 'bash -se' <<REMOTE
set -euo pipefail
cd '$REMOTE_DIR'
port="\$(grep -E '^WEB_PORT=' .env | cut -d= -f2 | tr -d '[:space:]')"
port="\${port:-8080}"
for i in \$(seq 1 30); do
  if curl -fsS "http://127.0.0.1:\$port/healthz" 2>/dev/null; then echo; break; fi
  sleep 2
done
echo
docker compose ps
REMOTE

say "Done. Console: http://${TARGET#*@}:\$(grep -E '^WEB_PORT=' "$SRC/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' || echo 8080)"
