import { NextResponse } from "next/server";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SKIP = new Set(["TRASH", "SPAM", "DRAFT", "UNREAD", "CHAT"]);
const SYS_INCLUDE = new Set(["INBOX", "SENT", "STARRED", "IMPORTANT"]);

interface GLabel { id: string; name: string; type?: string; messagesTotal?: number; }

async function getToken(workerUrl: string, token: string, email: string): Promise<string> {
  const res = await fetch(`${workerUrl}/api/token?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token fetch failed for ${email} (${res.status}): ${body.slice(0, 200)}`);
  }
  const { access_token } = await res.json();
  if (!access_token) throw new Error(`No access_token for ${email}`);
  return access_token;
}

async function listLabels(token: string): Promise<GLabel[]> {
  const res = await fetch(`${GMAIL_API}/labels`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  if (!res.ok) throw new Error(`Labels list failed: ${res.status}`);
  return (await res.json()).labels ?? [];
}

async function getLabelDetail(token: string, id: string): Promise<GLabel> {
  const res = await fetch(`${GMAIL_API}/labels/${id}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
  });
  return res.ok ? res.json() : { id, name: "", messagesTotal: 0 };
}

async function batchDetails(token: string, labels: GLabel[], chunkSize = 15): Promise<GLabel[]> {
  const out: GLabel[] = [];
  for (let i = 0; i < labels.length; i += chunkSize) {
    const chunk = labels.slice(i, i + chunkSize);
    const results = await Promise.all(chunk.map(l => getLabelDetail(token, l.id).catch(() => l)));
    out.push(...results);
  }
  return out;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const workerUrl = process.env.WORKER_URL?.replace(/\/$/, "");
  const workerToken = process.env.WORKER_AUTH_TOKEN;
  // Prefer query params (set by UI); fall back to env vars for CI/scripted use
  const sourceUser = searchParams.get("source") ?? process.env.GMAIL_SOURCE_USER;
  const dest1User  = searchParams.get("dest1")  ?? null;
  const dest2User  = searchParams.get("dest2")  ?? null;

  if (!workerUrl || !workerToken || !sourceUser) {
    return NextResponse.json(
      { error: "Missing env vars: WORKER_URL, WORKER_AUTH_TOKEN, GMAIL_SOURCE_USER" },
      { status: 500 }
    );
  }

  try {
    // Fetch tokens in parallel; dest tokens are optional
    const [srcTok, d1Tok, d2Tok] = await Promise.all([
      getToken(workerUrl, workerToken, sourceUser),
      dest1User ? getToken(workerUrl, workerToken, dest1User).catch(() => null) : Promise.resolve(null),
      dest2User ? getToken(workerUrl, workerToken, dest2User).catch(() => null) : Promise.resolve(null),
    ]);

    // List labels for all accounts in parallel
    const [g1All, g2All, g3All] = await Promise.all([
      listLabels(srcTok),
      d1Tok ? listLabels(d1Tok).catch(() => [] as GLabel[]) : Promise.resolve([] as GLabel[]),
      d2Tok ? listLabels(d2Tok).catch(() => [] as GLabel[]) : Promise.resolve([] as GLabel[]),
    ]);

    // Filter G1 to interesting labels
    const g1 = g1All.filter(l =>
      !SKIP.has(l.name) && !l.name.startsWith("CATEGORY_") &&
      (l.type === "user" || SYS_INCLUDE.has(l.name))
    );

    // Build G2/G3 name→id maps (labels prefixed with G-{source}/)
    const prefix = `G-${sourceUser}/`;
    const g2Map = new Map<string, string>();
    const g3Map = new Map<string, string>();
    for (const l of g2All) if (l.name.startsWith(prefix)) g2Map.set(l.name.slice(prefix.length), l.id);
    for (const l of g3All) if (l.name.startsWith(prefix)) g3Map.set(l.name.slice(prefix.length), l.id);

    // Fetch G1 label details (for messagesTotal)
    const g1Detailed = await batchDetails(srcTok, g1);

    // Fetch G2/G3 details only for labels that exist there
    const g2Ids = g1.map(l => g2Map.get(l.name)).filter(Boolean) as string[];
    const g3Ids = g1.map(l => g3Map.get(l.name)).filter(Boolean) as string[];

    const [g2Detailed, g3Detailed] = await Promise.all([
      d1Tok && g2Ids.length ? batchDetails(d1Tok, g2Ids.map(id => ({ id, name: "" }))) : Promise.resolve([]),
      d2Tok && g3Ids.length ? batchDetails(d2Tok, g3Ids.map(id => ({ id, name: "" }))) : Promise.resolve([]),
    ]);

    const g2ById = new Map(g2Detailed.map(l => [l.id, l.messagesTotal ?? 0]));
    const g3ById = new Map(g3Detailed.map(l => [l.id, l.messagesTotal ?? 0]));

    const rows = g1Detailed
      .map(l => ({
        id: l.id,
        name: l.name,
        type: l.type ?? "user",
        g1Count: l.messagesTotal ?? 0,
        estimatedBytes: (l.messagesTotal ?? 0) * 76800,
        g2Count: g2ById.get(g2Map.get(l.name) ?? "") ?? 0,
        g3Count: g3ById.get(g3Map.get(l.name) ?? "") ?? 0,
      }))
      .filter(r => r.g1Count > 0)
      .sort((a, b) => b.g1Count - a.g1Count);

    return NextResponse.json({ rows, sourceUser, dest1User, dest2User });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
