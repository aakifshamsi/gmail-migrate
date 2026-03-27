#!/usr/bin/env python3
"""
Cleanup script — delete migrated mail from source after verifying both destinations.
Uses Python's imaplib (no imapsync needed).
"""
import imaplib
import os
import sys
import email
from datetime import datetime, timezone

SKIP_FOLDERS = {"[Gmail]/All Mail", "[Gmail]/Spam", "[Gmail]/Trash"}

def connect(host, user, pwd):
    M = imaplib.IMAP4_SSL(host, 993)
    M.login(user, pwd)
    return M

def get_folder_counts(M, prefix_filter=""):
    _, folders = M.list()
    counts = {}
    for f in (folders or []):
        parts = f.decode().split(' "/" ')
        if len(parts) < 2:
            continue
        name = parts[-1].strip().strip('"')
        if prefix_filter and not name.startswith(prefix_filter):
            continue
        try:
            status, data = M.select(f'"{name}"', readonly=True)
            counts[name] = int(data[0]) if status == "OK" and data[0] and data[0].isdigit() else 0
        except Exception:
            pass
    return counts

def delete_messages_in_folder(M, folder):
    """Move all messages in folder to Trash."""
    try:
        status, data = M.select(f'"{folder}"')
        if status != "OK":
            return 0
        count = int(data[0]) if data[0] and data[0].isdigit() else 0
        if count == 0:
            return 0

        # Mark all for deletion
        status, data = M.search(None, "ALL")
        if status != "OK" or not data[0]:
            return 0
        msg_nums = data[0].decode().split()
        deleted = 0
        for num in msg_nums:
            try:
                M.store(num, "+FLAGS", "\\Deleted")
                deleted += 1
            except Exception:
                pass
        M.expunge()
        return deleted
    except Exception as e:
        print(f"  Error deleting from {folder}: {e}")
        return 0

def main():
    src_user = os.environ["GMAIL_SOURCE_USER"]
    src_pass = os.environ["GMAIL_SOURCE_APP_PASS"]
    d1_user  = os.environ["GMAIL_DEST1_USER"]
    d1_pass  = os.environ["GMAIL_DEST1_APP_PASS"]
    d2_user  = os.environ["GMAIL_DEST2_USER"]
    d2_pass  = os.environ["GMAIL_DEST2_APP_PASS"]
    prefix   = f"G-{src_user}/"

    action = os.environ.get("CLEANUP_ACTION", "verify")

    print(f"Connecting to source: {src_user}")
    src_M = connect("imap.gmail.com", src_user, src_pass)
    src = get_folder_counts(src_M)

    print(f"Connecting to dest1: {d1_user}")
    d1_M = connect("imap.gmail.com", d1_user, d1_pass)
    d1 = get_folder_counts(d1_M, prefix)

    print(f"Connecting to dest2: {d2_user}")
    d2_M = connect("imap.gmail.com", d2_user, d2_pass)
    d2 = get_folder_counts(d2_M, prefix)

    d1r = {k[len(prefix):]: v for k, v in d1.items() if k.startswith(prefix)}
    d2r = {k[len(prefix):]: v for k, v in d2.items() if k.startswith(prefix)}

    safe = True
    print(f"\n{'Folder':<40} {'Src':>6} {'D1':>6} {'D2':>6} {'Safe?'}")
    print(f"{'-'*40} {'---':>6} {'---':>6} {'---':>6} {'-----'}")

    for folder, src_count in sorted(src.items()):
        if folder in SKIP_FOLDERS:
            continue
        d1c = d1r.get(folder, 0)
        d2c = d2r.get(folder, 0)
        ok = d1c >= src_count and d2c >= src_count
        status = "OK" if ok else "SKIP"
        if not ok:
            safe = False
        print(f"{folder:<40} {src_count:>6} {d1c:>6} {d2c:>6} {status}")

    print()
    if not safe:
        print("NOT safe to delete — some folders have deltas.")
        src_M.logout(); d1_M.logout(); d2_M.logout()
        sys.exit(1)

    print("Both destinations verified OK.")

    if action == "delete":
        print("\n=== DELETING messages from source ===")
        total_deleted = 0
        for folder in sorted(src.keys()):
            if folder in SKIP_FOLDERS:
                continue
            if src.get(folder, 0) == 0:
                continue
            print(f"  Deleting {folder} ({src[folder]} messages)...")
            deleted = delete_messages_in_folder(src_M, folder)
            total_deleted += deleted
            print(f"    Deleted: {deleted}")
        print(f"\nTotal deleted: {total_deleted}")
    elif action == "dry-run":
        print("\nDRY RUN — no messages deleted.")
        print("Folders that would be deleted:")
        for folder in sorted(src.keys()):
            if folder not in SKIP_FOLDERS and src.get(folder, 0) > 0:
                print(f"  {folder}: {src[folder]} messages")

    src_M.logout()
    d1_M.logout()
    d2_M.logout()
    print("\nDone.")

if __name__ == "__main__":
    main()
