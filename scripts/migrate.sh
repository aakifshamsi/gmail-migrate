#!/usr/bin/env bash
# migrate.sh — imapsync wrapper for Gmail-to-Gmail migration
# Reads configuration from environment variables, writes state to STATE_FILE.
#
# Required env vars:
#   GMAIL_SOURCE_USER, GMAIL_SOURCE_APP_PASS
#   GMAIL_DEST_USER, GMAIL_DEST_APP_PASS
#   DEST_ID          — "dest1" or "dest2"
#   STATE_FILE       — path to migration-state-*.json
#   STRATEGY         — "size" | "folder" | "random"
#   DRY_RUN          — "true" | "false"
#   NTFY_TOPIC       — ntfy.sh topic name
#
# Optional env vars:
#   SIZE_LIMIT_MB    — bytes limit (default: 500)
#   EMAIL_LIMIT      — max emails (default: 0 = unlimited)
#   MIGRATION_FOLDER — folder for folder strategy (default: INBOX)
#   SAMPLE_SIZE      — for random strategy (default: 50)

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Defaults
# ─────────────────────────────────────────────────────────────────────────────
STRATEGY="${STRATEGY:-size}"
DRY_RUN="${DRY_RUN:-false}"
SIZE_LIMIT_MB="${SIZE_LIMIT_MB:-500}"
EMAIL_LIMIT="${EMAIL_LIMIT:-0}"
MIGRATION_FOLDER="${MIGRATION_FOLDER:-INBOX}"
SAMPLE_SIZE="${SAMPLE_SIZE:-50}"
STATE_FILE="${STATE_FILE:-migration-state.json}"
DEST_ID="${DEST_ID:-dest1}"
LOGFILE="migration.log"
NTFY_TOPIC="${NTFY_TOPIC:-}"
NTFY_MILESTONE_EMAILS="${NTFY_MILESTONE_EMAILS:-500}"
NTFY_MILESTONE_MB="${NTFY_MILESTONE_MB:-100}"

# Derived
SIZE_LIMIT_BYTES=$(( SIZE_LIMIT_MB * 1024 * 1024 ))
SOURCE_REDACTED="***@${GMAIL_SOURCE_USER##*@}"
DEST_REDACTED="***@${GMAIL_DEST_USER##*@}"
START_TIME=$(date +%s)
IMAPSYNC_PID=""

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
err() { echo "[$(date -u +%H:%M:%S)] ERROR: $*" >&2; }

die() {
  err "$*"
  update_state "error" "errors" "$(json_string "$*")"
  notify_error "$*" "1"
  exit 1
}

json_string() {
  # Minimal JSON-safe string escape
  echo "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/\\n$//'
}

elapsed() {
  echo $(( $(date +%s) - START_TIME ))
}

bytes_human() {
  numfmt --to=iec "${1:-0}" 2>/dev/null || echo "${1:-0}B"
}

