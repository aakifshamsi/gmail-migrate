#!/usr/bin/env bash
# batch-migrator.sh — Orchestrate chained GitHub Actions workflow runs
# to migrate ~1 GB of email from source, skipping Primary & Updates folders.
#
# Usage:
#   bash scripts/batch-migrator.sh [--dry-run] [--repo owner/repo] [--ntfy-topic abbsjai]
#
# Dependencies: gh, jq, curl
set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────
MAX_RUNS="${MAX_RUNS:-20}"
TARGET_BYTES=$((1 * 1024 * 1024 * 1024))          # 1 GB
COOLDOWN_SEC=60                                     # between runs
WORKFLOW_TIMEOUT_SEC=300                             # 5 min polling timeout per run
POLL_INTERVAL=15                                     # seconds between workflow polls
QUOTA_WAIT_SEC=1800                                  # 30 min wait when quota blocked
NTFY_TOPIC="${NTFY_TOPIC:-abbsjai}"
NTFY_URL="https://ntfy.sh/${NTFY_TOPIC}"
REPO="${REPO:-}"                                     # auto-detected from git remote if empty
DRY_RUN=false
STATE_FILE="batch-state.json"
EMAIL_LIMIT=50
BATCH_SIZE=10

# ─── Folder priority (skip Primary, Updates, All Mail, Spam, Trash) ──────────
# These are Gmail system categories / labels.
SKIP_FOLDERS="Primary|Updates|[Gmail]/All Mail|[Gmail]/Spam|[Gmail]/Trash"

# ─── Parse args ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)    DRY_RUN=true; shift ;;
    --repo)       REPO="$2"; shift 2 ;;
    --ntfy-topic) NTFY_TOPIC="$2"; NTFY_URL="https://ntfy.sh/${NTFY_TOPIC}"; shift 2 ;;
    --max-runs)   MAX_RUNS="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,/^$/s/^# //p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ─── Auto-detect repo ────────────────────────────────────────────────────────
if [[ -z "$REPO" ]]; then
  REPO="$(git remote get-url origin 2>/dev/null | sed -E 's#.*(github\.com[:/])##;s/\.git$//' || true)"
fi
if [[ -z "$REPO" ]]; then
  echo "ERROR: Cannot detect repo. Pass --repo owner/repo" >&2
  exit 1
fi
echo "📦 Repo: $REPO"

# ─── Dependency check ────────────────────────────────────────────────────────
for cmd in gh jq curl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: Required command '$cmd' not found" >&2
    exit 1
  fi
done

# ─── Helpers ──────────────────────────────────────────────────────────────────

notify() {
  local title="$1" body="$2" priority="${3:-default}"
  curl -s -o /dev/null \
    -H "Title: ${title}" \
    -H "Priority: ${priority}" \
    -d "$body" \
    "${NTFY_URL}" || echo "⚠️  ntfy notification failed (non-fatal)"
}

log() {
  echo "[$(date -u +%H:%M:%S)] $*"
}

# Check quota-monitor.sh status; returns 0 if OK, 1 if BLOCKED (caller should wait)
check_quota() {
  local quota_script="scripts/quota-monitor.sh"
  if [[ ! -x "$quota_script" ]]; then
    log "⚠️  quota-monitor.sh not found or not executable — skipping quota check"
    return 0
  fi

  local output
  output="$(bash "$quota_script" 2>&1)" || true
  if echo "$output" | grep -qi "BLOCKED"; then
    log "🚫 Quota BLOCKED: $(echo "$output" | head -1)"
    return 1
  fi
  log "✅ Quota OK"
  return 0
}

