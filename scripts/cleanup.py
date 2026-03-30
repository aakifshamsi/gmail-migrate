#!/usr/bin/env python3
"""
Cleanup script — delete migrated mail from source via Gmail API.
Uses Cloudflare Worker as token authority (same as migrate.py).
No IMAP app passwords needed.

CLEANUP_ACTION env var:
  delete   — permanently delete all source messages
  dry-run  — report what would be deleted, no writes (default)
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone

WORKER_URL      = os.environ["WORKER_URL"].rstrip("/")
WORKER_TOKEN    = os.environ["WORKER_AUTH_TOKEN"]
CF_ACCESS_ID    = os.environ.get("CF_ACCESS_CLIENT_ID", "")
CF_ACCESS_SECRET = os.environ.get("CF_ACCESS_CLIENT_SECRET", "")
SOURCE_USER     = os.environ["GMAIL_SOURCE_USER"]
ACTION          = os.environ.get("CLEANUP_ACTION", "dry-run")
GMAIL_API       = "https://gmail.googleapis.com/gmail/v1/users/me"
SKIP_LABELS     = {"SPAM", "TRASH", "DRAFT", "UNREAD", "CHAT"}
BATCH_SIZE      = 1000  # Gmail batchDelete max

_token_cache: dict[str, str] = {}


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def get_token(email: str) -> str:
    if email in _token_cache:
        return _token_cache[email]
    url = f"{WORKER_URL}/api/token?email={urllib.parse.quote(email)}"
    headers = {"Authorization": f"Bearer {WORKER_TOKEN}", "User-Agent": "gmail-cleanup/1.0"}
    if CF_ACCESS_ID:
        headers["CF-Access-Client-Id"] = CF_ACCESS_ID
        headers["CF-Access-Client-Secret"] = CF_ACCESS_SECRET
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        log(f"FATAL: token fetch failed for {email}: {e.code} {body}")
        sys.exit(1)
    token = data.get("access_token")
    if not token:
        log(f"FATAL: no access_token in response for {email}: {data}")
        sys.exit(1)
    _token_cache[email] = token
    return token


def gmail_get(token: str, path: str) -> dict:
    req = urllib.request.Request(
        GMAIL_API + path,
        headers={"Authorization": f"Bearer {token}", "User-Agent": "gmail-cleanup/1.0"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503):
                time.sleep(2 ** (attempt + 1))
                continue
            body = e.read().decode() if e.fp else str(e)
            raise RuntimeError(f"GET {path}: {e.code} {body[:200]}")
    raise RuntimeError(f"GET {path}: failed after 3 attempts")


def gmail_post(token: str, path: str, body: dict) -> None:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        GMAIL_API + path,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "gmail-cleanup/1.0",
        },
        method="POST",
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
            return
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503):
                time.sleep(2 ** (attempt + 1))
                continue
            body_text = e.read().decode() if e.fp else str(e)
            raise RuntimeError(f"POST {path}: {e.code} {body_text[:200]}")
    raise RuntimeError(f"POST {path}: failed after 3 attempts")


def list_all_message_ids(token: str, label_id: str) -> list[str]:
    ids: list[str] = []
    page_token = None
    while True:
        path = f"/messages?labelIds={urllib.parse.quote(label_id)}&maxResults=500"
        if page_token:
            path += f"&pageToken={urllib.parse.quote(page_token)}"
        data = gmail_get(token, path)
        for m in data.get("messages", []):
            ids.append(m["id"])
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return ids


def batch_delete(token: str, ids: list[str]) -> int:
    deleted = 0
    for i in range(0, len(ids), BATCH_SIZE):
        chunk = ids[i : i + BATCH_SIZE]
        gmail_post(token, "/messages/batchDelete", {"ids": chunk})
        deleted += len(chunk)
        log(f"  Deleted {deleted}/{len(ids)} messages...")
    return deleted


def main() -> None:
    log("=" * 60)
    log(f"Gmail Cleanup — action={ACTION}")
    log(f"Source: {SOURCE_USER}")
    log("=" * 60)

    src_token = get_token(SOURCE_USER)
    log("✅ Source token acquired")

    labels_data = gmail_get(src_token, "/labels")
    labels = labels_data.get("labels", [])

    interesting = [
        l for l in labels
        if l["name"] not in SKIP_LABELS
        and not l["name"].startswith("CATEGORY_")
    ]

    log(f"Found {len(interesting)} labels to process")
    log("")

    total_messages = 0
    total_deleted = 0

    for label in sorted(interesting, key=lambda l: l["name"]):
        label_id   = label["id"]
        label_name = label["name"]

        try:
            detail = gmail_get(src_token, f"/labels/{label_id}")
            count  = detail.get("messagesTotal", 0)
        except Exception as e:
            log(f"  Skipping {label_name}: {e}")
            continue

        if count == 0:
            continue

        log(f"  {label_name}: {count} messages")
        total_messages += count

        if ACTION == "delete":
            ids = list_all_message_ids(src_token, label_id)
            if ids:
                deleted = batch_delete(src_token, ids)
                total_deleted += deleted
                log(f"  ✅ Deleted {deleted} from {label_name}")
        elif ACTION == "dry-run":
            log(f"  [dry-run] Would delete {count} messages from {label_name}")

    log("")
    log("=" * 60)
    if ACTION == "delete":
        log(f"Total deleted: {total_deleted} messages")
    else:
        log(f"[dry-run] Would delete: {total_messages} messages total")
        log("Set CLEANUP_ACTION=delete to perform deletion.")
    log("=" * 60)


if __name__ == "__main__":
    main()
