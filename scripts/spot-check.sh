#!/usr/bin/env bash
# spot-check.sh — Migration integrity verification
# Read-only IMAP spot-checks that emails exist in BOTH destination accounts.
# Exit codes: 0=pass (>99%), 1=warn (>95%), 2=fail (<95%)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# --- Required env vars ---
for v in GMAIL_SOURCE_USER GMAIL_SOURCE_APP_PASS \
         GMAIL_DEST1_USER GMAIL_DEST1_APP_PASS \
         GMAIL_DEST2_USER GMAIL_DEST2_APP_PASS; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: env var $v is not set" >&2
    exit 3
  fi
done

# --- Defaults ---
NTFY_URL="${NTFY_URL:-https://ntfy.sh/abbsjai}"
NTFY_TOPIC="${NTFY_TOPIC:-abbsjai}"

# --- Run the Python checker ---
python3 - "$@" <<'PYEOF'
import imaplib
import json
import os
import sys
import random
import ssl
import urllib.request
import urllib.error
from datetime import datetime, timezone
from email.header import decode_header

# ── Config ──────────────────────────────────────────────────────────────
IMAP_HOST = "imap.gmail.com"
IMAP_PORT = 993
TIMEOUT = 30  # seconds per connection

SRC_USER = os.environ["GMAIL_SOURCE_USER"]
SRC_PASS = os.environ["GMAIL_SOURCE_APP_PASS"]
D1_USER  = os.environ["GMAIL_DEST1_USER"]
D1_PASS  = os.environ["GMAIL_DEST1_APP_PASS"]
D2_USER  = os.environ["GMAIL_DEST2_USER"]
D2_PASS  = os.environ["GMAIL_DEST2_APP_PASS"]

NTFY_URL   = os.environ.get("NTFY_URL", "https://ntfy.sh/abbsjai")
NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "abbsjai")

# ── State file discovery ───────────────────────────────────────────────
def find_state_files():
    """Find migration state files in the project directory."""
    project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    states = []
    for name in ("migration-state-dest1.json", "migration-state-dest2.json"):
        path = os.path.join(project_dir, name)
        if os.path.exists(path):
            with open(path) as f:
                states.append(json.load(f))
    return states

# ── Aggressiveness ─────────────────────────────────────────────────────
def check_ratio(total_emails: int) -> float:
    """Return fraction of messages to spot-check based on volume."""
    if total_emails <= 100:
        return 0.50
    elif total_emails <= 500:
        return 0.20
    elif total_emails <= 2000:
        return 0.10
    else:
        return 0.05

def sample_size(total_emails: int) -> int:
    ratio = check_ratio(total_emails)
    n = max(1, int(total_emails * ratio))
    # For 2000+ we guarantee at least 100 checks
    if total_emails > 2000:
        n = max(n, 100)
    return n

# ── IMAP helpers ───────────────────────────────────────────────────────
def connect(user: str, password: str) -> imaplib.IMAP4_SSL:
    ctx = ssl.create_default_context()
    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, timeout=TIMEOUT, ssl_context=ctx)
    conn.login(user, password)
    return conn

def get_completed_folders(states: list) -> dict:
    """Return {folder: email_count} for folders completed in both states."""
    # Collect folders that appear in both state files
    folder_counts = {}
    for state in states:
        # A folder is "completed" if status is not in_progress or if
        # last_folder is set with processed_emails > 0
        pass  # We'll list all folders from source instead
    
    return folder_counts

def list_folders(conn: imaplib.IMAP4_SSL) -> list:
    """List all selectable folders (skip [Gmail]/* system ones, include INBOX)."""
    status, data = conn.list()
    folders = []
    if status != "OK":
        return folders
    for item in data:
        if isinstance(item, bytes):
            # Parse: (\\HasNoChildren) "/" "INBOX"
            line = item.decode("utf-8", errors="replace")
            # Extract folder name (last quoted or unquoted part)
            # Skip \Noselect flags
            if "\\Noselect" in line:
                continue
            # Get folder name: last space-separated token or last quoted string
            parts = line.split(' "/" ', 1)
            if len(parts) == 2:
                folder_name = parts[1].strip().strip('"')
            else:
                parts = line.split(' "." ', 1)
                if len(parts) == 2:
                    folder_name = parts[1].strip().strip('"')
                else:
                    # Fallback: last word
                    folder_name = line.split()[-1].strip().strip('"')
            folders.append(folder_name)
    return folders