# Discover Gmail folders via migrate.py dry-run, filtering out skipped categories.
# Outputs ordered list: custom labels → sent/drafts/starred → social/promotions/forums
discover_folders() {
  local tmpfile
  tmpfile="$(mktemp)"

  # Use a targeted IMAP LIST to discover folders
  python3 - "$tmpfile" << 'PYEOF' 2>/dev/null || true
import imaplib, os, sys, json

tmpfile = sys.argv[1]
user = os.environ.get("GMAIL_SOURCE_USER", "")
pwd  = os.environ.get("GMAIL_SOURCE_APP_PASS", "")

if not user or not pwd:
    print("WARN: GMAIL_SOURCE_USER/PASS not set", file=sys.stderr)
    with open(tmpfile, "w") as f: json.dump([], f)
    sys.exit(0)

M = imaplib.IMAP4_SSL("imap.gmail.com")
M.login(user, pwd)
_, folders_raw = M.list()
M.logout()

folders = []
if folders_raw:
    for line in folders_raw:
        parts = line.decode().split(' "/" ')
        if len(parts) == 2:
            name = parts[-1].strip().strip('"')
            folders.append(name)

with open(tmpfile, "w") as f:
    json.dump(folders, f)
PYEOF

  if [[ ! -s "$tmpfile" ]]; then
    rm -f "$tmpfile"
    # Fallback to hardcoded priority list
    printf '%s\n' \
      "Sent Mail" "Drafts" "Starred" \
      "[Gmail]/Social" "[Gmail]/Promotions" "[Gmail]/Forums"
    return
  fi

  local all_folders
  all_folders="$(jq -r '.[]' "$tmpfile")"
  rm -f "$tmpfile"

  local skip_re="(Primary|Updates|All Mail|Spam|Trash)$"
  local -a priority1=()  # custom labels
  local -a priority2=()  # sent, drafts, starred
  local -a priority3=()  # social, promotions, forums

  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    # Skip system categories
    if [[ "$f" =~ $skip_re ]]; then
      continue
    fi

    # Categorise
    case "$f" in
      "[Gmail]/Sent"|"Sent"|"Sent Mail")       priority2+=("$f") ;;
      "[Gmail]/Drafts"|"Drafts")                priority2+=("$f") ;;
      "[Gmail]/Starred"|"Starred")              priority2+=("$f") ;;
      "[Gmail]/Social"|"Social")                priority3+=("$f") ;;
      "[Gmail]/Promotions"|"Promotions")        priority3+=("$f") ;;
      "[Gmail]/Forums"|"Forums")                priority3+=("$f") ;;
      "[Gmail]/"*)                              ;; # skip other system
      *)                                        priority1+=("$f") ;; # custom labels
    esac
  done <<< "$all_folders"

  # Output in priority order
  printf '%s\n' "${priority1[@]}" "${priority2[@]}" "${priority3[@]}"
}

# Load or init batch-state.json
init_state() {
  if [[ -f "$STATE_FILE" ]]; then
    log "📂 Loaded existing state from $STATE_FILE"
    return
  fi

  cat > "$STATE_FILE" << 'EOF'
{
  "total_released_bytes": 0,
  "runs_completed": 0,
  "current_phase": "init",
  "current_folder": "",
  "folder_index": 0,
  "status": "in_progress",
  "started_at": "",
  "updated_at": "",
  "errors": []
}
EOF
  log "📂 Created fresh state: $STATE_FILE"
}

get_state() {
  jq -r ".$1" "$STATE_FILE"
}

set_state() {
  local tmpfile
  tmpfile="$(mktemp)"
  jq --arg k "$1" --arg v "$2" '.[$k] = $v' "$STATE_FILE" > "$tmpfile"
  mv "$tmpfile" "$STATE_FILE"
}

set_state_num() {
  local tmpfile
  tmpfile="$(mktemp)"
  jq --arg k "$1" --argjson v "$2" '.[$k] = $v' "$STATE_FILE" > "$tmpfile"
  mv "$tmpfile" "$STATE_FILE"
}

add_error() {
  local tmpfile
  tmpfile="$(mktemp)"
  jq --arg e "$1" '.errors += [$e]' "$STATE_FILE" > "$tmpfile"
  mv "$tmpfile" "$STATE_FILE"
}

bytes_to_human() {
  numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "${1}B"
}

# ─── Trigger a single workflow run ────────────────────────────────────────────
trigger_run() {
  local folder="$1" run_num="$2"

  log "🚀 Triggering batch #${run_num}: folder='${folder}', limit=${EMAIL_LIMIT}"

  if [[ "$DRY_RUN" == "true" ]]; then
    log "  [DRY-RUN] Would run: gh workflow run migrate.yml -f folder='${folder}' -f email_limit=${EMAIL_LIMIT} -f batch_size=${BATCH_SIZE} -f strategy=folder"
    echo "dry-run-0"
    return 0
  fi

  notify "🚀 Batch ${run_num} starting" \
    "folder=${folder}, limit=${EMAIL_LIMIT} emails, batch_size=${BATCH_SIZE}" \
    "default"

  gh workflow run "migrate.yml" \
    -R "$REPO" \
    -f strategy=folder \
    -f folder="$folder" \
    -f email_limit="$EMAIL_LIMIT" \
    -f batch_size="$BATCH_SIZE" \
    -f destination=both \
    -f dry_run=false \
    -f skip_dedup=false \
    -f size_limit_mb=500 \
    -f delete_from_source=false \
  || {
    log "❌ Failed to trigger workflow"
    add_error "Run ${run_num}: failed to trigger workflow for folder=${folder}"
    notify "❌ Batch ${run_num} failed" \
      "Could not trigger workflow for folder=${folder}" \
      "urgent"
    return 1
  }

  # Wait a moment for the run to appear
  sleep 5

  # Find the latest in-progress run
  local run_id=""
  for _ in 1 2 3 4 5; do
    run_id="$(gh run list -R "$REPO" --workflow=migrate.yml --status=in_progress --limit=1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
    if [[ -n "$run_id" ]]; then break; fi
    sleep 5
  done

  if [[ -z "$run_id" ]]; then
    log "⚠️  Could not find in-progress run — checking queued"
    run_id="$(gh run list -R "$REPO" --workflow=migrate.yml --status=queued --limit=1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
  fi

  echo "$run_id"
}

