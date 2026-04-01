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
CLEANUP_STATE_FILES = os.environ.get(
    "CLEANUP_STATE_FILES",
    "migration-state-dest1.json,migration-state-dest2.json",
)
GMAIL_API        = "https://gmail.googleapis.com/gmail/v1/users/me"

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


def get_message_fingerprint(token: str, gmail_id: str) -> dict | None:
    """Get message fingerprint headers used for high-confidence verification."""
    try:
        data = gmail_get(
            token,
            f"/messages/{gmail_id}?format=metadata&metadataHeaders=Message-ID"
            f"&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date",
        )
        headers = data.get("payload", {}).get("headers", [])
        out = {"message_id": "", "subject": "", "from": "", "date": "", "internal_date": ""}
        for h in headers:
            name = h.get("name", "").lower()
            if name == "message-id":
                out["message_id"] = h.get("value", "").strip()
            elif name == "subject":
                out["subject"] = h.get("value", "").strip()
            elif name == "from":
                out["from"] = h.get("value", "").strip()
            elif name == "date":
                out["date"] = h.get("value", "").strip()
        out["internal_date"] = str(data.get("internalDate", ""))
        return out
    except RuntimeError:
        return None


def search_message_id_in_dest(token: str, message_id: str) -> list[str]:
    """Return candidate Gmail IDs for a Message-ID lookup in destination."""
    if not message_id:
        return []
    query = urllib.parse.quote(f"rfc822msgid:{message_id}")
    try:
        data = gmail_get(token, f"/messages?q={query}&maxResults=5")
        return [m["id"] for m in data.get("messages", [])]
    except RuntimeError:
        return []


def fingerprint_matches(source_fp: dict, dest_fp: dict) -> bool:
    """Strict compare of key identity headers."""
    return (
        source_fp.get("message_id") == dest_fp.get("message_id")
        and source_fp.get("subject", "") == dest_fp.get("subject", "")
        and source_fp.get("from", "") == dest_fp.get("from", "")
        and source_fp.get("date", "") == dest_fp.get("date", "")
    )


def load_cleanup_candidates(required_destinations: set[str]) -> dict[str, dict]:
    """
    Load source message candidates from migration state files and intersect by destination.
    Returns source_id -> expected fingerprint.
    """
    files = [p.strip() for p in CLEANUP_STATE_FILES.split(",") if p.strip()]
    by_dest: dict[str, dict[str, dict]] = {}
    for path in files:
        if not os.path.exists(path):
            continue
        try:
            with open(path) as f:
                data = json.load(f)
            dest = data.get("destination")
            migrated = data.get("migrated_messages", {})
            if dest in ("dest1", "dest2") and isinstance(migrated, dict):
                by_dest[dest] = migrated
        except (OSError, json.JSONDecodeError):
            continue

    if not required_destinations.issubset(set(by_dest.keys())):
        return {}

    common_ids: set[str] | None = None
    for dest in sorted(required_destinations):
        ids = set(by_dest[dest].keys())
        common_ids = ids if common_ids is None else common_ids & ids

    out: dict[str, dict] = {}
    for source_id in sorted(common_ids or set()):
        out[source_id] = by_dest[sorted(required_destinations)[0]].get(source_id, {})
    return out


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

    required_destinations = set()
    if DESTINATION in ("both", "dest1"):
        required_destinations.add("dest1")
    if DESTINATION in ("both", "dest2"):
        required_destinations.add("dest2")

    candidates = load_cleanup_candidates(required_destinations)
    if not candidates:
        log("FATAL: no migrated-message manifest candidates found for required destinations.")
        log("      Ensure migration state files are present with migrated_messages populated.")
        sys.exit(1)

    log(f"Loaded {len(candidates)} unique migrated source-message candidates")
    log("")

    total_verified = 0
    total_trashed = 0
    total_not_in_dest = 0
    total_no_msgid = 0

    candidate_ids = sorted(candidates.keys())
    for i, gmail_id in enumerate(candidate_ids):
        source_fp = get_message_fingerprint(src_token, gmail_id)
        if not source_fp or not source_fp.get("message_id"):
            total_no_msgid += 1
            continue

        # Expected values from migrated manifest tighten false-positive risk.
        expected = candidates.get(gmail_id, {})
        if expected:
            if expected.get("message_id") and source_fp.get("message_id") != expected.get("message_id"):
                total_not_in_dest += 1
                continue

        in_all_dests = True
        for dest_email, dest_token in dest_tokens:
            matched = False
            candidate_dest_ids = search_message_id_in_dest(dest_token, source_fp["message_id"])
            for dest_gmail_id in candidate_dest_ids:
                dest_fp = get_message_fingerprint(dest_token, dest_gmail_id)
                if dest_fp and fingerprint_matches(source_fp, dest_fp):
                    matched = True
                    break
            if not matched:
                log(f"  Not verified in {dest_email} for source {gmail_id}")
                in_all_dests = False
                break

        if not in_all_dests:
            total_not_in_dest += 1
            continue

        total_verified += 1
        if ACTION == "trash" and trash_message(src_token, gmail_id):
            total_trashed += 1

        if (i + 1) % 50 == 0:
            log(f"  Progress: {i+1}/{len(candidate_ids)} checked, "
                f"{total_verified} verified, {total_trashed} trashed")

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
