#!/usr/bin/env python3
"""
Gmail API Migrator — uses Cloudflare Worker as token authority.

No app passwords needed. Gets fresh OAuth tokens from the CF Worker's
/api/token endpoint, then uses Gmail API for all operations.

Usage (env vars):
  WORKER_URL        — CF Worker URL (e.g. https://gmail-migrator.aakif-share.workers.dev)
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
import ssl
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

GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"

# Token cache (per-invocation)
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

# ── Token Management (via CF Worker) ──
def get_token(email_addr):
    """Get fresh access token from CF Worker. Cached per-invocation."""
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
    """Call Gmail API. Returns parsed JSON or raw bytes."""
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
                # Try JSON parse
                try:
                    return json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    return raw
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt < 2:
                # Token expired — clear cache and retry
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
    """List all labels, returns {name: id} dict."""
    data = gmail_api(token, "/labels")
    result = {}
    for label in data.get("labels", []):
        result[label["name"]] = label["id"]
    return result

def list_messages(token, query="", max_results=500, page_token=None):
    """
    List messages matching a query. Returns list of {id, threadId}.
    query uses Gmail search syntax: https://support.google.com/mail/answer/7190
    """
    path = f"/messages?maxResults={min(max_results, 500)}"
    if query:
        path += f"&q={urllib.parse.quote(query)}"
    if page_token:
        path += f"&pageToken={urllib.parse.quote(page_token)}"

    data = gmail_api(token, path)
    return data.get("messages", []), data.get("nextPageToken")

def list_all_messages(token, query="", max_results=0):
    """List all messages matching query, paginating automatically."""
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
    """Get full message as raw RFC 2822 bytes."""
    data = gmail_api(token, f"/messages/{msg_id}?format=raw")
    if isinstance(data, dict):
        raw_b64 = data.get("raw", "")
        if raw_b64:
            return base64.urlsafe_b64decode(raw_b64)
    return None

def get_message_metadata(token, msg_id):
    """Get message metadata (headers, labelIds, sizeEstimate)."""
    return gmail_api(token, f"/messages/{msg_id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject")

def import_message(token, raw_bytes, label_ids=None):
    """
    Import a raw RFC 2822 message. This is the Gmail API equivalent of IMAP APPEND.
    Returns the created message dict.
    """
    raw_b64 = base64.urlsafe_b64encode(raw_bytes).decode("ascii")
    body = {"raw": raw_b64}
    if label_ids:
        body["labelIds"] = label_ids

    # Preserve original delivery timestamp semantics where possible.
    return gmail_api(
        token,
        "/messages/import?neverMarkSpam=true&internalDateSource=dateHeader",
        method="POST",
        body=body
    )

def get_message_id_from_raw(raw_bytes):
    """Extract Message-ID header from raw RFC 2822 bytes."""
    try:
        msg = email.message_from_bytes(raw_bytes)
        return msg.get("Message-ID", "")
    except Exception:
        return ""

def search_by_message_id(token, message_id):
    """Search for a message by Message-ID header. Returns message ID or None."""
    if not message_id:
        return None
    # Gmail search syntax: rfc822msgid:<message-id>
    escaped = message_id.replace('"', '\\"')
    msgs, _ = list_messages(token, query=f'rfc822msgid:{escaped}', max_results=1)
    if msgs:
        return msgs[0]["id"]
    return None

def create_label(token, name, labels_cache):
    """Create a label if it doesn't exist. Returns label ID."""
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
            # Refresh labels cache
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
# Gmail API uses label names. Source labels map to destination labels with G- prefix.
SKIP_LABELS = {"SPAM", "TRASH"}

def gmail_query_for_folder(folder):
    """Convert a folder/label name to a Gmail search query."""
    if folder == "INBOX":
        return "in:inbox"
    elif folder == "SENT":
        return "in:sent"
    elif folder == "DRAFT":
        return "in:draft"
    elif folder == "STARRED":
        return "in:starred"
    elif folder.startswith("CATEGORY_"):
        return f"in:{folder.replace('CATEGORY_', '').lower()}"
    else:
        # Custom label
        return f'label:"{folder}"'

def dest_label_name(src_label):
    """Map source label to destination label with G- prefix."""
    return f"G-{SOURCE_USER}/{src_label}"

