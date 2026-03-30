#!/usr/bin/env python3
"""
Gmail API Migrator — uses Cloudflare Worker as token authority.

No app passwords needed. Gets fresh OAuth tokens from the CF Worker's
/api/token endpoint, then uses Gmail API for all operations.

Usage (env vars):
  WORKER_URL        — CF Worker URL
  WORKER_AUTH_TOKEN — Auth token for CF Worker API
  GMAIL_SOURCE_USER — Source email
  GMAIL_DEST_USER   — Destination email
  DEST_ID           — dest1 or dest2
  STATE_FILE        — path to state JSON
  STRATEGY          — size | folder | random
  DRY_RUN           — true | false
  SIZE_LIMIT_MB     — max MB per run
  EMAIL_LIMIT       — max emails per run (0=unlimited)
  BATCH_SIZE        — messages per batch (default 10)
  MIGRATION_FOLDER  — folder for folder/random strategy
  SKIP_DEDUP        — true to skip Message-ID dedup
  MIGRATION_FOLDERS — comma-separated folders to process (empty = all)
  NTFY_URL          — ntfy push notification URL
  NTFY_EMAIL_MILESTONE — notify every N emails (default 100)
  NTFY_MB_MILESTONE — notify every N MB (default 50)
"""
import json
import os
import sys
import time
import email
import base64
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone

# ── Config ──
WORKER_URL      = os.environ["WORKER_URL"].rstrip("/")
WORKER_TOKEN    = os.environ["WORKER_AUTH_TOKEN"]
CF_ACCESS_ID    = os.environ.get("CF_ACCESS_CLIENT_ID", "")
CF_ACCESS_SECRET = os.environ.get("CF_ACCESS_CLIENT_SECRET", "")
SOURCE_USER     = os.environ["GMAIL_SOURCE_USER"]
DEST_USER       = os.environ["GMAIL_DEST_USER"]
DEST_ID         = os.environ.get("DEST_ID", "dest")
STATE_FILE      = os.environ.get("STATE_FILE", f"migration-state-{DEST_ID}.json")
STRATEGY        = os.environ.get("STRATEGY", "size")
DRY_RUN         = os.environ.get("DRY_RUN", "true").lower() == "true"
SIZE_LIMIT      = int(os.environ.get("SIZE_LIMIT_MB", "500")) * 1024 * 1024
EMAIL_LIMIT     = int(os.environ.get("EMAIL_LIMIT", "0"))
BATCH_SIZE      = int(os.environ.get("BATCH_SIZE", "10"))
FOLDER          = os.environ.get("MIGRATION_FOLDER", "INBOX")
SKIP_DEDUP      = os.environ.get("SKIP_DEDUP", "false").lower() == "true"
SAMPLE_SIZE     = int(os.environ.get("SAMPLE_SIZE", "50"))
LOG_FILE        = "migration.log"
NTFY_URL             = os.environ.get("NTFY_URL", "")
NTFY_EMAIL_MILESTONE = int(os.environ.get("NTFY_EMAIL_MILESTONE", "100"))
NTFY_MB_MILESTONE    = int(os.environ.get("NTFY_MB_MILESTONE", "50")) * 1024 * 1024
_FOLDERS_RAW         = os.environ.get("MIGRATION_FOLDERS", "")
FOLDERS_FILTER       = {f.strip() for f in _FOLDERS_RAW.split(",") if f.strip()} or None

GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"

_token_cache = {}

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

def notify(title, body, priority="default"):
    """Send a push notification via ntfy.sh (or self-hosted ntfy)."""
    if not NTFY_URL:
        return
    try:
        req = urllib.request.Request(
            NTFY_URL, data=body.encode("utf-8"),
            headers={"Title": title, "Priority": priority, "Tags": "envelope"},
            method="POST"
        )
        urllib.request.urlopen(req, timeout=5)
        log(f"[ntfy] sent: {title}")
    except Exception as e:
        log(f"[ntfy] failed: {e}")

# ── Token Management (via CF Worker) ──
def get_token(email_addr):
    if email_addr in _token_cache:
        return _token_cache[email_addr]
    url = f"{WORKER_URL}/api/token?email={urllib.parse.quote(email_addr)}"
    headers = {"Authorization": f"Bearer {WORKER_TOKEN}", "User-Agent": "gmail-migrate/1.0"}
    if CF_ACCESS_ID:
        headers["CF-Access-Client-Id"] = CF_ACCESS_ID
        headers["CF-Access-Client-Secret"] = CF_ACCESS_SECRET
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        log(f"FATAL: token fetch failed for {email_addr}: {e.code} {body}")
        sys.exit(1)
    token = data.get("access_token")
    if not token:
        log(f"FATAL: no token in response for {email_addr}: {data}")
        sys.exit(1)
    _token_cache[email_addr] = token
    return token

