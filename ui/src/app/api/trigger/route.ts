import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const githubToken = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const workerUrl = process.env.WORKER_URL;
  const workerAuthToken = process.env.WORKER_AUTH_TOKEN;
  const sourceEmail = process.env.GMAIL_SOURCE_USER;

  if (!githubToken || !repo) {
    return NextResponse.json(
      { error: "Missing required env vars: GITHUB_TOKEN, GITHUB_REPO" },
      { status: 500 }
    );
  }

  if (!workerUrl || !workerAuthToken || !sourceEmail) {
    return NextResponse.json(
      { error: "Missing required env vars: WORKER_URL, WORKER_AUTH_TOKEN, GMAIL_SOURCE_USER" },
      { status: 500 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    strategy = "size",
    sizeLimitMb = 500,
    emailLimit = 0,
    folder = "INBOX",
    destination = "both",
    dryRun = true,
    skipDedup = false,
    batchSize = 10,
    migrationFolders = "",
    deleteFromSource = false,
  } = body as {
    strategy?: string;
    sizeLimitMb?: number;
    emailLimit?: number;
    folder?: string;
    destination?: string;
    dryRun?: boolean;
    skipDedup?: boolean;
    batchSize?: number;
    migrationFolders?: string;
    deleteFromSource?: boolean;
  };

  // --- Token preflight gate ---
  // Verify source account token is valid before dispatching to GitHub Actions.
  // Prevents false-positive "dispatched" when token is 404/revoked (issue #12).
  try {
    const tokenRes = await fetch(
      `${workerUrl}/api/token?email=${encodeURIComponent(sourceEmail)}`,
      {
        headers: {
          Authorization: `Bearer ${workerAuthToken}`,
        },
      }
    );
    if (!tokenRes.ok) {
      const errBody = await tokenRes.text().catch(() => "");
      return NextResponse.json(
        {
          error: `Source account token invalid (${tokenRes.status}) — re-authorize at /auth/${encodeURIComponent(sourceEmail)}. Details: ${errBody.slice(0, 200)}`,
        },
        { status: 400 }
      );
    }

    const tokenData = await tokenRes.json() as { access_token?: string };
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return NextResponse.json(
        { error: "Source account token missing — re-authorize before running migration." },
        { status: 400 }
      );
    }

    // Verify the token works and matches expected account
    const profileRes = await fetch(
      "https://www.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!profileRes.ok) {
      return NextResponse.json(
        { error: `Source Gmail token rejected (HTTP ${profileRes.status}) — re-authorize before running migration.` },
        { status: 400 }
      );
    }
    const profile = await profileRes.json() as { emailAddress?: string };
    const actualEmail = profile.emailAddress ?? "";
    if (actualEmail.toLowerCase() !== sourceEmail.toLowerCase()) {
      return NextResponse.json(
        { error: `Token email mismatch: expected ${sourceEmail}, got ${actualEmail}. Check GMAIL_SOURCE_USER env var.` },
        { status: 400 }
      );
    }
  } catch (err: unknown) {
    return NextResponse.json(
      { error: `Token preflight failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
  // --- End token preflight gate ---

  // Step 2 fix: pass boolean workflow inputs as actual booleans, not strings.
  // GitHub Actions workflow_dispatch API accepts true/false for type: boolean inputs.
  const inputs: Record<string, string | boolean | number> = {
    strategy: String(strategy),
    size_limit_mb: String(sizeLimitMb),
    email_limit: String(emailLimit),
    folder: String(folder),
    destination: String(destination),
    dry_run: Boolean(dryRun),
    skip_dedup: Boolean(skipDedup),
    batch_size: String(batchSize),
    delete_from_source: Boolean(deleteFromSource),
  };

  // migration_folders is passed via env override in the workflow
  if (migrationFolders) {
    inputs.migration_folders = String(migrationFolders);
  }

  const dispatchRes = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/migrate.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gmail-migrate-ui/1.0",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    }
  );

  if (!dispatchRes.ok) {
    const text = await dispatchRes.text().catch(() => "");
    return NextResponse.json(
      { error: `GitHub dispatch failed (${dispatchRes.status}): ${text.slice(0, 400)}` },
      { status: dispatchRes.status }
    );
  }

  // 204 No Content on success
  return NextResponse.json({ status: "dispatched" });
}
