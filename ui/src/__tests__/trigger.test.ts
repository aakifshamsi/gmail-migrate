/**
 * Unit tests for /api/trigger route.
 *
 * Verifies:
 *  1. Boolean inputs are sent as booleans (not strings) to GitHub Actions API
 *  2. Dispatch is blocked (400) when source token preflight fails
 *  3. Destination parameter is passed through correctly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── helpers ────────────────────────────────────────────────────────────────

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Capture the body sent to a fetch call by position. */
function capturedBody(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const call = fetchMock.mock.calls[callIndex];
  const init = call?.[1] as RequestInit | undefined;
  if (!init?.body) return {};
  return JSON.parse(init.body as string);
}

// ── environment setup ──────────────────────────────────────────────────────

const ENV = {
  GITHUB_TOKEN: "gh-test-token",
  GITHUB_REPO: "owner/repo",
  WORKER_URL: "https://worker.example.com",
  WORKER_AUTH_TOKEN: "worker-auth-token",
  GMAIL_SOURCE_USER: "source@gmail.com",
};

beforeEach(() => {
  vi.resetModules();
  // Inject env vars into process.env (Next.js API routes read from here)
  Object.assign(process.env, ENV);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("POST /api/trigger — boolean inputs", () => {
  it("sends dry_run as boolean true to GitHub Actions, not string 'true'", async () => {
    const fetchMock = vi.fn()
      // 1st call: Worker token fetch → success
      .mockResolvedValueOnce(makeResponse({ access_token: "gmail-access-token" }))
      // 2nd call: Gmail /profile → valid
      .mockResolvedValueOnce(makeResponse({ emailAddress: "source@gmail.com" }))
      // 3rd call: GitHub dispatch → 204
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("../app/api/trigger/route");
    const req = new Request("http://localhost/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true, destination: "dest1" }),
    });

    await POST(req);

    // GitHub dispatch is the 3rd fetch call
    const body = capturedBody(fetchMock, 2);
    const inputs = body.inputs as Record<string, unknown>;
    expect(typeof inputs.dry_run).toBe("boolean");
    expect(inputs.dry_run).toBe(true);
  });

  it("sends delete_from_source as boolean false, not string 'false'", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({ access_token: "gmail-access-token" }))
      .mockResolvedValueOnce(makeResponse({ emailAddress: "source@gmail.com" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("../app/api/trigger/route");
    const req = new Request("http://localhost/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleteFromSource: false }),
    });

    await POST(req);

    const body = capturedBody(fetchMock, 2);
    const inputs = body.inputs as Record<string, unknown>;
    expect(typeof inputs.delete_from_source).toBe("boolean");
    expect(inputs.delete_from_source).toBe(false);
  });
});

describe("POST /api/trigger — token preflight gate", () => {
  it("returns 400 when Worker returns 404 (no token stored)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "No token for source@gmail.com" }), { status: 404 })
      );

    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("../app/api/trigger/route");
    const req = new Request("http://localhost/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/token invalid|re-authorize/i);
    // GitHub dispatch should NOT have been called
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when Gmail /profile returns 401 (token revoked)", async () => {
    const fetchMock = vi.fn()
      // Worker: token found
      .mockResolvedValueOnce(makeResponse({ access_token: "revoked-token" }))
      // Gmail: 401
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("../app/api/trigger/route");
    const req = new Request("http://localhost/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/rejected|re-authorize/i);
    // GitHub dispatch should NOT have been called
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when token email mismatches GMAIL_SOURCE_USER", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({ access_token: "good-token" }))
      .mockResolvedValueOnce(makeResponse({ emailAddress: "different@gmail.com" }));

    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("../app/api/trigger/route");
    const req = new Request("http://localhost/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mismatch/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/trigger — destination passthrough", () => {
  it("passes destination=dest1 when UI sends dest1", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse({ access_token: "token" }))
      .mockResolvedValueOnce(makeResponse({ emailAddress: "source@gmail.com" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("../app/api/trigger/route");
    const req = new Request("http://localhost/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destination: "dest1" }),
    });

    await POST(req);

    const body = capturedBody(fetchMock, 2);
    expect((body.inputs as Record<string, unknown>).destination).toBe("dest1");
  });
});