def get_message_ids(conn: imaplib.IMAP4_SSL, folder: str, limit: int = 0) -> list:
    """
    Select a folder and return list of (uid, message_id_header) for all messages.
    """
    # Select folder (quote if contains spaces)
    safe_folder = f'"{folder}"' if ' ' in folder else folder
    status, _ = conn.select(safe_folder, readonly=True)
    if status != "OK":
        return []
    
    status, data = conn.search(None, "ALL")
    if status != "OK" or not data[0]:
        return []
    
    uid_str = data[0].decode()
    if not uid_str.strip():
        return []
    
    uids = uid_str.split()
    if limit and len(uids) > limit:
        uids = random.sample(uids, limit)
    
    results = []
    for uid in uids:
        status, msg_data = conn.fetch(uid, "(BODY[HEADER.FIELDS (MESSAGE-ID)])")
        if status != "OK" or not msg_data or not msg_data[0]:
            results.append((uid.decode() if isinstance(uid, bytes) else uid, None))
            continue
        # Extract Message-ID from response
        raw = msg_data[0]
        if isinstance(raw, tuple) and len(raw) >= 2:
            header_bytes = raw[1]
            header_str = header_bytes.decode("utf-8", errors="replace")
            # Parse: "Message-ID: <xxx@yyy>\r\n"
            mid = header_str.replace("Message-ID:", "", 1).strip().strip().rstrip("\r\n").strip()
            if mid:
                results.append((uid.decode() if isinstance(uid, bytes) else uid, mid))
            else:
                results.append((uid.decode() if isinstance(uid, bytes) else uid, None))
        else:
            results.append((uid.decode() if isinstance(uid, bytes) else uid, None))
    
    return results

def search_message_id(conn: imaplib.IMAP4_SSL, folder: str, message_id: str) -> bool:
    """Search for a specific Message-ID in a folder. Returns True if found."""
    safe_folder = f'"{folder}"' if ' ' in folder else folder
    status, _ = conn.select(safe_folder, readonly=True)
    if status != "OK":
        return False
    
    # Escape Message-ID for IMAP SEARCH
    # Message-IDs contain < > which need to be handled
    escaped_mid = message_id.replace("\\", "\\\\").replace('"', '\\"')
    status, data = conn.search(None, f'HEADER Message-ID "{escaped_mid}"')
    if status != "OK" or not data[0]:
        return False
    return bool(data[0].decode().strip())

def notify_ntfy(title: str, message: str, tags: str = ""):
    """Send a notification via ntfy.sh."""
    try:
        topic_url = NTFY_URL.rstrip("/") if NTFY_URL else f"https://ntfy.sh/{NTFY_TOPIC}"
        req = urllib.request.Request(
            topic_url,
            data=message.encode("utf-8"),
            method="POST",
            headers={
                "Title": title,
                "Priority": "high" if "FAIL" in title else "default",
                "Tags": tags,
            },
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"WARNING: ntfy notification failed: {e}", file=sys.stderr)

