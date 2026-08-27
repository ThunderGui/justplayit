#!/bin/sh
set -e

# Home Assistant bind-mounts its own /data owned by root, so the ownership set
# at image build time does not survive. Fix it here, then drop to the unprivileged
# `node` user. Under plain `docker compose` this is a no-op beyond the chown.
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi

exec "$@"
