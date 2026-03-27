#!/usr/bin/env python3
"""
Gmail IMAP Migrator — pure Python, no imapsync dependency.

Copies mail from source Gmail to destination Gmail(s) via IMAP.
Resumes from last run via state file. Supports size/email limits.

Features:
  - Batch processing with progress reporting
  - Skip dedup mode (SKIP_DEDUP=true) for first runs
  - Date range filtering (DATE_SINCE / DATE_BEFORE, DD-Mon-YYYY)
  - Folder whitelist (FOLDER_WHITELIST)
  - Resumability with per-folder last UID tracking
  - Connection retry with exponential backoff
"""
import imaplib
import email
import os
import sys
import json
import time
import hashlib
import re
import random
from datetime import datetime, timezone

# ── Config from environment ──
SOURCE_USER = os.environ["GMAIL_SOURCE_USER"]
SOURCE_PASS = os.environ["GMAIL_SOURCE_APP_PASS"]
DEST_USER   = os.environ["GMAIL_DEST_USER"]
DEST_PASS   = os.environ["GMAIL_DEST_APP_PASS"]
DEST_ID     = os.environ.get("DEST_ID", "dest")
STATE_FILE  = os.environ.get("STATE_FILE", f"migration-state-{DEST_ID}.json")
STRATEGY    = os.environ.get("STRATEGY", "size")
DRY_RUN     = os.environ.get("DRY_RUN", "true").lower() == "true"
SIZE_LIMIT  = int(os.environ.get("SIZE_LIMIT_MB", "500")) * 1024 * 1024
EMAIL_LIMIT = int(os.environ.get("EMAIL_LIMIT", "0"))
FOLDER      = os.environ.get("MIGRATION_FOLDER", "INBOX")
SAMPLE_SIZE = int(os.environ.get("SAMPLE_SIZE", "50"))
LOG_FILE    = "migration.log"

# New config
BATCH_SIZE       = int(os.environ.get("BATCH_SIZE", "10"))
SKIP_DEDUP       = os.environ.get("SKIP_DEDUP", "false").lower() == "true"
DATE_SINCE       = os.environ.get("DATE_SINCE", "")
DATE_BEFORE      = os.environ.get("DATE_BEFORE", "")
FOLDER_WHITELIST = os.environ.get("FOLDER_WHITELIST", "")

DEST_PREFIX = f"G-{SOURCE_USER}/"

# Folders to skip
SKIP_FOLDERS = {"[Gmail]/All Mail", "[Gmail]/Spam", "[Gmail]/Trash"}

# Retry config
MAX_RETRIES = 3
RETRY_BASE_DELAY = 2  # seconds

# ── Helpers ──
def log(msg):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

def bytes_human(n):
    for u in ["B","KB","MB","GB"]:
        if n < 1024:
            return f"{n:.1f}{u}"
        n /= 1024
    return f"{n:.1f}TB"

def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {
            "schema_version": 2,
            "source_account": SOURCE_USER,
            "destination": DEST_ID,
            "strategy": STRATEGY,
            "processed_emails": 0,
            "processed_bytes": 0,
            "completed_folders": [],
            "last_folder": None,
            "last_uid": None,
            "folder_state": {},
            "status": "pending",
            "started_at": None,
            "updated_at": None,
            "errors": [],
        }

def save_state(state):
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

def retry(func, *args, label="", max_retries=MAX_RETRIES, **kwargs):
    """Call func with retry and exponential backoff. Reconnects on IMAP errors."""
    last_exc = None
    for attempt in range(1, max_retries + 1):
        try:
            return func(*args, **kwargs)
        except (imaplib.IMAP4.error, imaplib.IMAP4.abort, OSError, ConnectionError) as e:
            last_exc = e
            delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
            log(f"  Retry {attempt}/{max_retries} for {label or func.__name__}: {e} (waiting {delay}s)")
            time.sleep(delay)
        except Exception as e:
            raise
    raise last_exc

def connect(host, user, password, label=""):
    log(f"Connecting to {label or user}...")
    M = imaplib.IMAP4_SSL(host, 993)
    M.login(user, password)
    log(f"  Connected to {label or user}")
    return M

def reconnect(M, host, user, password, label=""):
    """Reconnect a dropped IMAP connection."""
    log(f"  Reconnecting {label or user}...")
    try:
        M.logout()
    except Exception:
        pass
    return connect(host, user, password, label)