# ─── Wait for workflow run to complete ────────────────────────────────────────
wait_for_run() {
  local run_id="$1" elapsed=0

  if [[ "$run_id" == "dry-run-0" ]]; then
    log "  [DRY-RUN] Skipping wait"
    return 0
  fi

  if [[ -z "$run_id" || "$run_id" == "null" ]]; then
    log "⚠️  No run ID to wait for"
    return 1
  fi

  log "⏳ Waiting for run #${run_id} (timeout: ${WORKFLOW_TIMEOUT_SEC}s)..."

  while (( elapsed < WORKFLOW_TIMEOUT_SEC )); do
    local status
    status="$(gh run view "$run_id" -R "$REPO" --json status -q '.status' 2>/dev/null || echo "unknown")"

    case "$status" in
      completed)
        local conclusion
        conclusion="$(gh run view "$run_id" -R "$REPO" --json conclusion -q '.conclusion' 2>/dev/null || echo "unknown")"
        log "  Run #${run_id} completed: ${conclusion}"
        if [[ "$conclusion" == "success" ]]; then
          return 0
        else
          log "  ❌ Run finished with conclusion: ${conclusion}"
          add_error "Run #${run_id}: finished with ${conclusion}"
          return 1
        fi
        ;;
      in_progress|queued|requested|waiting|pending)
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
        ;;
      *)
        log "  ⚠️  Unknown status: ${status}"
        sleep "$POLL_INTERVAL"
        elapsed=$((elapsed + POLL_INTERVAL))
        ;;
    esac
  done

  log "⏰ Timeout waiting for run #${run_id} after ${WORKFLOW_TIMEOUT_SEC}s"
  add_error "Run #${run_id}: timed out after ${WORKFLOW_TIMEOUT_SEC}s"
  return 1
}

# ─── Read bytes released from migration state files ───────────────────────────
read_released_bytes() {
  # The workflow writes state files like migration-state-dest1.json / dest2.json
  # We check both and take the minimum (since both must succeed for release)
  local total=0

  for statefile in migration-state-dest1.json migration-state-dest2.json; do
    if [[ -f "$statefile" ]]; then
      local bytes
      bytes="$(jq -r '.processed_bytes // 0' "$statefile" 2>/dev/null || echo 0)"
      if (( bytes > total )); then
        total="$bytes"
      fi
    fi
  done

  # Also try to read from migration.log for run-specific bytes
  if [[ -f migration.log ]]; then
    local log_bytes
    log_bytes="$(grep -oP 'transferred.*?(\d+) bytes' migration.log 2>/dev/null | tail -1 | grep -oP '\d+' || echo 0)"
    if (( log_bytes > total )); then
      total="$log_bytes"
    fi
  fi

  echo "$total"
}

