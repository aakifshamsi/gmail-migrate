import { NextResponse } from "next/server";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const SKIP_LABELS = new Set(["TRASH", "SPAM", "DRAFT", "UNREAD", "CHAT", "STARRED_UNREAD"]);
const SYSTEM_INCLUDE = new Set(["INBOX", "SENT", "STARRED", "IMPORTANT"]);

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  messagesTotal?: number;
  messagesUnread?: number;
}

export async function GET() {
  const workerUrl = process.env.WORKER_URL?.replace(/\/$/, "");
  const workerToken = process.env.WORKER_AUTH_TOKEN;
  const sourceUser = process.env.GMAIL_SOURCE_USER;

  if (!workerUrl || !workerToken || !sourceUser) {
    return NextResponse.json(
      { error: "Missing required env vars: WORKER_URL, WORKER_AUTH_TOKEN, GMAIL_SOURCE_USER" },
      { status: 500 }
    );
  }

  // 1. Get access token from CF Worker
  const tokenRes = await fetch(
    `${workerUrl}/api/token?email=${encodeURIComponent(sourceUser)}`,
    { headers: { Authorization: `Bearer ${workerToken}` }, cache: "no-store" }
  );
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    return NextResponse.json(
      { error: `Token fetch failed (${tokenRes.status}): ${body.slice(0, 200)}` },
      { status: 502 }
    );
  }
  const { access_token } = await tokenRes.json();

  // 2. List all labels
  const labelsRes = await fetch(`${GMAIL_API}/labels`, {
    headers: { Authorization: `Bearer ${access_token}` },
    cache: "no-store",
  });
  if (!labelsRes.ok) {
    return NextResponse.json(
      { error: `Gmail labels list failed (${labelsRes.status})` },
      { status: 502 }
    );
  }
  const labelsData = await labelsRes.json();
  const allLabels: GmailLabel[] = labelsData.labels || [];

  // 3. Filter to interesting labels
  const interesting = allLabels.filter(
    (l) =>
      !SKIP_LABELS.has(l.name) &&
      !l.name.startsWith("CATEGORY_") &&
      (l.type === "user" || SYSTEM_INCLUDE.has(l.name))
  );

  // 4. Fetch individual label details in parallel (for messagesTotal)
  //    Chunk to avoid overwhelming the API
  const CHUNK = 15;
  const detailed: GmailLabel[] = [];

  for (let i = 0; i < interesting.length; i += CHUNK) {
    const chunk = interesting.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map((l) =>
        fetch(`${GMAIL_API}/labels/${l.id}`, {
          headers: { Authorization: `Bearer ${access_token}` },
          cache: "no-store",
        })
          .then((r) => (r.ok ? r.json() : l))
          .catch(() => l)
      )
    );
    detailed.push(...results);
  }

  // 5. Build response — skip empty folders, sort by size desc
  const folders = detailed
    .map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type || "user",
      messagesTotal: l.messagesTotal || 0,
      estimatedBytes: (l.messagesTotal || 0) * 76800, // ~75 KB/message average
    }))
    .filter((f) => f.messagesTotal > 0)
    .sort((a, b) => b.messagesTotal - a.messagesTotal);

  return NextResponse.json(folders);
}
