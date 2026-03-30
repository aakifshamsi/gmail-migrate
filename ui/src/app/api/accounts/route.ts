import { NextResponse } from "next/server";

export async function GET() {
  const workerUrl = process.env.WORKER_URL?.replace(/\/$/, "");
  const workerToken = process.env.WORKER_AUTH_TOKEN;
  if (!workerUrl || !workerToken) {
    return NextResponse.json({ error: "Missing WORKER_URL or WORKER_AUTH_TOKEN" }, { status: 500 });
  }
  const res = await fetch(`${workerUrl}/api/accounts`, {
    headers: { Authorization: `Bearer ${workerToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json({ error: `CF Worker ${res.status}: ${body.slice(0, 100)}` }, { status: 502 });
  }
  const accounts: string[] = await res.json();
  return NextResponse.json(accounts);
}
