#!/usr/bin/env python3
"""
Cleanup script — trash migrated mail from source via Gmail API.
Uses Cloudflare Worker as token authority (same as migrate.py).

SAFETY:
  - Only trashes messages that are VERIFIED to exist in destination(s)
  - Uses messages.trash (recoverable from Trash for 30 days) — NOT batchDelete
  - Matches by Message-ID header, not Gmail internal ID
  - Requires explicit CLEANUP_ACTION=trash to do anything

CLEANUP_ACTION env var:
  trash    — move verified-migrated messages to Trash (recoverable 30 days)
  dry-run  — report what would be trashed, no writes (default)
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone

WORKER_URL       = os.environ["WORKER_URL"].rstrip("/")
WORKER_TOKEN     = os.environ["WORKER_AUTH_TOKEN"]
CF_ACCESS_ID     = os.environ.get("CF_ACCESS_CLIENT_ID", "")
CF_ACCESS_SECRET = os.environ.get("CF_ACCESS_CLIENT_SECRET", "")
SOURCE_USER      = os.environ["GMAIL_SOURCE_USER"]
DEST1_USER       = os.environ.get("GMAIL_DEST1_USER", "")
DEST2_USER       = os.environ.get("GMAIL_DEST2_USER", "")
DESTINATION      = os.environ.get("DESTINATION", "both")  # both | dest1 | dest2
ACTION           = os.environ.get("CLEANUP_ACTION", "dry-run")
GMAIL_API        = "https://gmail.googleapis.com/gmail/v1/users/me"
SKIP_LABELS      = {"SPAM", "TRASH", "DRAFT", "UNREAD", "CHAT", "STARRED", "IMPORTANT",
                    "SENT", "INBOX", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL",
                    "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS"}

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


def gmail_post(token: str, path: str, body: dict | None = None) -> dict | None:
    data = json.dumps(body).encode() if body else b""
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
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503):
                time.sleep(2 ** (attempt + 1))
                continue
            body_text = e.read().decode() if e.fp else str(e)
            if e.code == 403:
                raise RuntimeError(
                    f"POST {path}: 403 Forbidden — token may lack required scope. "
                    f"Re-auth at {WORKER_URL}/auth/{SOURCE_USER}. "
                    f"Detail: {body_text[:150]}"
                )
            raise RuntimeError(f"POST {path}: {e.code} {body_text[:200]}")
    raise RuntimeError(f"POST {path}: failed after 3 attempts")


def preflight_check(token: str) -> None:
    """Verify token identity before any operations."""
    try:
        profile = gmail_get(token, "/profile")
        authed_as = profile.get("emailAddress", "unknown")
        log(f"  Authenticated as: {authed_as}")
        if authed_as.lower() != SOURCE_USER.lower():
            log(f"FATAL: token is for {authed_as} but GMAIL_SOURCE_USER={SOURCE_USER}")
            sys.exit(1)
    except RuntimeError as e:
        log(f"FATAL: preflight failed: {e}")
        sys.exit(1)


def get_message_id_header(token: str, gmail_id: str) -> str | None:
    """Fetch the Message-ID header of a Gmail message."""
    try:
        data = gmail_get(token, f"/messages/{gmail_id}?format=metadata&metadataHeaders=Message-ID")
        headers = data.get("payload", {}).get("headers", [])
        for h in headers:
            if h.get("name", "").lower() == "message-id":
                return h.get("value", "").strip()
    except RuntimeError:
        pass
    return None


def list_messages_with_ids(token: str, label_id: str) -> list[dict]:
    """List all messages in a label, returning [{gmail_id, message_id_header}]."""
    gmail_ids: list[str] = []
    page_token = None
    while True:
        path = f"/messages?labelIds={urllib.parse.quote(label_id)}&maxResults=500"
        if page_token:
            path += f"&pageToken={urllib.parse.quote(page_token)}"
        data = gmail_get(token, path)
        for m in data.get("messages", []):
            gmail_ids.append(m["id"])
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return gmail_ids


def search_message_id_in_dest(token: str, message_id: str) -> bool:
    """Check if a message with a given Message-ID header exists in destination."""
    if not message_id:
        return False
    query = urllib.parse.quote(f"rfc822msgid:{message_id}")
    try:
        data = gmail_get(token, f"/messages?q={query}&maxResults=1")
        return len(data.get("messages", [])) > 0
    except RuntimeError:
        return False


def trash_message(token: str, gmail_id: str) -> bool:
    """Move a single message to Trash (recoverable for 30 days)."""
    try:
        gmail_post(token, f"/messages/{gmail_id}/trash")
        return True
    except RuntimeError as e:
        log(f"  Failed to trash {gmail_id}: {e}")
        return False


def get_dest_tokens() -> list[tuple[str, str]]:
    """Return list of (email, token) for destinations that need verification."""
    dests = []
    if DESTINATION in ("both", "dest1") and DEST1_USER:
        dests.append((DEST1_USER, get_token(DEST1_USER)))
    if DESTINATION in ("both", "dest2") and DEST2_USER:
        dests.append((DEST2_USER, get_token(DEST2_USER)))
    return dests


def main() -> None:
    log("=" * 60)
    log(f"Gmail Cleanup — action={ACTION}")
    log(f"Source: {SOURCE_USER}")
    if ACTION not in ("trash", "dry-run"):
        log(f"FATAL: unknown CLEANUP_ACTION={ACTION}. Use 'trash' or 'dry-run'.")
        sys.exit(1)
    if ACTION == "trash":
        log("⚠️  TRASH MODE — messages will be moved to Trash (recoverable 30 days)")
    else:
        log("ℹ️  DRY RUN — no changes will be made")
    log("=" * 60)

    src_token = get_token(SOURCE_USER)
    log("✅ Source token acquired")
    preflight_check(src_token)

    dest_tokens = get_dest_tokens()
    if not dest_tokens:
        log("FATAL: no destination accounts configured. Set GMAIL_DEST1_USER / GMAIL_DEST2_USER.")
        sys.exit(1)
    for email, _ in dest_tokens:
        log(f"✅ Destination token acquired: {email}")

    labels_data = gmail_get(src_token, "/labels")
    labels = labels_data.get("labels", [])

    # Only process user-created labels (not system labels)
    interesting = [
        l for l in labels
        if l["name"] not in SKIP_LABELS
        and not l["name"].startswith("CATEGORY_")
        and l.get("type") == "user"
    ]

    log(f"Found {len(interesting)} user labels to check")
    log("")

    total_verified = 0
    total_trashed = 0
    total_not_in_dest = 0
    total_no_msgid = 0

    for label in sorted(interesting, key=lambda l: l["name"]):
        label_id = label["id"]
        label_name = label["name"]

        try:
            detail = gmail_get(src_token, f"/labels/{label_id}")
            count = detail.get("messagesTotal", 0)
        except Exception as e:
            log(f"  Skipping {label_name}: {e}")
            continue

        if count == 0:
            continue

        log(f"📁 {label_name}: {count} messages")
        gmail_ids = list_messages_with_ids(src_token, label_id)
        log(f"  Fetched {len(gmail_ids)} message IDs")

        label_verified = 0
        label_trashed = 0
        label_missing = 0
        label_no_msgid = 0

        for i, gmail_id in enumerate(gmail_ids):
            # Get the RFC Message-ID header from source
            msg_id_header = get_message_id_header(src_token, gmail_id)

            if not msg_id_header:
                label_no_msgid += 1
                continue

            # Verify this exact message exists in ALL required destinations
            in_all_dests = True
            for dest_email, dest_token in dest_tokens:
                if not search_message_id_in_dest(dest_token, msg_id_header):
                    in_all_dests = False
                    break

            if not in_all_dests:
                label_missing += 1
                continue

            label_verified += 1

            if ACTION == "trash":
                if trash_message(src_token, gmail_id):
                    label_trashed += 1

            if (i + 1) % 50 == 0:
                log(f"  Progress: {i+1}/{len(gmail_ids)} checked, "
                    f"{label_verified} verified, {label_trashed} trashed")

        log(f"  ✅ {label_name}: {label_verified} verified in dest, "
            f"{label_missing} NOT in dest (kept), {label_no_msgid} no Message-ID (kept), "
            f"{label_trashed} trashed")

        total_verified += label_verified
        total_trashed += label_trashed
        total_not_in_dest += label_missing
        total_no_msgid += label_no_msgid

    log("")
    log("=" * 60)
    log(f"Total messages verified in destination(s): {total_verified}")
    log(f"Total messages NOT in destination (kept):  {total_not_in_dest}")
    log(f"Total messages without Message-ID (kept):  {total_no_msgid}")
    if ACTION == "trash":
        log(f"Total messages trashed:                    {total_trashed}")
        log("Messages are in Trash — recoverable for 30 days.")
    else:
        log(f"[dry-run] Would trash: {total_verified} messages")
        log("Set CLEANUP_ACTION=trash to move verified messages to Trash.")
    log("=" * 60)


if __name__ == "__main__":
    main()