def get_source_token():
    return get_token(SOURCE_USER)

def get_dest_token():
    return get_token(DEST_USER)

# ── Gmail API ──
def gmail_api(token, path, method="GET", body=None, content_type="application/json"):
    url = GMAIL_API + path
    headers = {"Authorization": f"Bearer {token}", "User-Agent": "gmail-migrate/1.0"}
    data = None
    if body is not None:
        if isinstance(body, str):
            data = body.encode("utf-8")
        elif isinstance(body, bytes):
            data = body
        else:
            data = json.dumps(body).encode("utf-8")
        if content_type:
            headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                try:
                    return json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    return raw
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt < 2:
                log(f"  401 on {path}, refreshing token (attempt {attempt+1})")
                if token == get_source_token():
                    _token_cache.pop(SOURCE_USER, None)
                    token = get_source_token()
                else:
                    _token_cache.pop(DEST_USER, None)
                    token = get_dest_token()
                headers["Authorization"] = f"Bearer {token}"
                req = urllib.request.Request(url, data=data, headers=headers, method=method)
                continue
            if e.code == 429 or e.code >= 500:
                wait = 2 ** (attempt + 1)
                log(f"  {e.code} on {path}, retry in {wait}s")
                time.sleep(wait)
                continue
            body_text = e.read().decode() if e.fp else str(e)
            raise RuntimeError(f"Gmail API {method} {path}: {e.code} {body_text[:300]}")
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < 2:
                wait = 2 ** (attempt + 1)
                log(f"  Connection error on {path}: {e}, retry in {wait}s")
                time.sleep(wait)
                continue
            raise
    raise RuntimeError(f"Gmail API {method} {path}: failed after 3 attempts")

# ── Gmail Operations ──
def list_labels(token):
    data = gmail_api(token, "/labels")
    return {label["name"]: label["id"] for label in data.get("labels", [])}

def list_messages(token, query="", max_results=500, page_token=None):
    path = f"/messages?maxResults={min(max_results, 500)}"
    if query:
        path += f"&q={urllib.parse.quote(query)}"
    if page_token:
        path += f"&pageToken={urllib.parse.quote(page_token)}"
    data = gmail_api(token, path)
    return data.get("messages", []), data.get("nextPageToken")

def list_all_messages(token, query="", max_results=0):
    all_msgs = []
    page_token = None
    while True:
        msgs, page_token = list_messages(token, query=query, max_results=500, page_token=page_token)
        if not msgs:
            break
        all_msgs.extend(msgs)
        if max_results and len(all_msgs) >= max_results:
            all_msgs = all_msgs[:max_results]
            break
        if not page_token:
            break
    return all_msgs

def get_message_raw(token, msg_id):
    data = gmail_api(token, f"/messages/{msg_id}?format=raw")
    if isinstance(data, dict):
        raw_b64 = data.get("raw", "")
        if raw_b64:
            return base64.urlsafe_b64decode(raw_b64)
    return None

def import_message(token, raw_bytes, label_ids=None):
    """Import raw RFC 2822 message. Preserves original delivery timestamp."""
    raw_b64 = base64.urlsafe_b64encode(raw_bytes).decode("ascii")
    body = {"raw": raw_b64}
    if label_ids:
        body["labelIds"] = label_ids
    return gmail_api(
        token,
        "/messages/import?neverMarkSpam=true&internalDateSource=dateHeader",
        method="POST",
        body=body
    )

def get_message_id_from_raw(raw_bytes):
    try:
        msg = email.message_from_bytes(raw_bytes)
        return msg.get("Message-ID", "")
    except Exception:
        return ""

def search_by_message_id(token, message_id):
    if not message_id:
        return None
    escaped = message_id.replace('"', '\\"')
    msgs, _ = list_messages(token, query=f'rfc822msgid:{escaped}', max_results=1)
    return msgs[0]["id"] if msgs else None

def create_label(token, name, labels_cache):
    if name in labels_cache:
        return labels_cache[name]
    try:
        result = gmail_api(token, "/labels", method="POST", body={
            "name": name,
            "labelListVisibility": "labelShow",
            "messageListVisibility": "show"
        })
        labels_cache[name] = result["id"]
        return result["id"]
    except RuntimeError as e:
        if "409" in str(e) or "ALREADY_EXISTS" in str(e):
            labels_cache.clear()
            labels_cache.update(list_labels(token))
            return labels_cache.get(name)
        raise