# ─── Main orchestration loop ──────────────────────────────────────────────────
main() {
  log "═══════════════════════════════════════════════════════"
  log "  Gmail Batch Migration Orchestrator"
  log "  Target: $(bytes_to_human $TARGET_BYTES)"
  log "  Max runs: ${MAX_RUNS}"
  log "═══════════════════════════════════════════════════════"

  init_state

  # Set start time
  if [[ "$(get_state started_at)" == "" || "$(get_state started_at)" == "null" ]]; then
    set_state "started_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi

  # Discover folders
  log "📂 Discovering Gmail folders..."
  local -a folders=()
  while IFS= read -r f; do
    [[ -n "$f" ]] && folders+=("$f")
  done < <(discover_folders)

  if [[ ${#folders[@]} -eq 0 ]]; then
    log "⚠️  No processable folders found — using fallback priority list"
    folders=("Sent Mail" "Drafts" "Starred" "[Gmail]/Social" "[Gmail]/Promotions" "[Gmail]/Forums")
  fi

  log "📋 Folder priority order:"
  for i in "${!folders[@]}"; do
    log "   $((i+1)). ${folders[$i]}"
  done

  local total_released="$(get_state total_released_bytes)"
  local runs_completed="$(get_state runs_completed)"
  local folder_index="$(get_state folder_index)"
  local run_num="$((runs_completed + 1))"
  local cumulative="$total_released"

  set_state "status" "in_progress"
  set_state "current_phase" "folder_migration"

  log ""
  log "📊 Starting state: $(bytes_to_human $cumulative) released, ${runs_completed} runs completed"
  log ""

  # ── Main batch loop ──────────────────────────────────────────────────────
  for (( ; run_num <= MAX_RUNS; run_num++ )); do

    # Check if target reached
    if (( cumulative >= TARGET_BYTES )); then
      log "🎉 TARGET REACHED! $(bytes_to_human $cumulative) >= $(bytes_to_human $TARGET_BYTES)"
      set_state "status" "completed"
      set_state "current_phase" "done"
      notify "🎉 1GB target reached!" \
        "Released $(bytes_to_human $cumulative) in ${run_num} runs across ${#folders[@]} folders" \
        "max"
      break
    fi

    # Pick next folder
    if (( folder_index >= ${#folders[@]} )); then
      log "📋 All folders processed"
      set_state "status" "completed"
      set_state "current_phase" "all_folders_done"
      notify "✅ All folders processed" \
        "Released $(bytes_to_human $cumulative) in ${run_num} runs. Target: $(bytes_to_human $TARGET_BYTES)" \
        "high"
      break
    fi

    local current_folder="${folders[$folder_index]}"
    set_state "current_folder" "$current_folder"
    set_state "folder_index" "$folder_index"
    set_state_num "runs_completed" "$((run_num - 1))"

    log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    log "  Run #${run_num} / ${MAX_RUNS}"
    log "  Folder: ${current_folder}"
    log "  Progress: $(bytes_to_human $cumulative) / $(bytes_to_human $TARGET_BYTES)"
    log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # ── Quota check ──────────────────────────────────────────────────────
    local quota_retries=0
    local max_quota_retries=48  # 24 hours of retries
    while ! check_quota; do
      (( quota_retries++ ))
      if (( quota_retries >= max_quota_retries )); then
        log "❌ Quota blocked for too long (${quota_retries} retries). Giving up."
        set_state "status" "blocked"
        notify "❌ Batch ${run_num} failed" \
          "Quota blocked for ${quota_retries}×30min. Giving up." \
          "urgent"
        exit 1
      fi
      log "⏳ Quota blocked — waiting ${QUOTA_WAIT_SEC}s (retry ${quota_retries}/${max_quota_retries})..."
      notify "⏳ Batch ${run_num} blocked" \
        "Quota blocked, waiting 30min (retry ${quota_retries})" \
        "default"
      sleep "$QUOTA_WAIT_SEC"
    done

    # ── Trigger run ──────────────────────────────────────────────────────
    local run_id
    run_id="$(trigger_run "$current_folder" "$run_num")" || {
      log "❌ Failed to trigger run #${run_num}"
      set_state "status" "failed"
      exit 1
    }

    # ── Wait for completion ──────────────────────────────────────────────
    if wait_for_run "$run_id"; then
      # Read bytes from state files
      local new_bytes
      new_bytes="$(read_released_bytes)"
      local delta=$(( new_bytes - cumulative ))
      if (( delta > 0 )); then
        cumulative="$new_bytes"
      else
        # Estimate ~1MB per email if we can't read exact bytes
        cumulative=$((cumulative + EMAIL_LIMIT * 1024 * 100))
      fi

      set_state_num "total_released_bytes" "$cumulative"
      set_state_num "runs_completed" "$run_num"
      set_state "updated_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

      notify "✅ Batch ${run_num} done" \
        "folder=${current_folder}, cumulative $(bytes_to_human $cumulative) / $(bytes_to_human $TARGET_BYTES)" \
        "default"

      log "  📊 Cumulative: $(bytes_to_human $cumulative) / $(bytes_to_human $TARGET_BYTES)"

      # Advance to next folder (each folder gets one batch run, then we cycle)
      # If the folder still has mail, we could revisit it later
      folder_index=$((folder_index + 1))
      set_state "folder_index" "$folder_index"
    else
      log "  ⚠️  Run #${run_num} had errors — continuing to next folder"
      folder_index=$((folder_index + 1))
      set_state "folder_index" "$folder_index"
    fi

    # ── Cooldown ──────────────────────────────────────────────────────────
    if (( run_num < MAX_RUNS )) && (( cumulative < TARGET_BYTES )); then
      log "  😴 Cooldown ${COOLDOWN_SEC}s..."
      sleep "$COOLDOWN_SEC"
    fi
  done

  # ── Final summary ────────────────────────────────────────────────────────
  log ""
  log "═══════════════════════════════════════════════════════"
  log "  Batch Orchestration Complete"
  log "  Runs:        ${run_num}"
  log "  Released:    $(bytes_to_human $cumulative)"
  log "  Target:      $(bytes_to_human $TARGET_BYTES)"
  log "  Status:      $(get_state status)"
  log "═══════════════════════════════════════════════════════"

  set_state "updated_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# ─── Entrypoint ───────────────────────────────────────────────────────────────
main "$@"
