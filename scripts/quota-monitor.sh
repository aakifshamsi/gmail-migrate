#!/usr/bin/env bash
# quota-monitor.sh — Gmail IMAP upload quota tracker for migration
# Reads migration state files, tracks rolling 24h usage, sends ntfy alerts.
#
# Usage:
#   ./quota-monitor.sh              # normal run (sends alerts)
#   ./quota-monitor.sh --dry-run    # print actions without sending alerts
#   ./quota-monitor.sh --status     # print JSON status to stdout and exit
#
# Environment overrides:
#   NTFY_TOPIC        — ntfy topic URL (default: https://ntfy.sh/abbsjai)
#   DAILY_BUDGET_MB   — daily upload budget per account (default: 450)
#   STATE_DIR         — directory with migration-state-*.json (default: script/../)
#   QUOTA_STATE_FILE  — path to quota-state.json (default: STATE_DIR/quota-state.json)

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${STATE_DIR:-$(dirname "$SCRIPT_DIR")}"
QUOTA_STATE_FILE="${QUOTA_STATE_FILE:-${STATE_DIR}/quota-state.json}"
NTFY_TOPIC="${NTFY_TOPIC:-https://ntfy.sh/abbsjai}"
DAILY_BUDGET_MB="${DAILY_BUDGET_MB:-450}"
DAILY_BUDGET_BYTES=$((DAILY_BUDGET_MB * 1024 * 1024))
WARN_THRESHOLD=0.80   # 80%
CRIT_THRESHOLD=0.95   # 95%
STATUS_INTERVAL=21600 # 6 hours in seconds

DEST1_STATE="${STATE_DIR}/migration-state-dest1.json"
DEST2_STATE="${STATE_DIR}/migration-state-dest2.json"

DRY_RUN=false
STATUS_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true ;;
    --status)   STATUS_ONLY=true ;;
    *)          echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# ─── Helpers ─────────────────────────────────────────────────────────────────
