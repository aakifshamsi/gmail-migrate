#!/usr/bin/env bash
# notify.sh — ntfy.sh HTTP notification helper
#
# Usage:
#   bash scripts/notify.sh <event> <title> <body> [priority]
#
# Required env:
#   NTFY_TOPIC   — ntfy.sh topic name (treated as secret; keep unguessable)
#
# Optional env:
#   NTFY_BASE_URL         — default: https://ntfy.sh
#   NTFY_MODE             — all | milestones | errors-only | completion-only
#   NTFY_MARKDOWN         — true | false (default: false)
#   DEST_ID               — used for per-destination topic routing
#   GITHUB_RUN_NUMBER     — included in notifications if set
#   GITHUB_SERVER_URL     — for log URL in error notifications
#   GITHUB_REPOSITORY     — for log URL in error notifications
#   GITHUB_RUN_ID         — for log URL in error notifications

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Args
# ─────────────────────────────────────────────────────────────────────────────
EVENT="${1:-}"          # start | milestone | complete | error | dry_run | overquota | cleanup
TITLE="${2:-Notification}"
BODY="${3:-}"
PRIORITY="${4:-default}"

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────
NTFY_TOPIC="${NTFY_TOPIC:-}"
NTFY_BASE_URL="${NTFY_BASE_URL:-https://ntfy.sh}"
NTFY_MODE="${NTFY_MODE:-all}"
NTFY_MARKDOWN="${NTFY_MARKDOWN:-false}"
DEST_ID="${DEST_ID:-}"

# Monetag referral link — included in all notifications

# ─────────────────────────────────────────────────────────────────────────────
# Guards
# ─────────────────────────────────────────────────────────────────────────────
if [ -z "$NTFY_TOPIC" ]; then
  echo "[notify] NTFY_TOPIC not set — skipping notification." >&2
  exit 0
fi

if [ -z "$EVENT" ]; then
  echo "[notify] No event specified — skipping." >&2
  exit 0
fi

# Mode-based filtering
should_send() {
  case "$NTFY_MODE" in
    all) return 0 ;;
    errors-only)
      [[ "$EVENT" == "error" || "$EVENT" == "overquota" ]] && return 0 || return 1
      ;;
    completion-only)
      [[ "$EVENT" == "complete" || "$EVENT" == "error" || "$EVENT" == "cleanup" ]] && return 0 || return 1
      ;;
    milestones)
      [[ "$EVENT" != "dry_run" ]] && return 0 || return 1
      ;;
    *) return 0 ;;
  esac
}

if ! should_send; then
  echo "[notify] Event '${EVENT}' suppressed by NTFY_MODE=${NTFY_MODE}." >&2
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Topic routing
# ─────────────────────────────────────────────────────────────────────────────
PRIMARY_TOPIC="${NTFY_BASE_URL}/${NTFY_TOPIC}"

PER_DEST_TOPIC=""
if [ -n "$DEST_ID" ]; then
  PER_DEST_TOPIC="${NTFY_BASE_URL}/${NTFY_TOPIC}-${DEST_ID}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Build tags from event type
# ─────────────────────────────────────────────────────────────────────────────
build_tags() {
  local base="email,migration"
  case "$EVENT" in
    start)      echo "${base},outbox" ;;
    milestone)  echo "${base},chart_with_upwards_trend" ;;
    complete)   echo "${base},white_check_mark" ;;
    error)      echo "${base},x,warning" ;;
    dry_run)    echo "${base},mag" ;;
    overquota)  echo "${base},warning,stopwatch" ;;
    cleanup)    echo "${base},broom" ;;
    *)          echo "${base}" ;;
  esac
  [ -n "$DEST_ID" ] && echo ",${DEST_ID}"
}

TAGS=$(build_tags | tr -d '\n')

# ─────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
FULL_BODY="$BODY"

FULL_BODY="${FULL_BODY}


# Append log URL for error events
if [[ "$EVENT" == "error" || "$EVENT" == "overquota" ]]; then
  if [ -n "${GITHUB_SERVER_URL:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ]; then
    LOG_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
    FULL_BODY="${FULL_BODY}
 Logs: ${LOG_URL}"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Send notification
# ─────────────────────────────────────────────────────────────────────────────
send_notification() {
  local url="$1"

  local headers=(
    -H "Title: ${TITLE}"
    -H "Priority: ${PRIORITY}"
    -H "Tags: ${TAGS}"
  )

  if [ "$NTFY_MARKDOWN" = "true" ]; then
    headers+=(-H "Markdown: yes")
  fi

  if [ -n "${GITHUB_RUN_NUMBER:-}" ]; then
    headers+=(-H "X-Run: ${GITHUB_RUN_NUMBER}")
  fi

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time 10 \
    --retry 3 \
    --retry-delay 2 \
    "${headers[@]}" \
    -d "$FULL_BODY" \
    "$url")

  if [[ "$http_code" =~ ^2 ]]; then
    echo "[notify] Sent '${EVENT}' to ${url} (HTTP ${http_code})"
  else
    echo "[notify] WARNING: ntfy.sh returned HTTP ${http_code} for ${url}" >&2
  fi
}

send_notification "$PRIMARY_TOPIC"

if [ -n "$PER_DEST_TOPIC" ] && [ "$PER_DEST_TOPIC" != "$PRIMARY_TOPIC" ]; then
  send_notification "$PER_DEST_TOPIC"
fi

exit 0
