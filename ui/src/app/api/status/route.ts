import { NextResponse } from "next/server";

interface StateFile {
  status: string;
  processed_emails: number;
  processed_bytes: number;
  last_folder: string | null;
  updated_at: string | null;
  errors: unknown[];
  completed_folders: string[];
}

async function fetchState(token: string, repo: string, path: string): Promise<StateFile | null> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.content) return null;
  try {
    return JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

export async function GET() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return NextResponse.json({ error: "Missing GITHUB_TOKEN or GITHUB_REPO" }, { status: 500 });
  }

  const [d1, d2] = await Promise.all([
    fetchState(token, repo, "migration-state-dest1.json"),
    fetchState(token, repo, "migration-state-dest2.json"),
  ]);

  const summarize = (s: StateFile | null) =>
    s
      ? {
          status: s.status ?? "unknown",
          processed_emails: s.processed_emails ?? 0,
          processed_bytes: s.processed_bytes ?? 0,
          last_folder: s.last_folder ?? null,
          updated_at: s.updated_at ?? null,
          errors_count: s.errors?.length ?? 0,
          completed_folders: s.completed_folders?.length ?? 0,
        }
      : null;

  return NextResponse.json({ dest1: summarize(d1), dest2: summarize(d2) });
}
