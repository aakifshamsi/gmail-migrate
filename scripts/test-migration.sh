#!/usr/bin/env bash
# test-migration.sh — dry-run and integrity test runner
#
# Usage:
#   ./scripts/test-migration.sh [OPTIONS]
#
# Options:
#   --strategy   size|folder|random|integrity   (required)
#   --dest       dest1|dest2|both               (required)
#   --dry-run                                   (flag; always true for size/folder/random)
#   --size-limit-mb  N                          (size strategy)
#   --folder     LABEL                          (folder strategy)
#   --sample-size N                             (random strategy)
#   --output-format  text|json|markdown         (default: text)
#
# Required env:
#   GMAIL_SOURCE_USER, GMAIL_SOURCE_APP_PASS
#   GMAIL_DEST_USER, GMAIL_DEST_APP_PASS (or DEST_ID + per-dest secrets)
#   NTFY_TOPIC (optional)

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Parse arguments
# ─────────────────────────────────────────────────────────────────────────────
STRATEGY=""
DEST="both"
DRY_RUN="true"        # test mode is always dry-run unless explicitly disabled
SIZE_LIMIT_MB="${SIZE_LIMIT_MB:-100}"
FOLDER="${MIGRATION_FOLDER:-INBOX}"
SAMPLE_SIZE="${SAMPLE_SIZE:-50}"
OUTPUT_FORMAT="text"
REPORT_FILE="test-report.txt"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strategy)       STRATEGY="$2"; shift 2 ;;
    --dest)           DEST="$2"; shift 2 ;;
    --dry-run)        DRY_RUN="true"; shift ;;
    --no-dry-run)     DRY_RUN="false"; shift ;;
    --size-limit-mb)  SIZE_LIMIT_MB="$2"; shift 2 ;;
    --folder)         FOLDER="$2"; shift 2 ;;
    --sample-size)    SAMPLE_SIZE="$2"; shift 2 ;;
    --output-format)  OUTPUT_FORMAT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$STRATEGY" ]; then
  echo "ERROR: --strategy is required (size|folder|random|integrity)" >&2
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────
log()    { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$REPORT_FILE"; }
header() { echo "" | tee -a "$REPORT_FILE"; echo "══════════════════════════════════════" | tee -a "$REPORT_FILE"; log "$*"; echo "══════════════════════════════════════" | tee -a "$REPORT_FILE"; }

bytes_human() { numfmt --to=iec "${1:-0}" 2>/dev/null || echo "${1:-0}B"; }

# ─────────────────────────────────────────────────────────────────────────────
# Connection test
# ─────────────────────────────────────────────────────────────────────────────
test_connection() {
  local host="$1" user="$2" pass="$3" label="$4"
  log "Testing IMAP connection: $label"

  python3 - "$host" "$user" "$pass" "$label" << 'EOF'
import imaplib, sys

host, user, password, label = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    M = imaplib.IMAP4_SSL(host)
    M.login(user, password)
    _, folders = M.list()
    folder_count = len(folders) if folders else 0
    print(f"  ✅ {label}: connected ({folder_count} folders)")
    M.logout()
    sys.exit(0)
except imaplib.IMAP4.error as e:
    print(f"  ❌ {label}: IMAP error — {e}")
    sys.exit(1)
except Exception as e:
    print(f"  ❌ {label}: Connection failed — {e}")
    sys.exit(1)
EOF
}

# ─────────────────────────────────────────────────────────────────────────────
# Build base imapsync flags (dry-run always on for tests)
# ─────────────────────────────────────────────────────────────────────────────
base_imapsync_args() {
  echo "--host1 imap.gmail.com --ssl1 --port1 993" \
       "--user1 '${GMAIL_SOURCE_USER}'" \
       "--password1 '${GMAIL_SOURCE_APP_PASS}'" \
       "--host2 imap.gmail.com --ssl2 --port2 993" \
       "--user2 '${GMAIL_DEST_USER}'" \
       "--password2 '${GMAIL_DEST_APP_PASS}'" \
       "--gmail1 --gmail2" \
       "--addheader --useuid" \
       "--nofoldersizes --nofoldersizesatend" \
       "--prefix1 '' --prefix2 'G-${GMAIL_SOURCE_USER}/'" \
       "--exclude '\\[Gmail\\]/All Mail'" \
       "--exclude '\\[Gmail\\]/Spam'" \
       "--exclude '\\[Gmail\\]/Trash'" \
       "--maxsize 26214400" \
       "--sleep1 1 --sleep2 1" \
       "--timeout 60" \
       "--dry"
}

# ─────────────────────────────────────────────────────────────────────────────
# Strategy: size
# ─────────────────────────────────────────────────────────────────────────────
run_size_test() {
  header "Size-based Dry-Run — limit: ${SIZE_LIMIT_MB} MB"
  log "Scanning all folders to estimate what would be migrated..."

  local logfile="test-size.log"
  eval imapsync \
    $(base_imapsync_args) \
    --justfoldersizes \
    > "$logfile" 2>&1 || true

  # Parse folder sizes from log
  log ""
  log "Folder size estimates:"
  grep -E "Folder|folder|Size|size" "$logfile" 2>/dev/null | head -60 | tee -a "$REPORT_FILE" || true

  # Estimate total bytes
  local total_bytes
  total_bytes=$(grep "Total size" "$logfile" 2>/dev/null | awk '{print $NF}' | head -1 || echo 0)
  local limit_bytes=$(( SIZE_LIMIT_MB * 1024 * 1024 ))

  log ""
  log "Estimated total source size: $(bytes_human "${total_bytes:-0}")"
  log "Migration limit:             $(bytes_human "$limit_bytes")"
  if (( ${total_bytes:-0} > 0 && limit_bytes > 0 )); then
    local pct=$(( limit_bytes * 100 / total_bytes ))
    log "Would migrate approx:        ${pct}% of total"
  fi
  log ""
  log "⚠️  DRY RUN — no messages written to destination."
}

# ─────────────────────────────────────────────────────────────────────────────
# Strategy: folder
# ─────────────────────────────────────────────────────────────────────────────
run_folder_test() {
  header "Folder-based Dry-Run — target: '${FOLDER}'"
  log "Scanning folder '${FOLDER}'..."

  local logfile="test-folder.log"
  eval imapsync \
    $(base_imapsync_args) \
    --folder "'${FOLDER}'" \
    > "$logfile" 2>&1 || true

  # Parse message counts from dry-run output
  local msg_count err_count
  msg_count=$(grep -c "^Msg " "$logfile" 2>/dev/null || echo 0)
  err_count=$(grep -c "^Err\b\|^Error " "$logfile" 2>/dev/null || echo 0)

  local total_bytes
  total_bytes=$(grep "^Msg " "$logfile" 2>/dev/null | awk '{sum+=$6} END{print sum+0}')

  log ""
  log "  Source folder:        ${FOLDER}"
  log "  Destination folder:   G-${GMAIL_SOURCE_USER}/${FOLDER}"
  log "  Messages found:       ${msg_count}"
  log "  Estimated bytes:      $(bytes_human "${total_bytes:-0}")"
  log "  Errors:               ${err_count}"
  log ""
  log "⚠️  DRY RUN — no messages written to destination."
}

# ─────────────────────────────────────────────────────────────────────────────
# Strategy: random
# ─────────────────────────────────────────────────────────────────────────────
run_random_test() {
  header "Random Sample Dry-Run — ${SAMPLE_SIZE} emails from '${FOLDER}'"
  log "Sampling ${SAMPLE_SIZE} random UIDs from '${FOLDER}'..."

  local uids
  uids=$(python3 - << EOF
import imaplib, random, os, sys

folder  = os.environ.get("FOLDER", "INBOX")
n       = int(os.environ.get("SAMPLE_SIZE", "50"))
user    = os.environ["GMAIL_SOURCE_USER"]
passwd  = os.environ["GMAIL_SOURCE_APP_PASS"]

try:
    M = imaplib.IMAP4_SSL("imap.gmail.com")
    M.login(user, passwd)
    M.select(f'"{folder}"', readonly=True)
    _, data = M.uid("search", None, "ALL")
    all_uids = data[0].split() if data[0] else []
    total = len(all_uids)
    sample = random.sample(all_uids, min(n, total))
    uid_str = ",".join(u.decode() for u in sample)
    print(f"TOTAL:{total}")
    print(f"UIDS:{uid_str}")
    M.logout()
except Exception as e:
    print(f"ERROR:{e}", file=sys.stderr)
    sys.exit(1)
EOF
  ) || { log "ERROR: UID sampling failed."; return 1; }

  local total_count uid_str
  total_count=$(echo "$uids" | grep "^TOTAL:" | cut -d: -f2)
  uid_str=$(echo "$uids" | grep "^UIDS:" | cut -d: -f2)

  if [ -z "$uid_str" ]; then
    log "ERROR: No UIDs sampled from folder '${FOLDER}'."
    return 1
  fi

  log "Total messages in folder: ${total_count}"
  log "Sampled UIDs (first 80 chars): ${uid_str:0:80}..."

  # Dry-run with sampled UIDs
  local logfile="test-random.log"
  eval imapsync \
    $(base_imapsync_args) \
    --folder "'${FOLDER}'" \
    --search "'UID ${uid_str}'" \
    > "$logfile" 2>&1 || true

  local msg_count total_bytes
  msg_count=$(grep -c "^Msg " "$logfile" 2>/dev/null || echo 0)
  total_bytes=$(grep "^Msg " "$logfile" 2>/dev/null | awk '{sum+=$6} END{print sum+0}')

  log ""
  log "  Messages sampled:     ${msg_count} / ${SAMPLE_SIZE} requested"
  log "  Estimated bytes:      $(bytes_human "${total_bytes:-0}")"
  log "  Source folder:        ${FOLDER}"
  log "  Destination folder:   G-${GMAIL_SOURCE_USER}/${FOLDER}"
  log ""
  log "⚠️  DRY RUN — no messages written to destination."

  # Verify header integrity for sampled messages
  log ""
  log "Running header integrity check on sample..."
  python3 - "$uid_str" << 'EOF'
import imaplib, os, email, sys

uid_str = sys.argv[1]
uids = uid_str.split(",")[:10]  # check first 10

user   = os.environ["GMAIL_SOURCE_USER"]
passwd = os.environ["GMAIL_SOURCE_APP_PASS"]
folder = os.environ.get("FOLDER", "INBOX")

try:
    M = imaplib.IMAP4_SSL("imap.gmail.com")
    M.login(user, passwd)
    M.select(f'"{folder}"', readonly=True)

    verified = 0
    for uid in uids:
        _, msg_data = M.uid("fetch", uid.encode(), "(BODY[HEADER.FIELDS (SUBJECT DATE MESSAGE-ID)])")
        if msg_data and msg_data[0]:
            raw = msg_data[0][1] if isinstance(msg_data[0], tuple) else b""
            msg = email.message_from_bytes(raw)
            subj = (msg.get("Subject") or "")[:60]
            mid  = (msg.get("Message-ID") or "N/A")[:50]
            print(f"  UID {uid}: Subject='{subj}' MID={mid}")
            verified += 1
    M.logout()
    print(f"\n  Verified {verified}/{len(uids)} sampled message headers.")
except Exception as e:
    print(f"  ERROR during header check: {e}", file=sys.stderr)
EOF
}

# ─────────────────────────────────────────────────────────────────────────────
# Strategy: integrity
# ─────────────────────────────────────────────────────────────────────────────
run_integrity_check() {
  header "Integrity Check — Source vs ${DEST_ID}"
  log "Comparing message counts per folder..."

  python3 - << 'EOF'
import imaplib, os, sys

def list_folders(host, user, pwd, prefix=""):
    M = imaplib.IMAP4_SSL(host)
    M.login(user, pwd)
    _, folders = M.list()
    result = {}
    for f in (folders or []):
        parts = f.decode().split(' "/" ')
        if len(parts) < 2:
            continue
        name = parts[-1].strip().strip('"')
        if prefix and not name.startswith(prefix):
            continue
        try:
            _, data = M.select(f'"{name}"', readonly=True)
            count = int(data[0]) if data[0] and data[0].isdigit() else 0
            result[name] = count
        except Exception:
            result[name] = "ERR"
    M.logout()
    return result

src_user  = os.environ["GMAIL_SOURCE_USER"]
src_pass  = os.environ["GMAIL_SOURCE_APP_PASS"]
dst_user  = os.environ["GMAIL_DEST_USER"]
dst_pass  = os.environ["GMAIL_DEST_APP_PASS"]
prefix    = f"G-{src_user}/"

print(f"\n  Comparing source vs destination (prefix: {prefix})\n")

src_folders = list_folders("imap.gmail.com", src_user, src_pass)
dst_folders = list_folders("imap.gmail.com", dst_user, dst_pass, prefix)

# Remap destination names to source equivalents
dst_remap = {
    k[len(prefix):]: v
    for k, v in dst_folders.items()
    if k.startswith(prefix)
}

SKIP = {"[Gmail]/All Mail", "[Gmail]/Spam", "[Gmail]/Trash"}
all_match = True

print(f"  {'Source Folder':<40} {'Src':>6} {'Dst':>6} {'Status'}")
print(f"  {'-'*40} {'---':>6} {'---':>6} {'------'}")

for folder, src_count in sorted(src_folders.items()):
    if folder in SKIP:
        continue
    dst_count = dst_remap.get(folder, "MISSING")
    if dst_count == "MISSING":
        status = "⚠️  NOT MIGRATED"
        all_match = False
    elif isinstance(src_count, int) and isinstance(dst_count, int):
        delta = src_count - dst_count
        if delta == 0:
            status = "✅ MATCH"
        elif delta > 0:
            status = f"⚠️  DELTA: -{delta}"
            all_match = False
        else:
            status = f"⚠️  EXTRA: +{abs(delta)}"
    else:
        status = f"ERR src={src_count}"
        all_match = False

    print(f"  {folder:<40} {str(src_count):>6} {str(dst_count):>6} {status}")

print()
if all_match:
    print("  ✅ All folders match.")
else:
    print("  ⚠️  Some folders have deltas — additional migration runs needed.")
    sys.exit(1)
EOF
}

# ─────────────────────────────────────────────────────────────────────────────
# Generate output report
# ─────────────────────────────────────────────────────────────────────────────
write_summary() {
  local status="$1"
  case "$OUTPUT_FORMAT" in
    markdown)
      cat >> "$GITHUB_STEP_SUMMARY" << EOF
## Test Report — ${STRATEGY} strategy (${DEST})

| Field | Value |
|-------|-------|
| Strategy | \`${STRATEGY}\` |
| Destination | ${DEST} |
| Dry-run | ${DRY_RUN} |
| Status | ${status} |

See \`${REPORT_FILE}\` artifact for full details.
EOF
      ;;
    json)
      python3 -c "
import json, datetime
print(json.dumps({
    'strategy': '${STRATEGY}',
    'dest': '${DEST}',
    'dry_run': ${DRY_RUN},
    'status': '${status}',
    'timestamp': datetime.datetime.utcnow().isoformat()
}, indent=2))"
      ;;
    *)
      log ""
      log "Test completed — strategy: ${STRATEGY} | dest: ${DEST} | status: ${status}"
      ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
main() {
  > "$REPORT_FILE"  # reset report

  header "Gmail IMAP Migration — Test Runner"
  log "Strategy:     ${STRATEGY}"
  log "Destination:  ${DEST}"
  log "Dry-run:      ${DRY_RUN}"
  log "Timestamp:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Connection tests
  header "Connection Tests"
  test_connection "imap.gmail.com" "$GMAIL_SOURCE_USER" "$GMAIL_SOURCE_APP_PASS" "Source"
  test_connection "imap.gmail.com" "$GMAIL_DEST_USER"   "$GMAIL_DEST_APP_PASS"   "Destination ($DEST)"

  # Export FOLDER and SAMPLE_SIZE for python subprocesses
  export FOLDER="$FOLDER"
  export SAMPLE_SIZE="$SAMPLE_SIZE"

  # Strategy execution
  local exit_code=0
  case "$STRATEGY" in
    size)       run_size_test      || exit_code=$? ;;
    folder)     run_folder_test    || exit_code=$? ;;
    random)     run_random_test    || exit_code=$? ;;
    integrity)  run_integrity_check || exit_code=$? ;;
    *) log "ERROR: Unknown strategy '${STRATEGY}'"; exit 1 ;;
  esac

  local status
  (( exit_code == 0 )) && status="pass" || status="fail"

  write_summary "$status"

  log ""
  log "Report saved to: ${REPORT_FILE}"
  exit "$exit_code"
}

main "$@"