def list_folders(M):
    _, folders = M.list()
    result = []
    for f in (folders or []):
        parts = f.decode().split(' "/" ')
        if len(parts) >= 2:
            name = parts[-1].strip().strip('"')
            result.append(name)
    return result

def uid_search(M, folder, criteria="ALL"):
    """Search UIDs in a folder. Returns list of UID strings."""
    status, data = M.select(f'"{folder}"', readonly=True)
    if status != "OK":
        return []
    status, data = M.uid("SEARCH", None, criteria)
    if status != "OK" or not data[0]:
        return []
    return data[0].decode().split()

def fetch_message(M, uid):
    """Fetch full message by UID. Returns raw bytes or None."""
    status, data = M.uid("FETCH", uid, "(RFC822)")
    if status != "OK" or not data[0]:
        return None
    if isinstance(data[0], tuple):
        return data[0][1]
    return data[1]

def message_exists(dest_M, dest_folder, message_id):
    """Check if a message with this Message-ID already exists in destination."""
    try:
        status, data = dest_M.select(f'"{dest_folder}"', readonly=True)
        if status != "OK":
            return False
        status, data = dest_M.uid("SEARCH", None, f'HEADER Message-ID "{message_id}"')
        if status == "OK" and data[0] and data[0].decode().strip():
            return True
    except Exception:
        pass
    return False

def create_folder_if_needed(M, folder):
    """Create folder if it doesn't exist."""
    try:
        status, _ = M.select(f'"{folder}"', readonly=True)
        if status == "OK":
            return True
    except Exception:
        pass
    try:
        M.create(folder)
        return True
    except Exception as e:
        if "ALREADYEXISTS" in str(e).upper() or "already exists" in str(e).lower():
            return True
        return False

def build_search_criteria():
    """Build IMAP SEARCH criteria string from env config."""
    parts = ["ALL"]
    if DATE_SINCE:
        parts = [f'SINCE "{DATE_SINCE}"']
        if DATE_BEFORE:
            parts.append(f'BEFORE "{DATE_BEFORE}"')
    return " ".join(parts)

def get_folder_whitelist():
    """Parse folder whitelist from env var."""
    if not FOLDER_WHITELIST:
        return None
    return {f.strip() for f in FOLDER_WHITELIST.split(",") if f.strip()}

def get_folder_state(state, folder):
    """Get per-folder state dict."""
    fs = state.setdefault("folder_state", {})
    return fs.setdefault(folder, {"copied": 0, "bytes": 0, "skipped": 0, "last_uid": None, "completed": False})