# ─────────────────────────────────────────────────────────────────────────────
# Validate required environment
# ─────────────────────────────────────────────────────────────────────────────
check_env() {
  local missing=()
  for var in GMAIL_SOURCE_USER GMAIL_SOURCE_APP_PASS GMAIL_DEST_USER GMAIL_DEST_APP_PASS; do
    [ -z "${!var:-}" ] && missing+=("$var")
  done
  if (( ${#missing[@]} > 0 )); then
    die "Missing required environment variables: ${missing[*]}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# State file management
# ─────────────────────────────────────────────────────────────────────────────
read_state() {
  python3 - << EOF
import json, sys
try:
    with open("$STATE_FILE") as f:
        d = json.load(f)
    print(d.get("$1", ""))
except Exception:
    print("")
EOF
}

update_state() {
  # update_state <status> [<key> <value> ...]
  local new_status="$1"; shift
  python3 - "$new_status" "$STATE_FILE" "$@" << 'EOF'
import json, sys, datetime

status = sys.argv[1]
path   = sys.argv[2]
extras = sys.argv[3:]  # key value key value ...

try:
    with open(path) as f:
        d = json.load(f)
except Exception:
    d = {}

d["status"]     = status
d["updated_at"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

it = iter(extras)
for k in it:
    v = next(it, None)
    if v is not None:
        # Try to parse as int
        try:
            d[k] = int(v)
        except (ValueError, TypeError):
            d[k] = v

with open(path, "w") as f:
    json.dump(d, f, indent=2)
EOF
}

init_state() {
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  python3 - << EOF
import json, datetime

path = "$STATE_FILE"
try:
    with open(path) as f:
        d = json.load(f)
except Exception:
    d = {}

d.update({
    "schema_version": 1,
    "source_account": "REDACTED",
    "destination": "$DEST_ID",
    "strategy": "$STRATEGY",
    "status": "in_progress",
    "started_at": d.get("started_at") or "$now",
    "updated_at": "$now",
    "target_emails": ${EMAIL_LIMIT} if ${EMAIL_LIMIT} > 0 else None,
    "target_bytes": ${SIZE_LIMIT_BYTES} if ${SIZE_LIMIT_BYTES} > 0 else None,
    "errors": d.get("errors", [])
})

with open(path, "w") as f:
    json.dump(d, f, indent=2)
EOF
}

# ─────────────────────────────────────────────────────────────────────────────
# Parse imapsync log for progress metrics
# ─────────────────────────────────────────────────────────────────────────────
get_emails_migrated() {
  grep -c "^Msg " "$LOGFILE" 2>/dev/null || echo 0
}

get_bytes_transferred() {
  grep "^Msg " "$LOGFILE" 2>/dev/null \
    | awk '{sum += $6} END {print sum+0}'
}

get_last_uid() {
  grep "^Msg " "$LOGFILE" 2>/dev/null \
    | tail -1 | awk '{print $4}'
}

get_last_folder() {
  grep "^Host[12] folder" "$LOGFILE" 2>/dev/null \
    | tail -1 | sed 's/.*folder //'
}

get_error_count() {
  grep -c "^Error\|^Err\b" "$LOGFILE" 2>/dev/null || echo 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Notifications
# ─────────────────────────────────────────────────────────────────────────────
notify() {
  [ -z "$NTFY_TOPIC" ] && return 0
  bash scripts/notify.sh "$@" || true  # notifications are best-effort
}

notify_start() {
  notify "start" \
    "📬 Gmail Migration Started" \
    "Strategy: ${STRATEGY}
Source: ${SOURCE_REDACTED}
Destination: ${DEST_ID} (${DEST_REDACTED})
Size limit: $(bytes_human "$SIZE_LIMIT_BYTES")
Email limit: ${EMAIL_LIMIT:-unlimited}
Dry-run: ${DRY_RUN}
Run: #${GITHUB_RUN_NUMBER:-local}" \
    "default"
}

notify_milestone() {
  local emails="$1" bytes="$2" folder="$3"
  notify "milestone" \
    "📊 Migration Milestone — ${DEST_ID}" \
    "Emails so far: ${emails}
Bytes transferred: $(bytes_human "$bytes")
Current folder: ${folder}
Elapsed: $(elapsed)s" \
    "low"
}

notify_complete() {
  local emails="$1" bytes="$2" errors="$3"
  local freed_hr
  freed_hr=$(bytes_human "$bytes")
  notify "complete" \
    "✅ Migration Complete — ${DEST_ID}" \
    "Emails migrated: ${emails}
Data copied: ${freed_hr}
Errors: ${errors}
Duration: $(elapsed)s
Strategy: ${STRATEGY}
Source quota used: ~${freed_hr} of 2,500 MB/day
Storage will be freed from source after cleanup job." \
    "high"
}

notify_error() {
  local msg="$1" exit_code="${2:-1}"
  notify "error" \
    "❌ Migration Error — ${DEST_ID}" \
    "Error: ${msg}
Exit code: ${exit_code}
Emails before error: $(get_emails_migrated)
Run: #${GITHUB_RUN_NUMBER:-local}" \
    "urgent"
}

# ─────────────────────────────────────────────────────────────────────────────
# Quota monitor — polls log and kills imapsync when size limit reached
# ─────────────────────────────────────────────────────────────────────────────
quota_monitor() {
  local pid="$1"
  local last_notify_emails=0
  local last_notify_bytes=0
  local milestone_bytes=$(( NTFY_MILESTONE_MB * 1024 * 1024 ))

  while kill -0 "$pid" 2>/dev/null; do
    sleep 10

    local emails bytes
    emails=$(get_emails_migrated)
    bytes=$(get_bytes_transferred)

    # Size quota check
    if (( SIZE_LIMIT_BYTES > 0 && bytes >= SIZE_LIMIT_BYTES )); then
      log "Size quota reached: $(bytes_human "$bytes") >= $(bytes_human "$SIZE_LIMIT_BYTES"). Stopping imapsync."
      kill "$pid" 2>/dev/null || true
      echo "quota_reached" > /tmp/stop_reason
      break
    fi

    # Email count limit
    if (( EMAIL_LIMIT > 0 && emails >= EMAIL_LIMIT )); then
      log "Email limit reached: ${emails} >= ${EMAIL_LIMIT}. Stopping imapsync."
      kill "$pid" 2>/dev/null || true
      echo "email_limit" > /tmp/stop_reason
      break
    fi

    # Milestone notifications
    local emails_since=$(( emails - last_notify_emails ))
    local bytes_since=$(( bytes - last_notify_bytes ))
    if (( emails_since >= NTFY_MILESTONE_EMAILS || bytes_since >= milestone_bytes )); then
      notify_milestone "$emails" "$bytes" "$(get_last_folder)"
      last_notify_emails=$emails
      last_notify_bytes=$bytes
    fi
  done
}

# ─────────────────────────────────────────────────────────────────────────────
# Build imapsync command for each strategy
# ─────────────────────────────────────────────────────────────────────────────
build_base_flags() {
  local flags=(
    --host1 imap.gmail.com --ssl1 --port1 993
    --user1 "$GMAIL_SOURCE_USER"
    --password1 "$GMAIL_SOURCE_APP_PASS"
    --host2 imap.gmail.com --ssl2 --port2 993
    --user2 "$GMAIL_DEST_USER"
    --password2 "$GMAIL_DEST_APP_PASS"
    --gmail1
    --gmail2
    --addheader
    --useuid
    --nofoldersizes
    --nofoldersizesatend
    --prefix1 ""
    --prefix2 "G-${GMAIL_SOURCE_USER}/"
    --exclude '\[Gmail\]/All Mail'
    --exclude '\[Gmail\]/Spam'
    --exclude '\[Gmail\]/Trash'
    --maxsize 26214400    # skip messages > 25MB
    --sleep1 1
    --sleep2 1
    --reconnectretry1 3
    --reconnectretry2 3
    --timeout 120
    --logfile "$LOGFILE"
  )
  echo "${flags[@]}"
}

build_size_flags() {
  # No folder restriction — migrate all (quota monitor handles the byte limit)
  echo ""
}

build_folder_flags() {
  echo "--folder '${MIGRATION_FOLDER}'"
}

build_random_flags() {
  log "Sampling ${SAMPLE_SIZE} random UIDs from ${MIGRATION_FOLDER}..."
  local uids
  uids=$(python3 - << EOF
import imaplib, random, os, sys
folder = os.environ.get("MIGRATION_FOLDER", "INBOX")
n = int(os.environ.get("SAMPLE_SIZE", "50"))
try:
    M = imaplib.IMAP4_SSL("imap.gmail.com")
    M.login(os.environ["GMAIL_SOURCE_USER"], os.environ["GMAIL_SOURCE_APP_PASS"])
    M.select(f'"{folder}"', readonly=True)
    _, data = M.uid("search", None, "ALL")
    all_uids = data[0].split() if data[0] else []
    sample = random.sample(all_uids, min(n, len(all_uids)))
    print(",".join(u.decode() for u in sample))
    M.logout()
except Exception as e:
    print("", end="")
    print(f"UID sampling failed: {e}", file=sys.stderr)
EOF
  )

  if [ -z "$uids" ]; then
    die "Failed to sample UIDs from ${MIGRATION_FOLDER}"
  fi

  log "Sampled UIDs: ${uids:0:80}..."
  echo "--folder '${MIGRATION_FOLDER}' --search 'UID ${uids}'"
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
main() {
  log "=== Gmail IMAP Migrator ==="
  log "Strategy:    $STRATEGY"
  log "Destination: $DEST_ID ($DEST_REDACTED)"
  log "Dry-run:     $DRY_RUN"
  log "Size limit:  $(bytes_human "$SIZE_LIMIT_BYTES")"
  log "Email limit: ${EMAIL_LIMIT:-unlimited}"

  check_env
  init_state

  # Remove stale logfile
  rm -f "$LOGFILE"
  rm -f /tmp/stop_reason

  # Notify start
  notify_start

  # Build flags
  read -ra BASE_FLAGS <<< "$(build_base_flags)"

  local STRATEGY_FLAGS=""
  case "$STRATEGY" in
    size)   STRATEGY_FLAGS="$(build_size_flags)" ;;
    folder) STRATEGY_FLAGS="$(build_folder_flags)" ;;
    random) STRATEGY_FLAGS="$(build_random_flags)" ;;
    *) die "Unknown strategy: $STRATEGY" ;;
  esac

  # Dry-run flag
  local DRY_FLAG=""
  [ "$DRY_RUN" = "true" ] && DRY_FLAG="--dry"

  # Execute imapsync
  log "Starting imapsync..."
  eval imapsync \
    "${BASE_FLAGS[@]}" \
    $STRATEGY_FLAGS \
    $DRY_FLAG \
    &

  IMAPSYNC_PID=$!
  log "imapsync PID: $IMAPSYNC_PID"

  # Start quota monitor in background (only for real runs)
  if [ "$DRY_RUN" != "true" ]; then
    quota_monitor "$IMAPSYNC_PID" &
    MONITOR_PID=$!
  fi

  # Wait for imapsync
  IMAPSYNC_EXIT=0
  wait "$IMAPSYNC_PID" || IMAPSYNC_EXIT=$?

  # Stop monitor
  if [ -n "${MONITOR_PID:-}" ]; then
    kill "$MONITOR_PID" 2>/dev/null || true
  fi

  # Final metrics
  EMAILS_MIGRATED=$(get_emails_migrated)
  BYTES_TRANSFERRED=$(get_bytes_transferred)
  LAST_UID=$(get_last_uid)
  LAST_FOLDER=$(get_last_folder)
  ERROR_COUNT=$(get_error_count)
  STOP_REASON=$(cat /tmp/stop_reason 2>/dev/null || echo "completed")
  DURATION=$(elapsed)

  log "─────────────────────────────────────"
  log "Emails migrated:   $EMAILS_MIGRATED"
  log "Bytes transferred: $(bytes_human "$BYTES_TRANSFERRED")"
  log "Errors:            $ERROR_COUNT"
  log "Duration:          ${DURATION}s"
  log "Stop reason:       $STOP_REASON"
  log "Exit code:         $IMAPSYNC_EXIT"
  log "─────────────────────────────────────"

  # Update state
  local final_status="completed"
  if (( IMAPSYNC_EXIT == 1 )); then
    final_status="completed_with_errors"
  elif (( IMAPSYNC_EXIT > 1 )); then
    final_status="failed"
  fi

  update_state "$final_status" \
    "processed_emails" "$EMAILS_MIGRATED" \
    "processed_bytes" "$BYTES_TRANSFERRED" \
    "last_uid" "$LAST_UID" \
    "last_folder" "$LAST_FOLDER"

  # Parse log for Gmail-specific errors
  if [ -f "$LOGFILE" ]; then
    if grep -q "OVERQUOTA" "$LOGFILE"; then
      log "WARNING: Gmail OVERQUOTA detected."
      notify "overquota" \
        "⚠️ Gmail OVERQUOTA — ${DEST_ID}" \
        "Gmail rate limit hit. Migration paused at ${EMAILS_MIGRATED} emails. Resume tomorrow." \
        "high"
    fi

    if grep -q "AUTHENTICATIONFAILED" "$LOGFILE"; then
      notify_error "Authentication failed — check App Password for ${DEST_ID}" "$IMAPSYNC_EXIT"
    fi
  fi

  # Notify completion
  if (( IMAPSYNC_EXIT <= 1 )); then
    notify_complete "$EMAILS_MIGRATED" "$BYTES_TRANSFERRED" "$ERROR_COUNT"
  else
    notify_error "imapsync exited with code ${IMAPSYNC_EXIT}" "$IMAPSYNC_EXIT"
  fi

  # Exit with imapsync's code (exit 1 = partial success, treated as warning)
  if (( IMAPSYNC_EXIT > 1 )); then
    exit "$IMAPSYNC_EXIT"
  fi
  exit 0
}

main "$@"
