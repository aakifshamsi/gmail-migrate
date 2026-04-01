import { NextResponse } from "next/server";

/**
 * GET /api/token-status?email={email}
 *
 * Checks whether the OAuth token for the given account is valid by:
 * 1. Fetching the token from the CF Worker vault (/api/token?email=...)
 * 2. Calling Gmail /profile to verify the token works and matches the account
 *
 * Returns:
 *   { email, valid: true, checkedAt }
 *   { email, valid: false, error: "...", checkedAt }
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");

  if (!email) {
    return NextResponse.json({ error: "Missing email query param" }, { status: 400 });
  }

  const workerUrl = process.env.WORKER_URL?.replace(/\/$/, "");
  const workerToken = process.env.WORKER_AUTH_TOKEN;

  if (!workerUrl || !workerToken) {
    return NextResponse.json(
      { email, valid: false, error: "Server misconfigured: missing WORKER_URL or WORKER_AUTH_TOKEN" },
      { status: 500 }
    );
  }

  const checkedAt = new Date().toISOString();

  // Step 1: fetch token from CF Worker vault
  let accessToken: string;
  try {
    const tokenRes = await fetch(
      `${workerUrl}/api/token?email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${workerToken}` }, cache: "no-store" }
    );
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      return NextResponse.json({
        email,
        valid: false,
        error: `Token not found (${tokenRes.status}): ${body.slice(0, 150)}`,
        checkedAt,
      });
    }
    const data = await tokenRes.json() as { access_token?: string };
    if (!data.access_token) {
      return NextResponse.json({
        email,
        valid: false,
        error: "No access_token in Worker response",
        checkedAt,
      });
    }
    accessToken = data.access_token;
  } catch (err: unknown) {
    return NextResponse.json({
      email,
      valid: false,
      error: `Worker fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      checkedAt,
    });
  }

  // Step 2: verify token against Gmail /profile
  try {
    const profileRes = await fetch(
      "https://www.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" }
    );
    if (!profileRes.ok) {
      return NextResponse.json({
        email,
        valid: false,
        error: `Gmail token rejected (HTTP ${profileRes.status}) — re-authorize`,
        checkedAt,
      });
    }
    const profile = await profileRes.json() as { emailAddress?: string };
    const actual = profile.emailAddress ?? "";
    if (actual.toLowerCase() !== email.toLowerCase()) {
      return NextResponse.json({
        email,
        valid: false,
        error: `Token email mismatch: expected ${email}, got ${actual}`,
        checkedAt,
      });
    }
  } catch (err: unknown) {
    return NextResponse.json({
      email,
      valid: false,
      error: `Gmail profile check failed: ${err instanceof Error ? err.message : String(err)}`,
      checkedAt,
    });
  }

  return NextResponse.json({ email, valid: true, checkedAt });
}
