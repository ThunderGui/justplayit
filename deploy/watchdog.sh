#!/usr/bin/env bash
#
# Health watchdog for the Beelink. Run from cron every few minutes. It checks
# that the bot is not just up (web server) but actually CONNECTED to WhatsApp,
# since the two can diverge — a stuck DNS resolver once left "ok":true while
# WhatsApp was dead for hours and commands went unanswered.
#
# Behaviour, tracked across runs in a small state file:
#   - healthy                      -> reset; if it had been down, send "recovered".
#   - whatsapp false / unreachable -> count consecutive failures.
#       * below threshold          -> stay quiet (let a normal reconnect self-heal).
#       * at threshold             -> alert (urgent) + restart the container once.
#       * still down afterwards    -> remind occasionally, don't spam.
#
# Env: NTFY_TOPIC (default beelinkguihering), WEB_PORT (8090), REPO_DIR,
#      FAIL_THRESHOLD (default 2 checks), WATCHDOG_RESTART (default 1).
#
set -uo pipefail

NTFY="https://ntfy.sh/${NTFY_TOPIC:-beelinkguihering}"
PORT="${WEB_PORT:-8090}"
REPO_DIR="${REPO_DIR:-$HOME/justplayit}"
STATE="/tmp/jpi-watchdog.state"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-2}"
RESTART="${WATCHDOG_RESTART:-1}"

notify() { curl -s -m 10 -H "Title: $1" -H "Priority: ${3:-default}" -d "$2" "$NTFY" >/dev/null 2>&1 || true; }

health="$(curl -s --max-time 8 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || echo '{}')"
connected=0
printf '%s' "$health" | grep -q '"whatsapp":true' && connected=1

fails="$(cat "$STATE" 2>/dev/null || echo 0)"
case "$fails" in ''|*[!0-9]*) fails=0;; esac

if [ "$connected" = 1 ]; then
  if [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
    notify "JustPlayIt recovered ✅" "WhatsApp is connected again."
  fi
  echo 0 > "$STATE"
  exit 0
fi

fails=$((fails + 1))
echo "$fails" > "$STATE"

if [ "$fails" -lt "$FAIL_THRESHOLD" ]; then
  exit 0  # give a normal reconnect a chance before shouting
fi

if [ "$fails" -eq "$FAIL_THRESHOLD" ]; then
  notify "JustPlayIt disconnected ⚠️" "WhatsApp is down (not connected). Restarting the bot." "urgent"
  if [ "$RESTART" = 1 ]; then
    ( cd "$REPO_DIR" && { docker compose restart >/dev/null 2>&1 || docker compose up -d >/dev/null 2>&1; } ) || true
  fi
  exit 0
fi

# Still down after the restart attempt — remind every ~6th check, not every run.
if [ $(( fails % 6 )) -eq 0 ]; then
  notify "JustPlayIt still down ⚠️" "WhatsApp still disconnected after a restart — needs a look." "urgent"
fi
exit 0
