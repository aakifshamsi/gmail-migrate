# Changelog

All notable changes to Gmail Migrate are documented here.

---

## [Unreleased] — Next Sprint

### Planned
- #12 **BUG**: Preflight token validation in `migrate.py` — fail fast if source/dest tokens revoked
- #13 **TASK**: Real-time OAuth token status per account in dashboard (valid / expired / revoked)
- Unit test suite for `cleanup.py` and `migrate.py` (pytest, no real credentials)
- CI workflow (`ci.yml`) running tests on every push to `scripts/`
- Custom domain `migrate.digitalhands.in` on Vercel

---

## [0.4.0] — 2026-04-01 — Safety Overhaul (PR #9 + PR #10)

### Fixed — Critical (Issue #8)
- **`cleanup.py` caused ~4GB permanent email deletion** — `batchDelete` bypasses Trash and was called on ALL labels without per-message verification. Root causes:
  - `delete_from_source` defaulted to `true` in `migrate.yml`
  - Verify step used `resultSizeEstimate` (documented as unreliable)
  - No per-message check that each email existed in destination before deleting
  - Cron schedule could trigger unattended runs

### Changed
- `cleanup.py` now uses `messages.trash` (recoverable for 30 days) instead of `batchDelete`
- Cleanup is manifest-driven: only trashes messages recorded in migration state files as having been copied
- Per-message fingerprint verification (Message-ID + Subject + From) against ALL destination accounts before trashing
- Messages without Message-ID or not found in destination are **kept**
- Only user-created labels processed — system labels (INBOX, SENT, SPAM, TRASH, CATEGORY_*) skipped
- `delete_from_source` default changed from `true` → `false` in `migrate.yml`
- Cron schedule disabled (commented out)
- Clear FATAL error message when manifest is missing: instructs user to run migration first
- `migrate.py` now records a fingerprint (Message-ID, Subject, From, Date) per copied message into `state["migrated_messages"]`
- `search_message_id_in_dest` returns candidate Gmail IDs for full fingerprint comparison (not just bool)

### Security
- PR #11: `next` upgraded `15.3.0` → `15.3.8` — patches CVE-2025-55182 / CVE-2025-66478 (RCE in React Server Components)

---

## [0.3.0] — 2026-03-31 — Vercel UI + GitHub Actions Dashboard

### Added
- Vercel Next.js UI (`ui/`) — migration control panel
- Dynamic account selection from CF Worker `/api/accounts` — no hard-coded emails
- GitHub Actions jobs panel with Cancel / Re-run controls, auto-polls every 15s
- Dark/light theme switcher persisted to `localStorage`
- `/api/accounts` proxy route (Next.js) — fetches connected accounts from CF Worker
- `/api/jobs` route — lists recent workflow runs, cancel/rerun actions
- Reconnect button per account in CF Worker dashboard
- `ThemeToggle` component

### Fixed
- OAuth scope changed to `https://mail.google.com/` — `gmail.modify` does not cover `messages.batchDelete`
- TypeScript type error in jobs route (`object[]` → `Record<string, unknown>[]`)
- `/api/folders` now accepts query params for dynamic source/dest selection
- Multipart/related upload for message import — avoids 5MB cap of base64-in-JSON encoding, supports up to 36MB messages
- Non-retryable 400 errors (invalid attachment) now skip rather than abort folder
- 404 on source message fetch handled gracefully (message already deleted/moved)
- Base64 padding fix for raw message decode

---

## [0.2.0] — 2026-03-30 — CF Worker Refactor

### Changed
- CF Worker refactored to thin token vault (`src/index.js`, `src/services.js`, `src/dashboardHtml.js`)
- Migration logic moved from CF Worker to GitHub Actions + `scripts/migrate.py`
- `migrate.py` uses OAuth tokens from CF Worker, calls Gmail API directly
- HMAC-signed OAuth state cookie for CSRF protection
- Monetag service-worker integration

### Added
- `scripts/cleanup.py` (initial version — later overhauled in 0.4.0)
- `test/smoke.js` — OAuth state lifecycle and backup read failure tests
- GitHub Actions `test.yml` — dry-run migration validation

---

## [0.1.0] — 2026-03-28 — Initial

- Cloudflare Worker v3 handling Gmail migration directly
- IMAP migration via `migrate.sh` + imapsync
- ntfy.sh push notifications
- State file persistence (JSON) committed to repo