# ── Main Copy Logic ──
def copy_messages(src_token, dst_token, src_folder, state, limit_bytes=0, limit_emails=0):
    """
    Copy messages from source folder/label to destination with G- prefix.
    Returns (copied, bytes, skipped).
    """
    folder_st = get_folder_state(state, src_folder)
    dest_label = dest_label_name(src_folder)

    # Ensure destination label exists
    dst_labels = {}
    try:
        dst_labels = list_labels(dst_token)
        create_label(dst_token, dest_label, dst_labels)
    except Exception as e:
        log(f"  Warning: couldn't create dest label {dest_label}: {e}")

    # List messages in source folder
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
    last_msg_id = folder_st.get("last_msg_id")
    resume = last_msg_id is not None
    reached_limit = False

    # Defensive: if previous last_msg_id is missing (label changed, message removed, etc.),
    # do not skip the entire folder. Fall back to full scan with dedup.
    if resume and not any(m.get("id") == last_msg_id for m in messages):
        log(f"  Resume anchor not found for {src_folder}; running full scan for safety")
        resume = False

    batch_start = time.time()
    batch_copied = 0
    last_processed_msg_id = None

    for msg_ref in messages:
        msg_id = msg_ref["id"]

        # Resume: skip until we pass last_msg_id
        if resume:
            if msg_id == last_msg_id:
                resume = False
            continue

        # Check limits
        if limit_emails and copied >= limit_emails:
            log(f"  Email limit ({limit_emails}) reached")
            reached_limit = True
            break
        if limit_bytes and total_bytes >= limit_bytes:
            log(f"  Size limit ({bytes_human(limit_bytes)}) reached")
            reached_limit = True
            break

        try:
            # Get raw message from source
            raw = get_message_raw(src_token, msg_id)
            if raw is None:
                skipped += 1
                batch_copied += 1
                continue

            msg_size = len(raw)

            # Dedup check
            if not SKIP_DEDUP:
                msg_id_header = get_message_id_from_raw(raw)
                if msg_id_header:
                    existing = search_by_message_id(dst_token, msg_id_header)
                    if existing:
                        skipped += 1
                        batch_copied += 1
                        continue

            # Import to destination
            if not DRY_RUN:
                dest_label_ids = [dst_labels.get(dest_label)] if dest_label in dst_labels else []
                import_message(dst_token, raw, label_ids=[lid for lid in dest_label_ids if lid])

            copied += 1
            total_bytes += msg_size
            batch_copied += 1
            last_processed_msg_id = msg_id

            # Batch progress
            if batch_copied >= BATCH_SIZE:
                elapsed = time.time() - batch_start
                rate = (batch_copied / elapsed * 60) if elapsed > 0 else 0
                log(f"[BATCH] folder={src_folder} done={copied}/{total_in_folder} "
                    f"bytes={bytes_human(total_bytes)} {elapsed:.1f}s {rate:.1f} msg/min")

                # Save state
                folder_st["last_msg_id"] = msg_id
                folder_st["copied"] = copied
                folder_st["bytes"] = total_bytes
                state["last_folder"] = src_folder
                state["last_msg_id"] = msg_id
                save_state(state)

                batch_start = time.time()
                batch_copied = 0

                # Small sleep to respect rate limits
                time.sleep(0.5)

        except RuntimeError as e:
            log(f"  Error on msg {msg_id}: {e}")
            state.setdefault("errors", []).append({
                "folder": src_folder,
                "msg_id": msg_id,
                "error": str(e)[:200],
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            skipped += 1

    # Final batch flush
    if batch_copied > 0:
        elapsed = time.time() - batch_start
        rate = (batch_copied / elapsed * 60) if elapsed > 0 else 0
        log(f"[BATCH] folder={src_folder} done={copied}/{total_in_folder} "
            f"bytes={bytes_human(total_bytes)} {elapsed:.1f}s {rate:.1f} msg/min")

    # Mark folder complete only if run consumed folder without hitting limits.
    completed = state.get("completed_folders", [])
    if not reached_limit:
        if src_folder not in completed:
            completed.append(src_folder)
            state["completed_folders"] = completed
        folder_st["completed"] = True
        folder_st["last_msg_id"] = messages[-1]["id"] if messages else folder_st.get("last_msg_id")
    else:
        folder_st["completed"] = False
        # Preserve progress marker for safe resume.
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

# ── Main ──
def main():
    import urllib.parse  # needed for get_token

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

    try:
        # Verify tokens work
        src_token = get_source_token()
        dst_token = get_dest_token()
        log("✅ Tokens acquired from CF Worker")

        if STRATEGY == "folder":
            copied, bts, skipped = copy_messages(
                src_token, dst_token, FOLDER, state,
                limit_bytes=SIZE_LIMIT, limit_emails=EMAIL_LIMIT
            )
            total_copied += copied
            total_bytes += bts
            total_skipped += skipped

        elif STRATEGY == "size":
            # Get source labels (folders)
            src_labels = list_labels(src_token)
            log(f"Found {len(src_labels)} source labels")

            remaining_bytes = SIZE_LIMIT
            # Process in priority: custom labels first, then system
            priority_order = []
            system_labels = {"INBOX", "SENT", "DRAFT", "STARRED", "IMPORTANT",
                           "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS",
                           "CATEGORY_UPDATES", "CATEGORY_FORUMS"}

            for name in sorted(src_labels.keys()):
                if name in SKIP_LABELS:
                    continue
                if name in system_labels:
                    continue
                priority_order.append(name)
            for name in sorted(src_labels.keys()):
                if name in SKIP_LABELS:
                    continue
                if name in system_labels and name not in [l for l in priority_order]:
                    priority_order.append(name)

            log(f"Processing {len(priority_order)} folders")

            for folder in priority_order:
                folder_st = get_folder_state(state, folder)
                if folder_st.get("completed") and folder in state.get("completed_folders", []):
                    log(f"  Skipping completed: {folder}")
                    continue
                if remaining_bytes <= 0:
                    log("Size limit reached, stopping")
                    break

                log(f"\n--- Folder: {folder} ---")
                copied, bts, skipped = copy_messages(
                    src_token, dst_token, folder, state,
                    limit_bytes=remaining_bytes
                )
                total_copied += copied
                total_bytes += bts
                total_skipped += skipped
                remaining_bytes -= bts

        elif STRATEGY == "random":
            query = gmail_query_for_folder(FOLDER)
            messages = list_all_messages(src_token, query=query)
            import random
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

    except KeyboardInterrupt:
        log("Interrupted — saving state")
        state["status"] = "interrupted"
        save_state(state)
    except Exception as e:
        log(f"FATAL: {e}")
        state["status"] = "failed"
        state.setdefault("errors", []).append({"error": str(e)[:500]})
        save_state(state)

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