now_epoch() { date -u +%s; }
now_iso()   { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Read a numeric field from a JSON file using python3 (portable fallback)
json_num() {
  local file="$1" key="$2"
  python3 -c "
import json, sys
with open('$file') as f:
    d = json.load(f)
v = d.get('$key', 0)
print(int(v) if v is not None else 0)
" 2>/dev/null || echo 0
}

json_field() {
  local file="$1" key="$2"
  python3 -c "
import json
with open('$file') as f:
    d = json.load(f)
print(d.get('$key', ''))
" 2>/dev/null || echo ""
}

send_ntfy() {
  local title="$1" body="$2" priority="${3:-default}" tags="${4:-}"
  if $DRY_RUN; then
    echo "[DRY-RUN] ntfy: priority=$priority tags=$tags title=$title"
    echo "  body: $body"
    return 0
  fi
  curl -sf --max-time 10 \
    -H "Title: $title" \
    -H "Priority: $priority" \
    -H "Tags: $tags" \
    -d "$body" \
    "$NTFY_TOPIC" >/dev/null 2>&1 || echo "[WARN] ntfy send failed (non-fatal)" >&2
}

human_bytes() {
  local bytes=$1
  if (( bytes >= 1073741824 )); then
    awk "BEGIN {printf \"%.2f GB\", $bytes/1073741824}"
  elif (( bytes >= 1048576 )); then
    awk "BEGIN {printf \"%.1f MB\", $bytes/1048576}"
  elif (( bytes >= 1024 )); then
    awk "BEGIN {printf \"%.0f KB\", $bytes/1024}"
  else
    echo "${bytes} B"
  fi
}

# ─── Load or init quota state ───────────────────────────────────────────────
init_quota_state() {
  cat <<EOF
{
  "bytes_sent_dest1": 0,
  "bytes_sent_dest2": 0,
  "bytes_at_reset_dest1": 0,
  "bytes_at_reset_dest2": 0,
  "last_reset": $(now_epoch),
  "last_status_sent": 0,
  "daily_budget_mb": ${DAILY_BUDGET_MB},
  "daily_budget_bytes": ${DAILY_BUDGET_BYTES},
  "blocked": false,
  "block_reason": "",
  "updated_at": "$(now_iso)"
}
EOF
}

if [[ ! -f "$QUOTA_STATE_FILE" ]]; then
  echo "[INFO] No quota-state.json found — initializing" >&2
  init_quota_state > "$QUOTA_STATE_FILE"
fi

# Load quota state with python (handles all fields cleanly)
read_quota() {
  python3 -c "
import json, sys
with open('$QUOTA_STATE_FILE') as f:
    q = json.load(f)
for k,v in q.items():
    print(f'{k}={v}')
"
}

declare -A Q
while IFS='=' read -r k v; do
  Q["$k"]="$v"
done < <(read_quota)

LAST_RESET="${Q[last_reset]:-$(now_epoch)}"
LAST_STATUS="${Q[last_status_sent]:-0}"
BLOCKED="${Q[blocked]:-False}"
BLOCK_REASON="${Q[block_reason]:-}"
BUDGET_MB="${Q[daily_budget_mb]:-$DAILY_BUDGET_MB}"
BUDGET_BYTES=$((BUDGET_MB * 1024 * 1024))
PREV_BYTES_D1="${Q[bytes_at_reset_dest1]:-0}"
PREV_BYTES_D2="${Q[bytes_at_reset_dest2]:-0}"

# ─── Read current migration state ───────────────────────────────────────────
CURR_BYTES_D1=0
CURR_BYTES_D2=0

if [[ -f "$DEST1_STATE" ]]; then
  CURR_BYTES_D1=$(json_num "$DEST1_STATE" "processed_bytes")
else
  echo "[WARN] $DEST1_STATE not found" >&2
fi

if [[ -f "$DEST2_STATE" ]]; then
  CURR_BYTES_D2=$(json_num "$DEST2_STATE" "processed_bytes")
else
  echo "[WARN] $DEST2_STATE not found" >&2
fi

# ─── Daily reset check (midnight UTC) ───────────────────────────────────────
NOW=$(now_epoch)
TODAY_UTC_START=$(date -u -d "today 00:00:00 UTC" +%s 2>/dev/null || date -u -d "00:00:00" +%s)

if (( LAST_RESET < TODAY_UTC_START )); then
  echo "[INFO] Daily reset triggered" >&2
  PREV_BYTES_D1=$CURR_BYTES_D1
  PREV_BYTES_D2=$CURR_BYTES_D2
  LAST_RESET=$NOW
  BLOCKED="False"
  BLOCK_REASON=""

  send_ntfy "🔄 Quota RESET" \
    "Daily budget reset to ${BUDGET_MB}MB per destination. Migration can resume." \
    "default" "recycle"
fi

# ─── Calculate daily usage ──────────────────────────────────────────────────
DAILY_D1=$(( CURR_BYTES_D1 - PREV_BYTES_D1 ))
(( DAILY_D1 < 0 )) && DAILY_D1=0
DAILY_D2=$(( CURR_BYTES_D2 - PREV_BYTES_D2 ))
(( DAILY_D2 < 0 )) && DAILY_D2=0
TOTAL_DAILY=$(( DAILY_D1 + DAILY_D2 ))

# Per-destination percentages
PCT_D1=$(awk "BEGIN {printf \"%.1f\", ($DAILY_D1/$BUDGET_BYTES)*100}")
PCT_D2=$(awk "BEGIN {printf \"%.1f\", ($DAILY_D2/$BUDGET_BYTES)*100}")
MAX_DAILY=$DAILY_D1
(( DAILY_D2 > MAX_DAILY )) && MAX_DAILY=$DAILY_D2
PCT_MAX=$(awk "BEGIN {printf \"%.1f\", ($MAX_DAILY/$BUDGET_BYTES)*100}")

# ─── Status-only mode ───────────────────────────────────────────────────────
BLOCKED_BOOL=False
[[ "$BLOCKED" == "True" ]] && BLOCKED_BOOL=True

if $STATUS_ONLY; then
  python3 -c "
import json, sys
q = {
    'timestamp': '$(now_iso)',
    'epoch': $NOW,
    'blocked': ${BLOCKED_BOOL},
    'block_reason': '${BLOCK_REASON}',
    'daily_budget_mb': ${BUDGET_MB},
    'dest1': {
        'total_bytes': ${CURR_BYTES_D1},
        'daily_bytes': ${DAILY_D1},
        'daily_pct': ${PCT_D1},
        'daily_human': '$(human_bytes $DAILY_D1)'
    },
    'dest2': {
        'total_bytes': ${CURR_BYTES_D2},
        'daily_bytes': ${DAILY_D2},
        'daily_pct': ${PCT_D2},
        'daily_human': '$(human_bytes $DAILY_D2)'
    },
    'combined_daily_bytes': ${TOTAL_DAILY},
    'combined_daily_human': '$(human_bytes $TOTAL_DAILY)',
    'max_daily_pct': ${PCT_MAX},
    'last_reset_epoch': ${LAST_RESET},
    'last_status_epoch': ${LAST_STATUS}
}
print(json.dumps(q, indent=2))
"
  exit 0
fi

# ─── Alert logic ─────────────────────────────────────────────────────────────

# Check if already blocked
if [[ "$BLOCKED" == "True" ]]; then
  echo "[BLOCKED] $BLOCK_REASON" >&2
  # Output status for other scripts
  echo '{"blocked":true,"reason":"'"$BLOCK_REASON"'"}'
  exit 2
fi

# Check each destination against thresholds
check_threshold() {
  local dest="$1" daily_bytes="$2" pct="$3"
  local pct_int=${pct%.*}

  if (( pct_int >= 100 )); then
    send_ntfy "🚫 QUOTA BLOCKED — $dest" \
      "Daily budget EXCEEDED: $(human_bytes $daily_bytes) / ${BUDGET_MB}MB (${pct}%). Further uploads blocked until reset." \
      "urgent" "rotating_light,octagonal_sign"
    BLOCKED="True"
    BLOCK_REASON="$dest exceeded daily budget (${pct}%)"
    return
  fi

  if (( pct_int >= 95 )); then
    send_ntfy "🔴 CRITICAL — $dest" \
      "Daily usage at ${pct}%: $(human_bytes $daily_bytes) / ${BUDGET_MB}MB. Approaching limit!" \
      "high" "fire,warning"
  elif (( pct_int >= 80 )); then
    send_ntfy "⚠️ WARNING — $dest" \
      "Daily usage at ${pct}%: $(human_bytes $daily_bytes) / ${BUDGET_MB}MB." \
      "default" "warning"
  fi
}

check_threshold "dest1" "$DAILY_D1" "$PCT_D1"
check_threshold "dest2" "$DAILY_D2" "$PCT_D2"

# Periodic status (every 6 hours)
if (( NOW - LAST_STATUS >= STATUS_INTERVAL )); then
  D1_HUMAN=$(human_bytes $DAILY_D1)
  D2_HUMAN=$(human_bytes $DAILY_D2)
  CUM_D1=$(human_bytes $CURR_BYTES_D1)
  CUM_D2=$(human_bytes $CURR_BYTES_D2)

  send_ntfy "📊 Migration Status" \
    "Daily usage: dest1=${D1_HUMAN}/${BUDGET_MB}MB (${PCT_D1}%) | dest2=${D2_HUMAN}/${BUDGET_MB}MB (${PCT_D2}%)
Cumulative: dest1=${CUM_D1} | dest2=${CUM_D2}
Blocked: ${BLOCKED}" \
    "default" "bar_chart"
  LAST_STATUS=$NOW
fi

# ─── Save quota state ───────────────────────────────────────────────────────
python3 -c "
import json
state = {
    'bytes_sent_dest1': ${CURR_BYTES_D1},
    'bytes_sent_dest2': ${CURR_BYTES_D2},
    'bytes_at_reset_dest1': ${PREV_BYTES_D1},
    'bytes_at_reset_dest2': ${PREV_BYTES_D2},
    'last_reset': ${LAST_RESET},
    'last_status_sent': ${LAST_STATUS},
    'daily_budget_mb': ${BUDGET_MB},
    'daily_budget_bytes': ${BUDGET_BYTES},
    'blocked': $( [[ "$BLOCKED" == "True" ]] && echo "True" || echo "False" ),
    'block_reason': '${BLOCK_REASON}',
    'updated_at': '$(now_iso)'
}
with open('${QUOTA_STATE_FILE}', 'w') as f:
    json.dump(state, f, indent=2)
"

# ─── Output JSON for piping ─────────────────────────────────────────────────
cat <<EOF
{
  "blocked": $( [[ "$BLOCKED" == "True" ]] && echo "true" || echo "false" ),
  "dest1_daily_pct": ${PCT_D1},
  "dest2_daily_pct": ${PCT_D2},
  "max_daily_pct": ${PCT_MAX},
  "dest1_daily_bytes": ${DAILY_D1},
  "dest2_daily_bytes": ${DAILY_D2},
  "budget_bytes": ${BUDGET_BYTES}
}
EOF

if [[ "$BLOCKED" == "True" ]]; then
  exit 2
fi

exit 0
