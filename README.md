# Gmail IMAP Migration

Migrate emails from **aakifshamsi@gmail.com** → **aakif007@gmail.com** + **aakif17@gmail.com** using imapsync.

## Architecture

- **Source:** aakifshamsi@gmail.com
- **Dest 1:** aakif007@gmail.com → `migration-state-dest1.json`
- **Dest 2:** aakif17@gmail.com → `migration-state-dest2.json`
- **Orchestration:** GitHub Actions (parallel matrix strategy)
- **Notifications:** ntfy.sh + Monetag referral link

## Folder convention

All migrated mail lands under `G-aakifshamsi@gmail.com/` in each destination.

## Quick Start

### 1. Create a GitHub repo and push this project

```bash
cd gmail-migration
git init && git add -A && git commit -m "init gmail migration"
gh repo create gmail-migration --private --source=. --push
```

### 2. Set up GitHub Secrets

Go to **Settings → Secrets → Actions** and add:

| Secret | Value |
|--------|-------|
| `GMAIL_SOURCE_USER` | `aakifshamsi@gmail.com` |
| `GMAIL_SOURCE_APP_PASS` | *(16-char App Password)* |
| `GMAIL_DEST1_USER` | `aakif007@gmail.com` |
| `GMAIL_DEST1_APP_PASS` | *(App Password for dest1)* |
| `GMAIL_DEST2_USER` | `aakif17@gmail.com` |
| `GMAIL_DEST2_APP_PASS` | *(App Password for dest2)* |
| `NTFY_TOPIC` | *(pick an unguessable topic name)* |
| `GH_TOKEN` | *(PAT with `repo` scope)* |

### 3. Run tests first

Go to **Actions → Gmail Migration — Tests & Integrity Checks → Run workflow**:
- Strategy: `all`
- Destination: `both`
- Enable integrity check: `true`

This runs dry-runs of all strategies + connection checks without writing anything.

### 4. Run migration (ad hoc)

Go to **Actions → Gmail IMAP Migration → Run workflow**:
- Strategy: `size` (recommended first run)
- Size limit: `500` MB (safe daily cap)
- Destination: `both`
- Dry run: `true` first, then `false`
- Delete from source: `false` (keep it false until you've verified)

### 5. Schedule

The `migrate.yml` workflow already has a daily cron at 03:00 UTC. It runs incrementally — safe to leave on.

## Cleanup: Delete from Source

After successful migration to **both** destinations, you can free up source storage:

1. Go to **Actions → Gmail IMAP Migration → Run workflow**
2. Set `delete_from_source: true`
3. The workflow will:
   - Verify both destinations have all mail (folder-by-folder comparison)
   - Dry-run preview what would be deleted
   - Execute deletion with `--delete2 --expunge2`
   - Report storage freed in the notification

**⚠️ WARNING:** This is PERMANENT. Only enable after:
- At least 2 full successful migrations
- Integrity checks pass on both destinations
- You're comfortable with the dry-run preview

## Notifications

Set `NTFY_TOPIC` to an unguessable string. You'll get push notifications on:
- 🚀 Migration start
- 📊 Every 500 emails / 100 MB
- ✅ Completion (includes storage copied)
- 🧹 Cleanup (includes storage freed from source)
- ❌ Errors / overquota

All notifications include a Monetag referral link.

Subscribe to `https://ntfy.sh/<your-topic>` on your phone.

## Safety

- `--delete2` is **never used during migration** — only during explicit cleanup
- Messages > 25 MB are skipped (Gmail limit)
- Excludes `[Gmail]/All Mail`, `[Gmail]/Spam`, `[Gmail]/Trash` to avoid duplicates
- Rate-limited: 1 email/sec sleep, 500 MB/day cap recommended
- Always start with `dry_run: true`
- Cleanup verifies BOTH destinations before deleting from source