# ── Main ────────────────────────────────────────────────────────────────
def main():
    random.seed()  # True random for sampling
    
    # 1. Load state files to estimate total migrated
    states = find_state_files()
    total_migrated = 0
    for state in states:
        total_migrated = max(total_migrated, state.get("processed_emails", 0))
    
    # If state says 0, use a reasonable default for checking
    if total_migrated == 0:
        total_migrated = 50  # Default to checking what we can
    
    n_to_check = sample_size(total_migrated)
    
    print(f"INFO: total_migrated={total_migrated}, checking {n_to_check} messages", file=sys.stderr)
    
    # 2. Connect to source
    try:
        src = connect(SRC_USER, SRC_PASS)
    except Exception as e:
        print(f"FATAL: cannot connect to source: {e}", file=sys.stderr)
        sys.exit(3)
    
    # 3. List source folders
    folders = list_folders(src)
    if not folders:
        # Try INBOX as fallback
        folders = ["INBOX"]
    
    # Filter out [Gmail] system folders but keep INBOX
    folders = [f for f in folders if not f.startswith("[Gmail]/") or f == "[Gmail]/All Mail"]
    if not folders:
        folders = ["INBOX"]
    
    print(f"INFO: checking folders: {folders}", file=sys.stderr)
    
    # 4. Collect messages from source across folders
    all_messages = []  # [(uid, folder, message_id)]
    for folder in folders:
        msgs = get_message_ids(src, folder)
        for uid, mid in msgs:
            if mid:
                all_messages.append((uid, folder, mid))
    
    if not all_messages:
        print("WARNING: no messages found in source", file=sys.stderr)
        # Output minimal report
        report = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "total_checked": 0,
            "dest1_found": 0,
            "dest2_found": 0,
            "dest1_missing": 0,
            "dest2_missing": 0,
            "dest1_integrity_pct": 100.0,
            "dest2_integrity_pct": 100.0,
            "missing_samples": [],
            "status": "pass",
        }
        print(json.dumps(report, indent=2))
        src.logout()
        sys.exit(0)
    
    # 5. Sample messages to check
    n_to_check = min(n_to_check, len(all_messages))
    sample = random.sample(all_messages, n_to_check)
    
    print(f"INFO: sampled {len(sample)} from {len(all_messages)} total messages", file=sys.stderr)
    
    # 6. Connect to destinations
    try:
        d1 = connect(D1_USER, D1_PASS)
    except Exception as e:
        print(f"FATAL: cannot connect to dest1: {e}", file=sys.stderr)
        src.logout()
        sys.exit(3)
    
    try:
        d2 = connect(D2_USER, D2_PASS)
    except Exception as e:
        print(f"FATAL: cannot connect to dest2: {e}", file=sys.stderr)
        src.logout()
        d1.logout()
        sys.exit(3)
    
    # 7. For destination accounts, the migrated folders have "G-" prefix
    def dest_folder_name(src_folder: str) -> str:
        """Map source folder to destination folder name with G- prefix."""
        if src_folder == "INBOX":
            return "G-INBOX"
        return f"G-{src_folder}"
    
    # 8. Check each sampled message in both destinations
    dest1_found = 0
    dest2_found = 0
    dest1_missing = 0
    dest2_missing = 0
    missing_samples = []
    
    for i, (uid, folder, message_id) in enumerate(sample):
        if (i + 1) % 10 == 0 or i == 0:
            print(f"INFO: checking message {i+1}/{len(sample)}", file=sys.stderr)
        
        d_folder = dest_folder_name(folder)
        
        # Check dest1
        found_d1 = search_message_id(d1, d_folder, message_id)
        if found_d1:
            dest1_found += 1
        else:
            dest1_missing += 1
            if len(missing_samples) < 20:  # Keep up to 20 samples
                missing_samples.append({
                    "uid": uid,
                    "folder": folder,
                    "message_id": message_id,
                    "missing_from": "dest1",
                })
        
        # Check dest2
        found_d2 = search_message_id(d2, d_folder, message_id)
        if found_d2:
            dest2_found += 1
        else:
            dest2_missing += 1
            if len(missing_samples) < 20:
                missing_samples.append({
                    "uid": uid,
                    "folder": folder,
                    "message_id": message_id,
                    "missing_from": "dest2",
                })
    
    # 9. Calculate integrity
    total = len(sample)
    d1_pct = round((dest1_found / total) * 100, 2) if total > 0 else 100.0
    d2_pct = round((dest2_found / total) * 100, 2) if total > 0 else 100.0
    
    # 10. Determine status
    min_pct = min(d1_pct, d2_pct)
    if min_pct > 99.0:
        status = "pass"
    elif min_pct > 95.0:
        status = "warn"
    else:
        status = "fail"
    
    # 11. Build report
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total_checked": total,
        "dest1_found": dest1_found,
        "dest2_found": dest2_found,
        "dest1_missing": dest1_missing,
        "dest2_missing": dest2_missing,
        "dest1_integrity_pct": d1_pct,
        "dest2_integrity_pct": d2_pct,
        "missing_samples": missing_samples,
        "status": status,
    }
    
    print(json.dumps(report, indent=2))
    
    # 12. Send ntfy notification
    if status == "pass":
        notify_ntfy(
            "✅ Spot check: migration integrity OK",
            f"✅ Spot check: dest1={d1_pct}%, dest2={d2_pct}% integrity ({total} checked)",
            "white_check_mark",
        )
    elif status == "warn":
        notify_ntfy(
            "⚠️ Spot check warning",
            f"⚠️ Spot check warning: dest1={d1_pct}%, dest2={d2_pct}% — some messages missing ({total} checked)",
            "warning",
        )
    else:
        notify_ntfy(
            "❌ Spot check FAIL",
            f"❌ Spot check FAIL: dest1={d1_pct}%, dest2={d2_pct}% — significant data loss detected ({total} checked)",
            "rotating_light",
        )
    
    # 13. Cleanup connections
    try:
        src.logout()
    except Exception:
        pass
    try:
        d1.logout()
    except Exception:
        pass
    try:
        d2.logout()
    except Exception:
        pass
    
    # 14. Exit code
    if status == "pass":
        sys.exit(0)
    elif status == "warn":
        sys.exit(1)
    else:
        sys.exit(2)

if __name__ == "__main__":
    main()
PYEOF
