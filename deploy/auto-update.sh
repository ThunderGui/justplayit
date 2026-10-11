#!/usr/bin/env bash
#
# Scheduled auto-redeploy for the Beelink.
#
# Checks GitHub for new commits on main. If there are any, it takes a full
# backup, pulls, rebuilds, and health-checks the container — rolling back to the
# previous commit if the build or health check fails. Either way it posts to
# ntfy. Safe to run from cron (it no-ops when already up to date and won't
# overlap itself).
#
# Requires: git, docker compose, curl, flock, tar. Reads these env vars:
#   REPO_DIR    (default: $HOME/justplayit)
#   NTFY_TOPIC  (default: beelinkguihering)   ntfy.sh topic for notifications
#   WEB_PORT    (default: 8090)               health-check port
#
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/justplayit}"
NTFY_URL="https://ntfy.sh/${NTFY_TOPIC:-beelinkguihering}"
HEALTH_URL="http://127.0.0.1:${WEB_PORT:-8090}/healthz"
BACKUP_DIR="${REPO_DIR}/data/backups/auto"
KEEP_BACKUPS=7

notify() { # title, message, [priority]
  curl -s -m 10 -H "Title: $1" -H "Priority: ${3:-default}" -d "$2" "$NTFY_URL" >/dev/null 2>&1 || true
}

# Never let two runs overlap (a long rebuild + the next cron tick).
exec 9>"/tmp/jpi-autoupdate.lock"
flock -n 9 || { echo "another run in progress, skipping"; exit 0; }

cd "$REPO_DIR"
git fetch --quiet origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "$(date -u +%FT%TZ) up to date (${LOCAL:0:7})"
  exit 0
fi
echo "$(date -u +%FT%TZ) update ${LOCAL:0:7} -> ${REMOTE:0:7}"

# --- full backup: consistent DB snapshot + session + media + .env ---
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%F-%H%M%S)
SNAP="autobackup-${STAMP}.db"
docker compose exec -T justplayit node -e \
  "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/justplayit.db',{readOnly:true});d.exec(\"VACUUM INTO '/data/${SNAP}'\");d.close();" \
  || echo "warn: DB snapshot failed; backing up live files instead"
tar -czf "${BACKUP_DIR}/backup-${STAMP}.tgz" -C "$REPO_DIR" \
  $( [ -f "data/${SNAP}" ] && echo "data/${SNAP}" || echo "data/justplayit.db" ) \
  data/wa-auth .env \
  $( [ -d "data/media" ] && echo "data/media" ) 2>/dev/null || echo "warn: backup tar had issues"
rm -f "data/${SNAP}" 2>/dev/null || true
# keep only the most recent N backups
ls -1t "${BACKUP_DIR}"/backup-*.tgz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
echo "backup: ${BACKUP_DIR}/backup-${STAMP}.tgz"

# --- deploy ---
git reset --hard origin/main
if docker compose up -d --build; then
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
      notify "JustPlayIt updated ✅" "Deployed ${REMOTE:0:7}. Health OK. Backup: backup-${STAMP}.tgz"
      echo "deployed ok (${REMOTE:0:7})"
      exit 0
    fi
    sleep 4
  done
fi

# --- rollback on failure ---
echo "deploy FAILED; rolling back to ${LOCAL:0:7}"
git reset --hard "$LOCAL"
docker compose up -d --build || true
notify "JustPlayIt auto-update FAILED ⚠️" \
  "Build/health failed for ${REMOTE:0:7}; rolled back to ${LOCAL:0:7}. Check the server." "urgent"
exit 1
