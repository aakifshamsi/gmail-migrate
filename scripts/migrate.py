#!/usr/bin/env python3
"""
Gmail IMAP Migrator — pure Python, no imapsync dependency.

Copies mail from source Gmail to destination Gmail(s) via IMAP.
Resumes from last run via state file. Supports size/email limits.
"""
import imaplib
import email
import os
import sys
import json
import time
import hashlib
import re
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

DEST_PREFIX = f"G-{SOURCE_USER}/"

# Folders to skip
SKIP_FOLDERS = {"[Gmail]/All Mail", "[Gmail]/Spam", "[Gmail]/Trash"}

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
            "schema_version": 1,
            "source_account": SOURCE_USER,
            "destination": DEST_ID,
            "strategy": STRATEGY,
            "processed_emails": 0,
            "processed_bytes": 0,
            "completed_folders": [],
            "last_folder": None,
            "last_uid": None,
            "status": "pending",
            "started_at": None,
            "updated_at": None,
            "errors": [],
        }

def save_state(state):
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

def connect(host, user, password, label=""):
    log(f"Connecting to {label or user}...")
    M = imaplib.IMAP4_SSL(host, 993)
    M.login(user, password)
    log(f"  Connected to {label or user}")
    return M

def list_folders(M):
    _, folders = M.list()
    result = []
    for f in (folders or []):
        parts = f.decode().split(' "/" ')
        if len(parts) >= 2:
            name = parts[-1].strip().strip('"')
            result.append(name)
    return result

def get_message_count(M, folder):
    try:
        status, data = M.select(f'"{folder}"', readonly=True)
        if status == "OK":
            return int(data[0]) if data[0] and data[0].isdigit() else 0
    except Exception:
        pass
    return 0

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
    """Fetch full message by UID. Returns (uid, raw_bytes, size)."""
    status, data = M.uid("FETCH", uid, "(RFC822)")
    if status != "OK" or not data[0]:
        return None
    # data[0] = (header, (b'RFC822', bytes), b')')
    if isinstance(data[0], tuple):
        raw = data[0][1]
    else:
        raw = data[1]
    return raw

def message_exists(dest_M, dest_folder, message_id):
    """Check if a message with this Message-ID already exists in destination."""
    try:
        status, data = dest_M.select(f'"{dest_folder}"', readonly=True)
        if status != "OK":
            return False
        # Search by HEADER Message-ID
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
        # Folder might already exist
        if "ALREADYEXISTS" in str(e).upper() or "already exists" in str(e).lower():
            return True
        return False