# ── State Management ──
def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {
            "schema_version": 3,
            "source_account": SOURCE_USER,
            "destination": DEST_ID,
            "strategy": STRATEGY,
            "processed_emails": 0,
            "processed_bytes": 0,
            "completed_folders": [],
            "last_folder": None,
            "last_msg_id": None,
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

def get_folder_state(state, folder):
    fs = state.setdefault("folder_state", {})
    return fs.setdefault(folder, {"copied": 0, "bytes": 0, "skipped": 0, "last_msg_id": None, "completed": False})

# ── Folder Mapping ──
SKIP_LABELS = {"SPAM", "TRASH"}

def gmail_query_for_folder(folder):
    if folder == "INBOX": return "in:inbox"
    elif folder == "SENT": return "in:sent"
    elif folder == "DRAFT": return "in:draft"
    elif folder == "STARRED": return "in:starred"
    elif folder.startswith("CATEGORY_"): return f"in:{folder.replace('CATEGORY_', '').lower()}"
    else: return f'label:"{folder}"'

def dest_label_name(src_label):
    return f"G-{SOURCE_USER}/{src_label}"

# ── Main Copy Logic ──
def copy_messages(src_token, dst_token, src_folder, state, limit_bytes=0, limit_emails=0):
    """
    Copy messages from source folder/label to destination with G- prefix.
    Returns (copied, bytes, skipped).
    """
    folder_st = get_folder_state(state, src_folder)
    dest_label = dest_label_name(src_folder)

    dst_labels = {}
    try:
        dst_labels = list_labels(dst_token)
        create_label(dst_token, dest_label, dst_labels)
    except Exception as e:
        log(f"  Warning: couldn't create dest label {dest_label}: {e}")

    query = gmail_query_for_folder(src_folder)
    log(f"  Query: {query}")

    messages = list_all_messages(src_token, query=query)
    total_in_folder = len(messages)
    log(f"  {src_folder}: {total_in_folder} messages (batch_size={BATCH_SIZE})")

    if not messages:
        return 0, 0, 0

    copied = 0
    total_bytes = 0
    skipped = 0
    reached_limit = False
    had_fatal_error = False
    error_count = 0

    last_msg_id = folder_st.get("last_msg_id")
    resume = last_msg_id is not None

    # Safety: if resume anchor is gone (message deleted/moved since last run),
    # fall back to full scan with dedup rather than silently skipping all messages.
    if resume and not any(m.get("id") == last_msg_id for m in messages):
        log(f"  Resume anchor not found for {src_folder}; running full scan for safety")
        resume = False

    batch_start = time.time()
    batch_copied = 0
    last_processed_msg_id = None

    for msg_ref in messages:
        msg_id = msg_ref["id"]

        if resume:
            if msg_id == last_msg_id:
                resume = False
            continue

        if limit_emails and copied >= limit_emails:
            log(f"  Email limit ({limit_emails}) reached")
            reached_limit = True
            break
        if limit_bytes and total_bytes >= limit_bytes:
            log(f"  Size limit ({bytes_human(limit_bytes)}) reached")
            reached_limit = True
            break

        try:
            raw = get_message_raw(src_token, msg_id)
            if raw is None:
                skipped += 1
                batch_copied += 1
                continue

            msg_size = len(raw)

            if not SKIP_DEDUP:
                msg_id_header = get_message_id_from_raw(raw)
                if msg_id_header:
                    existing = search_by_message_id(dst_token, msg_id_header)
                    if existing:
                        skipped += 1
                        batch_copied += 1
                        continue

            if not DRY_RUN:
                dest_label_ids = [dst_labels.get(dest_label)] if dest_label in dst_labels else []
                import_message(dst_token, raw, label_ids=[lid for lid in dest_label_ids if lid])

            copied += 1
            total_bytes += msg_size
            batch_copied += 1
            last_processed_msg_id = msg_id

            if batch_copied >= BATCH_SIZE:
                elapsed = time.time() - batch_start
                rate = (batch_copied / elapsed * 60) if elapsed > 0 else 0
                log(f"[BATCH] folder={src_folder} done={copied}/{total_in_folder} "
                    f"bytes={bytes_human(total_bytes)} {elapsed:.1f}s {rate:.1f} msg/min")
                folder_st["last_msg_id"] = msg_id
                folder_st["copied"] = copied
                folder_st["bytes"] = total_bytes
                state["last_folder"] = src_folder
                state["last_msg_id"] = msg_id
                save_state(state)
                batch_start = time.time()
                batch_copied = 0
                time.sleep(0.5)

        except RuntimeError as e:
            log(f"  Error on msg {msg_id}: {e}")
            state.setdefault("errors", []).append({
                "folder": src_folder,
                "msg_id": msg_id,
                "error": str(e)[:200],
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            error_count += 1

            # Fatal: missing Gmail scope or persistent 403 — abort immediately
            err_l = str(e).lower()
            if ("insufficient authentication scopes" in err_l or
                    (" 403 " in f" {err_l} " and "/messages/" in err_l)):
                had_fatal_error = True
                save_state(state)
                raise RuntimeError(
                    f"Fatal API permission error in {src_folder}. "
                    "Re-auth source account with required Gmail scopes and retry."
                ) from e

            # Too many per-message errors — abort folder
            if error_count >= 25:
                had_fatal_error = True
                save_state(state)
                raise RuntimeError(
                    f"Aborting folder {src_folder}: too many message-level errors ({error_count})."
                ) from e

            skipped += 1

    # Final batch flush
    if batch_copied > 0:
        elapsed = time.time() - batch_start
        rate = (batch_copied / elapsed * 60) if elapsed > 0 else 0
        log(f"[BATCH] folder={src_folder} done={copied}/{total_in_folder} "
            f"bytes={bytes_human(total_bytes)} {elapsed:.1f}s {rate:.1f} msg/min")

    # Only mark complete if we processed the whole folder without hitting a limit.
    # If a limit was hit, preserve the progress anchor for safe resume next run.
    completed = state.get("completed_folders", [])
    if not reached_limit and not had_fatal_error:
        if src_folder not in completed:
            completed.append(src_folder)
            state["completed_folders"] = completed
        folder_st["completed"] = True
        folder_st["last_msg_id"] = messages[-1]["id"] if messages else folder_st.get("last_msg_id")
    else:
        folder_st["completed"] = False
        if last_processed_msg_id:
            folder_st["last_msg_id"] = last_processed_msg_id

    folder_st["copied"] = copied
    folder_st["bytes"] = total_bytes
    folder_st["skipped"] = skipped
    state["processed_emails"] = state.get("processed_emails", 0) + copied
    state["processed_bytes"] = state.get("processed_bytes", 0) + total_bytes
    state["last_folder"] = src_folder
    save_state(state)

    return copied, total_bytes, skipped

# ── Milestone notifications ──
def _check_milestones(folder, total_emails, total_bytes, last_email_ms, last_mb_ms):
    new_email_ms = last_email_ms
    new_mb_ms = last_mb_ms
    if NTFY_EMAIL_MILESTONE > 0:
        curr = total_emails // NTFY_EMAIL_MILESTONE
        if curr > last_email_ms:
            notify(f"\U0001f4e7 {total_emails:,} emails migrated [{DEST_ID}]",
                   f"Folder: {folder}\nSize: {bytes_human(total_bytes)}")
            new_email_ms = curr
    if NTFY_MB_MILESTONE > 0:
        curr = total_bytes // NTFY_MB_MILESTONE
        if curr > last_mb_ms:
            notify(f"\U0001f4be {bytes_human(total_bytes)} migrated [{DEST_ID}]",
                   f"Folder: {folder}\nEmails: {total_emails:,}")
            new_mb_ms = curr
    return new_email_ms, new_mb_ms

# ── Main ──
def main():
    log("=" * 60)
    log("Gmail API Migrator (via CF Worker tokens)")
    log("=" * 60)
    log(f"Source:      {SOURCE_USER}")
    log(f"Dest:        {DEST_USER} ({DEST_ID})")
    log(f"Strategy:    {STRATEGY}")
    log(f"Dry run:     {DRY_RUN}")
    log(f"Size limit:  {bytes_human(SIZE_LIMIT) if SIZE_LIMIT else 'unlimited'}")
    log(f"Email limit: {EMAIL_LIMIT or 'unlimited'}")
    log(f"Batch size:  {BATCH_SIZE}")
    log(f"Skip dedup:  {SKIP_DEDUP}")
    if FOLDERS_FILTER:
        log(f"Folders:     {', '.join(sorted(FOLDERS_FILTER))}")
    if NTFY_URL:
        log(f"ntfy:        enabled (email={NTFY_EMAIL_MILESTONE}, mb={NTFY_MB_MILESTONE//(1024*1024)})")
    log("")

    state = load_state()
    if not state.get("started_at"):
        state["started_at"] = datetime.now(timezone.utc).isoformat()
    state["status"] = "running"
    state["strategy"] = STRATEGY
    save_state(state)

    total_copied = 0
    total_bytes = 0
    total_skipped = 0
    _notified_email_ms = 0
    _notified_mb_ms = 0

    try:
        src_token = get_source_token()
        dst_token = get_dest_token()
        log("\u2705 Tokens acquired from CF Worker")
        notify(f"Migration started [{DEST_ID}]",
               f"Strategy: {STRATEGY}\n{SOURCE_USER} \u2192 {DEST_USER}\nDry run: {DRY_RUN}")

        if STRATEGY == "folder":
            copied, bts, skipped = copy_messages(
                src_token, dst_token, FOLDER, state,
                limit_bytes=SIZE_LIMIT, limit_emails=EMAIL_LIMIT
            )
            total_copied += copied; total_bytes += bts; total_skipped += skipped
            _notified_email_ms, _notified_mb_ms = _check_milestones(
                FOLDER, total_copied, total_bytes, _notified_email_ms, _notified_mb_ms)

        elif STRATEGY == "size":
            src_labels = list_labels(src_token)
            log(f"Found {len(src_labels)} source labels")

            remaining_bytes = SIZE_LIMIT
            system_labels = {"INBOX", "SENT", "DRAFT", "STARRED", "IMPORTANT",
                             "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS",
                             "CATEGORY_UPDATES", "CATEGORY_FORUMS"}
            priority_order = []
            for name in sorted(src_labels.keys()):
                if name not in SKIP_LABELS and name not in system_labels:
                    priority_order.append(name)
            for name in sorted(src_labels.keys()):
                if name not in SKIP_LABELS and name in system_labels:
                    priority_order.append(name)

            log(f"Processing {len(priority_order)} folders")

            for folder in priority_order:
                if FOLDERS_FILTER and folder not in FOLDERS_FILTER:
                    log(f"  Skipping (not in MIGRATION_FOLDERS filter): {folder}")
                    continue
                folder_st = get_folder_state(state, folder)
                if folder_st.get("completed") and folder in state.get("completed_folders", []):
                    log(f"  Skipping completed: {folder}")
                    continue
                if remaining_bytes <= 0:
                    log("Size limit reached, stopping")
                    break

                log(f"\n--- Folder: {folder} ---")
                copied, bts, skipped = copy_messages(
                    src_token, dst_token, folder, state, limit_bytes=remaining_bytes)
                total_copied += copied; total_bytes += bts; total_skipped += skipped
                remaining_bytes -= bts
                _notified_email_ms, _notified_mb_ms = _check_milestones(
                    folder, total_copied, total_bytes, _notified_email_ms, _notified_mb_ms)

        elif STRATEGY == "random":
            import random
            query = gmail_query_for_folder(FOLDER)
            messages = list_all_messages(src_token, query=query)
            sample = random.sample(messages, min(SAMPLE_SIZE, len(messages)))
            log(f"Random sample: {len(sample)} from {len(messages)}")
            for msg_ref in sample:
                raw = get_message_raw(src_token, msg_ref["id"])
                if raw:
                    if not DRY_RUN:
                        import_message(dst_token, raw)
                    total_copied += 1
                    total_bytes += len(raw)

        state["status"] = "completed" if not DRY_RUN else "dry-run"
        save_state(state)
        notify(f"Migration {'dry-run ' if DRY_RUN else ''}complete [{DEST_ID}]",
               f"Copied: {total_copied} ({bytes_human(total_bytes)})\n"
               f"Skipped: {total_skipped}\nErrors: {len(state.get('errors', []))}",
               priority="high")

    except KeyboardInterrupt:
        log("Interrupted — saving state")
        state["status"] = "interrupted"
        save_state(state)
        notify(f"Migration interrupted [{DEST_ID}]",
               f"Copied so far: {total_copied} ({bytes_human(total_bytes)})")
    except Exception as e:
        log(f"FATAL: {e}")
        state["status"] = "failed"
        state.setdefault("errors", []).append({"error": str(e)[:500]})
        save_state(state)
        notify(f"Migration FAILED [{DEST_ID}]", str(e)[:300], priority="urgent")

    log("")
    log("=" * 60)
    log(f"Migration {'dry-run' if DRY_RUN else 'run'} complete")
    log(f"  Copied:  {total_copied} messages ({bytes_human(total_bytes)})")
    log(f"  Skipped: {total_skipped}")
    log(f"  Errors:  {len(state.get('errors', []))}")
    log("=" * 60)

    sys.exit(0 if state["status"] in ("completed", "dry-run") else 1)

if __name__ == "__main__":
    main()
