# Gmail Migration (Token Vault + GitHub Actions Engine)

This repo now uses a **thin Cloudflare Worker token vault** and runs all migration/cleanup logic in **GitHub Actions + Python scripts**.

## Architecture

- **Cloudflare Worker (modularized)**
  - `src/index.js`: route wiring + response shaping
  - `src/services.js`: OAuth, token refresh, KV/GitHub-backup persistence, stats tracking
  - `src/dashboardHtml.js`: dashboard UI template
  - `src/monetagSw.js`: Monetag service-worker verification payload
- **Worker endpoints**
  - `GET /`: dashboard UI
  - `GET /sw.js`: Monetag service-worker verification script
  - `GET /auth/:email`, `GET /callback`: Google OAuth flow
  - `GET /api/token?email=...`: vend fresh access token
  - `GET /api/accounts`, `POST /api/remove`: account management
  - `GET /api/stats`, `POST /api/sync-fallback`: usage snapshot + backup replay
  - OAuth CSRF protection: `/auth/:email` now issues a short-lived `oauth_state` cookie and `/callback` validates it before token exchange
- **GitHub Actions**
  - `.github/workflows/migrate.yml` is the migration engine (matrix by destination)
  - `.github/workflows/test.yml` validates token-vault flow and dry-run migration paths
- **Migration runtime**
  - `scripts/migrate.py` calls Worker token endpoint, then Gmail API directly

## Required GitHub Secrets

| Secret | Purpose |
|---|---|
| `WORKER_URL` | Cloudflare Worker base URL |
| `WORKER_AUTH_TOKEN` | Worker API bearer token |
| `CF_ACCESS_CLIENT_ID` | Optional Cloudflare Access client ID |
| `CF_ACCESS_CLIENT_SECRET` | Optional Cloudflare Access client secret |
| `GMAIL_SOURCE_USER` | Source account email |
| `GMAIL_DEST1_USER` | Destination account #1 |
| `GMAIL_DEST2_USER` | Destination account #2 |
| `GH_TOKEN` | PAT for committing state files from workflow |

## Optional Worker Variables (quota/failover)

| Variable | Purpose |
|---|---|
| `ENABLE_KV_STATS` | Set `true` to enable KV stats counters; leave unset/false to avoid quota usage |
| `GH_BACKUP_TOKEN` | GitHub token for backup failover writes when KV is exhausted |
| `GH_BACKUP_REPO` | Repo slug like `owner/repo` for fallback snapshot storage |
| `GH_BACKUP_PATH` | JSON path inside repo for session/pending stats snapshot |
| `GH_BACKUP_BRANCH` | Optional branch for fallback snapshot writes (default: `main`) |

## Operational Protocol

1. Connect each Gmail account in Worker UI (`/auth/<email>`).
2. Run **Tests** workflow in dry-run mode.
3. Run **Migration** workflow in dry-run mode.
4. Run **Migration** workflow with `dry_run=false`.
5. Optionally run cleanup once both destination states are verified.

## Notes for automation clients (e.g., Cline/Claw)

- Treat Worker as **token authority only**.
- Do not call migration endpoints on Worker (they were removed).
- Trigger/monitor workflows in `.github/workflows/*` as the execution plane.
- Use state artifacts (`migration-state-*.json`, `migration.log`) for resumability and reporting.


## KiloClaw Trial: Assist/Test Flow

1. Open KiloClaw on Android and connect your GitHub account.
2. Point it to this repository and checkout your target branch.
3. Ask KiloClaw to run a PR review with focus on:
   - `src/index.js` auth/token endpoints
   - `.github/workflows/test.yml` token-vault checks
   - `.github/workflows/migrate.yml` migration execution path
4. Run workflows from GitHub Actions UI:
   - **Gmail Migration - Tests** (`strategy=all`, `destination=both`, `integrity_check=true`)
   - **Gmail API Migration** (`dry_run=true` first, then `dry_run=false`)
5. Verify artifacts and summary tables before enabling cleanup.
6. If KiloClaw reports issues, copy/paste the exact file+line feedback for a patch pass.


## Automated Cloudflare Deployment (GitHub Actions)

A deployment workflow now exists at `.github/workflows/deploy-worker.yml`.

### Required GitHub Secrets

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with Worker deploy permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

### How it deploys

- Auto deploy on push to `main` or `work` when worker files change.
- Manual deploy via **Actions → Deploy Cloudflare Worker → Run workflow**.
- Runs: `npx wrangler@4 deploy --config wrangler.jsonc`

## Vercel note

This repository is a Cloudflare Worker + scripts project (not a Next.js app). If connected to Vercel, set framework preset to **Node.js** (or disable auto-deploy hooks) to avoid false Next.js build errors.

## Prompt for a fresh ChatGPT Codex environment

If you start a new Codex task/environment, paste this:

> Open repo `gmail-migrate`. Verify branch and remotes. Configure GitHub remote if missing. Confirm Worker remains token-vault-only (no migration execution in Worker). Run workflow checks for `.github/workflows/test.yml` and `.github/workflows/migrate.yml`. Configure secrets and execute deploy using `.github/workflows/deploy-worker.yml`. Then run test workflow (`strategy=all`, `destination=both`, `integrity_check=true`) and migration workflow (`dry_run=true` then `dry_run=false`). Return exact commands and blockers.