def copy_messages_to_dest(source_M, dest_M, src_folder, dest_folder, state, limit_bytes=0, limit_emails=0):
    """Copy messages from source to destination folder. Returns (count, bytes, skipped)."""
    if dest_folder not in state.get("completed_folders", []):
        create_folder_if_needed(dest_M, dest_folder)

    uids = uid_search(source_M, src_folder)
    if not uids:
        log(f"  {src_folder}: no messages")
        return 0, 0, 0

    log(f"  {src_folder}: {len(uids)} messages to process")

    copied = 0
    total_bytes = 0
    skipped = 0
    last_uid = state.get("last_uid")
    resume = False

    # If resuming, skip UIDs we already processed
    if last_uid and state.get("last_folder") == src_folder:
        resume = True
        log(f"  Resuming from UID {last_uid}")

    for uid in uids:
        if resume and uid == last_uid:
            resume = False
            continue
        if resume:
            continue

        # Check limits
        if limit_emails and copied >= limit_emails:
            log(f"  Email limit ({limit_emails}) reached")
            break
        if limit_bytes and total_bytes >= limit_bytes:
            log(f"  Size limit ({bytes_human(limit_bytes)}) reached")
            break

        try:
            raw = fetch_message(source_M, uid)
            if raw is None:
                skipped += 1
                continue

            msg_size = len(raw)

            # Parse Message-ID for dedup
            msg = email.message_from_bytes(raw)
            msg_id = msg.get("Message-ID", "")

            # Skip if already in destination
            if msg_id and message_exists(dest_M, dest_folder, msg_id):
                skipped += 1
                continue

            # Append to destination
            if not DRY_RUN:
                dest_M.append(dest_folder, None, None, raw)
                copied += 1
                total_bytes += msg_size
            else:
                copied += 1
                total_bytes += msg_size

            # Update state periodically
            if copied % 100 == 0:
                state["processed_emails"] = state.get("processed_emails", 0) + copied
                state["processed_bytes"] = state.get("processed_bytes", 0) + total_bytes
                state["last_folder"] = src_folder
                state["last_uid"] = uid
                save_state(state)
                log(f"  Progress: {copied} copied ({bytes_human(total_bytes)})")

        except Exception as e:
            log(f"  Error on UID {uid}: {e}")
            state.setdefault("errors", []).append({
                "folder": src_folder,
                "uid": uid,
                "error": str(e),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            skipped += 1

    # Mark folder complete
    completed = state.get("completed_folders", [])
    if src_folder not in completed:
        completed.append(src_folder)
        state["completed_folders"] = completed

    state["processed_emails"] = state.get("processed_emails", 0) + copied
    state["processed_bytes"] = state.get("processed_bytes", 0) + total_bytes
    state["last_folder"] = src_folder
    if uids:
        state["last_uid"] = uids[-1]
    save_state(state)

    return copied, total_bytes, skipped

# ── Main ──
def main():
    log("=" * 50)
    log("Gmail IMAP Migrator")
    log("=" * 50)
    log(f"Source:      {SOURCE_USER}")
    log(f"Destination: {DEST_USER} ({DEST_ID})")
    log(f"Strategy:    {STRATEGY}")
    log(f"Dry run:     {DRY_RUN}")
    log(f"Size limit:  {bytes_human(SIZE_LIMIT) if SIZE_LIMIT else 'unlimited'}")
    log(f"Email limit: {EMAIL_LIMIT or 'unlimited'}")
    log("")

    state = load_state()
    if not state.get("started_at"):
        state["started_at"] = datetime.now(timezone.utc).isoformat()
    state["status"] = "running"
    state["strategy"] = STRATEGY
    save_state(state)

    try:
        source_M = connect("imap.gmail.com", SOURCE_USER, SOURCE_PASS, "source")
        dest_M   = connect("imap.gmail.com", DEST_USER, DEST_PASS, f"dest ({DEST_ID})")
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
            )
            total_copied += copied
            total_bytes += bts
            total_skipped += skipped

        elif STRATEGY == "size":
            # Migrate all folders until size limit
            folders = list_folders(source_M)
            log(f"Found {len(folders)} source folders")
            remaining_bytes = SIZE_LIMIT

            for src_folder in sorted(folders):
                if src_folder in SKIP_FOLDERS:
                    continue
                if remaining_bytes <= 0:
                    log("Global size limit reached, stopping")
                    break

                dest_folder = DEST_PREFIX + src_folder
                copied, bts, skipped = copy_messages_to_dest(
                    source_M, dest_M, src_folder, dest_folder, state,
                    limit_bytes=remaining_bytes,
                )
                total_copied += copied
                total_bytes += bts
                total_skipped += skipped
                remaining_bytes -= bts

        elif STRATEGY == "random":
            # Sample random messages for testing
            src_folder = FOLDER
            dest_folder = DEST_PREFIX + src_folder
            uids = uid_search(source_M, src_folder)
            import random
            sample = random.sample(uids, min(SAMPLE_SIZE, len(uids)))
            log(f"Random sample: {len(sample)} UIDs from {len(uids)} total")

            for uid in sample:
                raw = fetch_message(source_M, uid)
                if raw:
                    if not DRY_RUN:
                        create_folder_if_needed(dest_M, dest_folder)
                        dest_M.append(dest_folder, None, None, raw)
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
        log("=" * 50)
        log(f"Migration {'dry-run' if DRY_RUN else 'run'} complete")
        log(f"  Copied:   {total_copied} messages ({bytes_human(total_bytes)})")
        log(f"  Skipped:  {total_skipped} (dedup/errors)")
        log(f"  Errors:   {len(state.get('errors', []))}")
        log("=" * 50)
        try:
            source_M.logout()
            dest_M.logout()
        except Exception:
            pass

    sys.exit(0 if state["status"] in ("completed", "dry-run") else 1)

if __name__ == "__main__":
    main()
