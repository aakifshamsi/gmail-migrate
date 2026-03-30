import { NextResponse } from "next/server";

const GH_API = "https://api.github.com";

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "gmail-migrate-ui",
  };
}

export async function GET() {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return NextResponse.json({ error: "Missing GITHUB_TOKEN or GITHUB_REPO" }, { status: 500 });
  }

  // Fetch recent runs for migrate + cleanup workflows in parallel
  const [mRes, cRes] = await Promise.all([
    fetch(`${GH_API}/repos/${repo}/actions/workflows/migrate.yml/runs?per_page=5`, { headers: ghHeaders(token), cache: "no-store" }),
    fetch(`${GH_API}/repos/${repo}/actions/workflows/cleanup.yml/runs?per_page=3`, { headers: ghHeaders(token), cache: "no-store" }),
  ]);

  const runs: Record<string, unknown>[] = [];
  if (mRes.ok) { const d = await mRes.json(); runs.push(...(d.workflow_runs ?? [])); }
  if (cRes.ok) { const d = await cRes.json(); runs.push(...(d.workflow_runs ?? [])); }

  const mapped = runs.map((r: Record<string, unknown>) => ({
    id:         r.id,
    name:       r.name,
    status:     r.status,       // queued | in_progress | completed
    conclusion: r.conclusion,   // success | failure | cancelled | null
    created_at: r.created_at,
    updated_at: r.updated_at,
    html_url:   r.html_url,
    display_title: r.display_title ?? r.name,
  }));

  // Sort newest first
  mapped.sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime());

  return NextResponse.json(mapped);
}

export async function POST(request: Request) {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPO;
  if (!token || !repo) {
    return NextResponse.json({ error: "Missing GITHUB_TOKEN or GITHUB_REPO" }, { status: 500 });
  }

  const { runId, action } = await request.json();
  if (!runId || !action) return NextResponse.json({ error: "Missing runId or action" }, { status: 400 });

  const endpoint = action === "cancel"
    ? `${GH_API}/repos/${repo}/actions/runs/${runId}/cancel`
    : action === "rerun"
    ? `${GH_API}/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`
    : null;

  if (!endpoint) return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const res = await fetch(endpoint, { method: "POST", headers: ghHeaders(token) });
  if (!res.ok && res.status !== 202) {
    const body = await res.text().catch(() => "");
    return NextResponse.json({ error: `GitHub ${res.status}: ${body.slice(0, 100)}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
