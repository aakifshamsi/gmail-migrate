import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const githubToken = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;

  if (!githubToken || !repo) {
    return NextResponse.json(
      { error: "Missing required env vars: GITHUB_TOKEN, GITHUB_REPO" },
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

  const inputs: Record<string, string> = {
    strategy: String(strategy),
    size_limit_mb: String(sizeLimitMb),
    email_limit: String(emailLimit),
    folder: String(folder),
    destination: String(destination),
    dry_run: dryRun ? "true" : "false",
    skip_dedup: skipDedup ? "true" : "false",
    batch_size: String(batchSize),
    delete_from_source: deleteFromSource ? "true" : "false",
  };

  // migration_folders is passed via env override in the workflow
  // We encode it as a workflow input added in Phase 1
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