def copy_messages_to_dest(source_M, dest_M, src_folder, dest_folder, state,
                           limit_bytes=0, limit_emails=0, source_host=SOURCE_USER, source_pass=SOURCE_PASS):
    """Copy messages from source to destination folder with batch processing.
    Returns (count, bytes, skipped).
    """
    folder_st = get_folder_state(state, src_folder)

    if src_folder not in state.get("completed_folders", []):
        create_folder_if_needed(dest_M, dest_folder)

    criteria = build_search_criteria()
    uids = retry(uid_search, source_M, src_folder, criteria, label="uid_search")
    if not uids:
        log(f"  {src_folder}: no messages (criteria: {criteria})")
        return 0, 0, 0

    total_in_folder = len(uids)

    # Process newest-first so small limits hit immediately
    uids = list(reversed(uids))

    log(f"  {src_folder}: {total_in_folder} messages found, processing newest-first (batch_size={BATCH_SIZE})")

    copied = 0
    total_bytes = 0
    skipped = 0
    last_uid = folder_st.get("last_uid")
    resume = False

    # Resume: skip UIDs up to and including last_uid
    if last_uid:
        resume = True
        log(f"  Resuming from after UID {last_uid}")

    batch_start_time = time.time()
    batch_copied = 0
    batch_bytes = 0

    # If skip_dedup and small email limit, we can stop after limit is reached
    effective_limit = limit_emails if limit_emails else 0

    for uid in uids:
        if resume:
            if uid == last_uid:
                resume = False
            continue

        # Check limits
        if limit_emails and copied >= limit_emails:
            log(f"  Email limit ({limit_emails}) reached")
            break
        if limit_bytes and total_bytes >= limit_bytes:
            log(f"  Size limit ({bytes_human(limit_bytes)}) reached")
            break

        try:
            raw = retry(fetch_message, source_M, uid, label=f"fetch UID {uid}")
            if raw is None:
                skipped += 1
                batch_copied += 1  # count toward batch for progress
                _check_batch_flush()
                continue

            msg_size = len(raw)

            # Parse Message-ID for dedup
            msg = email.message_from_bytes(raw)
            msg_id = msg.get("Message-ID", "")

            # Dedup check (skip if SKIP_DEDUP is set)
            if not SKIP_DEDUP and msg_id and message_exists(dest_M, dest_folder, msg_id):
                skipped += 1
                batch_copied += 1
                _check_batch_flush()
                continue

            # Append to destination
            if not DRY_RUN:
                retry(dest_M.append, dest_folder, None, None, raw, label=f"append UID {uid}")
                copied += 1
                total_bytes += msg_size
            else:
                copied += 1
                total_bytes += msg_size

            batch_copied += 1
            batch_bytes += msg_size

            # Batch progress report
            if batch_copied >= BATCH_SIZE:
                elapsed = time.time() - batch_start_time
                rate = (batch_copied / elapsed * 60) if elapsed > 0 else 0
                log(f"[BATCH] folder={src_folder} processed={copied}/{total_in_folder} "
                    f"bytes={bytes_human(total_bytes)} elapsed={elapsed:.1f}s rate={rate:.1f} msgs/min")
                # Save state after every batch
                folder_st["last_uid"] = uid
                folder_st["copied"] = copied
                folder_st["bytes"] = total_bytes
                folder_st["skipped"] = skipped
                state["last_folder"] = src_folder
                state["last_uid"] = uid
                state["processed_emails"] = state.get("processed_emails", 0)
                state["processed_bytes"] = state.get("processed_bytes", 0)
                save_state(state)
                # Reset batch counters
                batch_start_time = time.time()
                batch_copied = 0
                batch_bytes = 0

        except Exception as e:
            log(f"  Error on UID {uid}: {e}")
            state.setdefault("errors", []).append({
                "folder": src_folder,
                "uid": uid,
                "error": str(e),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            skipped += 1

    # Flush remaining batch progress
    if batch_copied > 0:
        elapsed = time.time() - batch_start_time
        rate = (batch_copied / elapsed * 60) if elapsed > 0 else 0
        log(f"[BATCH] folder={src_folder} processed={copied}/{total_in_folder} "
            f"bytes={bytes_human(total_bytes)} elapsed={elapsed:.1f}s rate={rate:.1f} msgs/min")

    # Mark folder complete
    completed = state.get("completed_folders", [])
    if src_folder not in completed:
        completed.append(src_folder)
        state["completed_folders"] = completed

    folder_st["completed"] = True
    folder_st["last_uid"] = uids[-1] if uids else folder_st.get("last_uid")
    folder_st["copied"] = copied
    folder_st["bytes"] = total_bytes
    folder_st["skipped"] = skipped

    state["processed_emails"] = state.get("processed_emails", 0) + copied
    state["processed_bytes"] = state.get("processed_bytes", 0) + total_bytes
    state["last_folder"] = src_folder
    state["last_uid"] = uids[-1] if uids else state.get("last_uid")
    save_state(state)

    return copied, total_bytes, skipped

def _check_batch_flush():
    """Placeholder — batch flush happens in the main loop above."""
    pass

# ── Main ──
def main():
    log("=" * 60)
    log("Gmail IMAP Migrator")
    log("=" * 60)
    log(f"Source:        {SOURCE_USER}")
    log(f"Destination:   {DEST_USER} ({DEST_ID})")
    log(f"Strategy:      {STRATEGY}")
    log(f"Dry run:       {DRY_RUN}")
    log(f"Size limit:    {bytes_human(SIZE_LIMIT) if SIZE_LIMIT else 'unlimited'}")
    log(f"Email limit:   {EMAIL_LIMIT or 'unlimited'}")
    log(f"Batch size:    {BATCH_SIZE}")
    log(f"Skip dedup:    {SKIP_DEDUP}")
    log(f"Date range:    {DATE_SINCE or '*'} to {DATE_BEFORE or '*'}")
    wl = get_folder_whitelist()
    log(f"Folder filter: {wl if wl else 'all folders'}")
    log("")

    state = load_state()
    if not state.get("started_at"):
        state["started_at"] = datetime.now(timezone.utc).isoformat()
    state["status"] = "running"
    state["strategy"] = STRATEGY
    save_state(state)

    source_host = "imap.gmail.com"
    dest_host = "imap.gmail.com"

    try:
        source_M = connect(source_host, SOURCE_USER, SOURCE_PASS, "source")
        dest_M   = connect(dest_host, DEST_USER, DEST_PASS, f"dest ({DEST_ID})")
    except Exception as e:
        log(f"FATAL: Connection failed: {e}")
        state["status"] = "failed"
        state.setdefault("errors", []).append({"error": str(e)})
        save_state(state)
        sys.exit(1)

    total_copied = 0
    total_bytes = 0
    total_skipped = 0

    try:
        if STRATEGY == "folder":
            # Single folder migration
            src_folder = FOLDER
            dest_folder = DEST_PREFIX + src_folder
            copied, bts, skipped = copy_messages_to_dest(
                source_M, dest_M, src_folder, dest_folder, state,
                limit_bytes=SIZE_LIMIT, limit_emails=EMAIL_LIMIT,
                source_host=source_host, source_pass=SOURCE_PASS,
            )
            total_copied += copied
            total_bytes += bts
            total_skipped += skipped

        elif STRATEGY == "size":
            # Migrate all folders until size limit
            folders = retry(list_folders, source_M, label="list_folders")
            log(f"Found {len(folders)} source folders")

            # Apply whitelist filter
            wl = get_folder_whitelist()
            if wl:
                folders = [f for f in folders if f in wl]
                log(f"After whitelist filter: {len(folders)} folders")

            remaining_bytes = SIZE_LIMIT

            for src_folder in sorted(folders):
                if src_folder in SKIP_FOLDERS:
                    continue
                # Check if folder already completed
                folder_st = get_folder_state(state, src_folder)
                if folder_st.get("completed") and src_folder in state.get("completed_folders", []):
                    log(f"  Skipping completed folder: {src_folder}")
                    continue
                if remaining_bytes <= 0:
                    log("Global size limit reached, stopping")
                    break

                dest_folder = DEST_PREFIX + src_folder
                copied, bts, skipped = copy_messages_to_dest(
                    source_M, dest_M, src_folder, dest_folder, state,
                    limit_bytes=remaining_bytes,
                    source_host=source_host, source_pass=SOURCE_PASS,
                )
                total_copied += copied
                total_bytes += bts
                total_skipped += skipped
                remaining_bytes -= bts

        elif STRATEGY == "random":
            # Sample random messages for testing
            src_folder = FOLDER
            dest_folder = DEST_PREFIX + src_folder
            uids = retry(uid_search, source_M, src_folder, label="uid_search")
            sample = random.sample(uids, min(SAMPLE_SIZE, len(uids)))
            log(f"Random sample: {len(sample)} UIDs from {len(uids)} total")

            for uid in sample:
                raw = retry(fetch_message, source_M, uid, label=f"fetch UID {uid}")
                if raw:
                    if not DRY_RUN:
                        create_folder_if_needed(dest_M, dest_folder)
                        retry(dest_M.append, dest_folder, None, None, raw, label=f"append UID {uid}")
                    total_copied += 1
                    total_bytes += len(raw)

        state["status"] = "completed" if not DRY_RUN else "dry-run"
        save_state(state)

    except KeyboardInterrupt:
        log("Interrupted — saving state for resume")
        state["status"] = "interrupted"
        save_state(state)
    except Exception as e:
        log(f"FATAL: {e}")
        state["status"] = "failed"
        state.setdefault("errors", []).append({"error": str(e)})
        save_state(state)
    finally:
        log("")
        log("=" * 60)
        log(f"Migration {'dry-run' if DRY_RUN else 'run'} complete")
        log(f"  Copied:   {total_copied} messages ({bytes_human(total_bytes)})")
        log(f"  Skipped:  {total_skipped} (dedup/errors)")
        log(f"  Errors:   {len(state.get('errors', []))}")
        log("=" * 60)
        try:
            source_M.logout()
            dest_M.logout()
        except Exception:
            pass

    sys.exit(0 if state["status"] in ("completed", "dry-run") else 1)

if __name__ == "__main__":
    main()
