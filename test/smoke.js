/**
 * Behavioral smoke tests for OAuth state lifecycle and backup read failures.
 * Run: node test/smoke.js   (requires Node 18+)
 */
import assert from "node:assert/strict";
import { buildAuthRedirect, isOAuthStateValid } from "../src/services.js";

let pass = 0, fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log("  ok  " + name);
    pass++;
  } catch (err) {
    console.error(" FAIL " + name + "\n       " + err.message);
    fail++;
  }
}

const ENV = { GOOGLE_CLIENT_ID: "test-cid", GOOGLE_CLIENT_SECRET: "test-secret-for-hmac" };

function fakeReq(cookieState) {
  return { headers: { get: (h) => h.toLowerCase() === "cookie" ? "oauth_state=" + cookieState : null } };
}

// ── OAuth state lifecycle ────────────────────────────────────────────────────

console.log("\nOAuth state lifecycle");

await test("buildAuthRedirect returns a Google OAuth URL", async () => {
  const { location } = await buildAuthRedirect(new URL("https://w.test/auth/any"), ENV, "any");
  assert.ok(location.startsWith("https://accounts.google.com/o/oauth2/v2/auth"), "unexpected base URL: " + location);
});

await test("buildAuthRedirect embeds HMAC-signed state in the URL", async () => {
  const { location, state } = await buildAuthRedirect(new URL("https://w.test/auth/any"), ENV, "any");
  assert.ok(state.includes("."), "state should have <payload>.<sig> format");
  assert.ok(location.includes(encodeURIComponent(state)), "state should appear in redirect URL");
});

await test("isOAuthStateValid accepts a freshly built state", async () => {
  const { state } = await buildAuthRedirect(new URL("https://w.test/auth/any"), ENV, "any");
  assert.ok(await isOAuthStateValid(fakeReq(state), state, ENV));
});

await test("isOAuthStateValid rejects state with wrong cookie", async () => {
  const { state } = await buildAuthRedirect(new URL("https://w.test/auth/any"), ENV, "any");
  const req = { headers: { get: (h) => h.toLowerCase() === "cookie" ? "oauth_state=wrong" : null } };
  assert.ok(!await isOAuthStateValid(req, state, ENV));
});

await test("isOAuthStateValid rejects tampered HMAC signature", async () => {
  const { state } = await buildAuthRedirect(new URL("https://w.test/auth/any"), ENV, "any");
  const tampered = state.slice(0, -4) + "XXXX";
  assert.ok(!await isOAuthStateValid(fakeReq(tampered), tampered, ENV));
});

await test("isOAuthStateValid rejects state signed with a different secret", async () => {
  const { state } = await buildAuthRedirect(new URL("https://w.test/auth/any"), ENV, "any");
  const wrongEnv = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "different-secret" };
  assert.ok(!await isOAuthStateValid(fakeReq(state), state, wrongEnv));
});

await test("isOAuthStateValid rejects expired state (>10 min)", async () => {
  const nonce = crypto.randomUUID();
  const ts = Date.now() - 11 * 60 * 1000;
  const payload = btoa(JSON.stringify({ nonce, ts }));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(ENV.GOOGLE_CLIENT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  )));
  const state = payload + "." + sig;
  assert.ok(!await isOAuthStateValid(fakeReq(state), state, ENV));
});

await test("isOAuthStateValid rejects null/empty state", async () => {
  assert.ok(!await isOAuthStateValid(fakeReq(""), "", ENV));
  assert.ok(!await isOAuthStateValid(fakeReq(""), null, ENV));
});

// ── Backup read failure handling ─────────────────────────────────────────────

console.log("\nBackup read failure handling");

await test("githubBackupRead returns null and logs on non-404 HTTP error", async () => {
  // Swap in a mock fetch for this test only
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 500,
    ok: false,
    text: async () => "Internal Server Error"
  });

  const logged = [];
  const origError = console.error;
  console.error = (...a) => logged.push(a.join(" "));

  // Dynamic import with cache-busting so the mocked fetch is picked up
  const { githubBackupRead } = await import("../src/services.js?t=" + Date.now());
  const result = await githubBackupRead({
    GH_BACKUP_TOKEN: "tok",
    GH_BACKUP_REPO: "owner/repo",
    GH_BACKUP_PATH: "backup.json"
  });

  globalThis.fetch = origFetch;
  console.error = origError;

  assert.equal(result, null, "should return null on HTTP 500");
  assert.ok(
    logged.some(l => l.includes("500")),
    "should log the HTTP status; got: " + JSON.stringify(logged)
  );
});

await test("githubBackupRead returns empty skeleton on 404", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 404, ok: false });

  const { githubBackupRead } = await import("../src/services.js?t=" + Date.now());
  const result = await githubBackupRead({
    GH_BACKUP_TOKEN: "tok",
    GH_BACKUP_REPO: "owner/repo",
    GH_BACKUP_PATH: "backup.json"
  });

  globalThis.fetch = origFetch;

  assert.notEqual(result, null, "404 should return skeleton, not null");
  assert.deepEqual(result.data.sessions, {});
  assert.deepEqual(result.data.pending_stats, []);
  assert.equal(result.sha, null);
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log("\n" + pass + " passed, " + fail + " failed\n");
if (fail > 0) process.exit(1);
