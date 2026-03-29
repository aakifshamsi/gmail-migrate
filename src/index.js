/**
 * Gmail Token Vault Worker
 * Thin Cloudflare Worker for OAuth token storage + vending.
 */

import { DASHBOARD_HTML } from "./dashboardHtml.js";
import { MONETAG_SW } from "./monetagSw.js";
import {
  TOKEN_EP,
  qs,
  isKvLimitError,
  isReservedKey,
  isAuthorized,
  gmailProfile,
  githubBackupConfigured,
  githubBackupRead,
  githubBackupWrite,
  getToken,
  track,
  statsEnabled,
  buildAuthRedirect,
  isOAuthStateValid,
  persistOAuthSession
} from "./services.js";

function htmlHeaders(){
  return {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin"
  };
}

function jsHeaders(){
  return {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff"
  };
}

export default {
  async fetch(request, env){
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.startsWith("/api/")) {
        const vaultToken = await env.TOKENS.get("vault:api_token");
        if (!isAuthorized(request, env, url, vaultToken)) {
          return Response.json({error: "Unauthorized"}, {status: 401});
        }
      }

      if (path === "/") return new Response(DASHBOARD_HTML, {headers: htmlHeaders()});
      if (path === "/sw.js") return new Response(MONETAG_SW, {headers: jsHeaders()});

      if (path.startsWith("/auth/")) {
        const hint = decodeURIComponent(path.slice("/auth/".length) || "any");
        const auth = await buildAuthRedirect(url, env, hint);
        return new Response(null, {
          status: 302,
          headers: {
            Location: auth.location,
            "Set-Cookie": "oauth_state=" + auth.state + "; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/callback"
          }
        });
      }

      if (path === "/callback") {
        const clearStateCookie = "oauth_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/callback";
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code) return new Response("Missing code", {status: 400, headers: {"Set-Cookie": clearStateCookie}});
        if (!await isOAuthStateValid(request, state, env)) return new Response("Invalid OAuth state", {status: 400, headers: {"Set-Cookie": clearStateCookie}});

        const tokenRes = await fetch(TOKEN_EP, {
          method: "POST",
          headers: {"Content-Type": "application/x-www-form-urlencoded"},
          body: qs({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: url.origin + "/callback",
            grant_type: "authorization_code"
          })
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          return new Response("OAuth token exchange failed", {status: 400});
        }

        const profile = await gmailProfile(tokenData.access_token);
        const email = profile.emailAddress;
        const existing = await env.TOKENS.get(email, "json");
        const refreshToken = tokenData.refresh_token || (existing && existing.refresh_token);

        if (!refreshToken) {
          return new Response("Missing refresh token. Re-auth with consent.", {status: 400});
        }

        const persistResult = await persistOAuthSession(env, email, tokenData, refreshToken);
        if (persistResult.mode === "none") {
          return Response.json({
            error: "Cloudflare KV daily write limit reached. OAuth succeeded but token could not be saved. Configure GH backup or retry tomorrow."
          }, {status: 503});
        }
        if (persistResult.mode === "github") {
          return new Response(null, {
            status: 302,
            headers: {
              Location: "/?notice=oauth_saved_in_github_backup",
              "Set-Cookie": "oauth_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/callback"
            }
          });
        }

        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": "oauth_state=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/callback"
          }
        });
      }

      if (path === "/api/accounts" && request.method === "GET") {
        await track(env, "cf_requests", 1);
        const list = await env.TOKENS.list();
        const accounts = list.keys.map(function(k){ return k.name; }).filter(function(name){ return !isReservedKey(name); });
        if (githubBackupConfigured(env)) {
          const snapshot = await githubBackupRead(env);
          if (snapshot && snapshot.data && snapshot.data.sessions) {
            const ghAccounts = Object.keys(snapshot.data.sessions);
            for (let i = 0; i < ghAccounts.length; i++) {
              if (!accounts.includes(ghAccounts[i])) accounts.push(ghAccounts[i]);
            }
          }
        }
        return Response.json(accounts.sort());
      }

      if (path === "/api/remove" && request.method === "POST") {
        await track(env, "cf_requests", 1);
        let body;
        try {
          body = await request.json();
        } catch (_err) {
          return Response.json({error: "Invalid JSON body"}, {status: 400});
        }
        if (!body.email) return Response.json({error: "Missing email"}, {status: 400});

        // Update GitHub backup first so that if it fails KV is still intact
        // (account stays accessible via fallback rather than leaking through it).
        // If the snapshot is unreadable, abort entirely — proceeding would leave
        // the account in the GH fallback where getToken() can still serve it.
        if (githubBackupConfigured(env)) {
          const snapshot = await githubBackupRead(env);
          if (snapshot === null) {
            return Response.json({error: "Could not read GitHub backup snapshot; aborting deletion to prevent stale fallback access"}, {status: 502});
          }
          if (snapshot.data && snapshot.data.sessions && snapshot.data.sessions[body.email]) {
            delete snapshot.data.sessions[body.email];
            snapshot.data.updated_at = new Date().toISOString();
            await githubBackupWrite(env, snapshot.sha, snapshot.data, "backup(token-vault): remove " + body.email);
          }
        }
        await env.TOKENS.delete(body.email);
        return Response.json({status: "removed", email: body.email});
      }

      if (path === "/api/token" && request.method === "GET") {
        await track(env, "cf_requests", 1);
        const email = url.searchParams.get("email");
        if (!email) return Response.json({error: "?email= required"}, {status: 400});

        const token = await getToken(env, email);
        if (!token) {
          return Response.json({error: "No token for " + email + " — re-auth at /auth/" + encodeURIComponent(email)}, {status: 404});
        }
        return Response.json({email, access_token: token});
      }

      if (path === "/api/stats" && request.method === "GET") {
        if (!statsEnabled(env)) {
          let pending = 0;
          if (githubBackupConfigured(env)) {
            const snapshot = await githubBackupRead(env);
            pending = snapshot && snapshot.data && snapshot.data.pending_stats ? snapshot.data.pending_stats.length : 0;
          }
          return Response.json({
            today: {cf_requests: 0},
            month: {cf_requests: 0},
            total: {cf_requests: 0},
            mode: "disabled",
            pending_sync: pending
          });
        }
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const month = new Date().toISOString().slice(0, 7).replace(/-/g, "");
        const types = ["cf_requests"];
        const out = {today: {}, month: {}, total: {}};

        for (let i = 0; i < types.length; i++) {
          const t = types[i];
          out.today[t] = parseInt(await env.TOKENS.get("stats:" + today + ":" + t) || "0", 10);
          out.month[t] = parseInt(await env.TOKENS.get("stats:" + month + ":" + t) || "0", 10);
          out.total[t] = parseInt(await env.TOKENS.get("stats:total:" + t) || "0", 10);
        }

        return Response.json(out);
      }

      if (path === "/api/sync-fallback" && request.method === "POST") {
        if (!githubBackupConfigured(env)) {
          return Response.json({error: "GitHub backup is not configured"}, {status: 400});
        }
        const snapshot = await githubBackupRead(env);
        if (!snapshot) return Response.json({error: "Could not read backup file"}, {status: 502});
        const pending = snapshot.data.pending_stats || [];
        let synced = 0;

        // Each item is a single-key operation {key, amt} so a mid-item quota
        // error never leaves a partial write that would be double-applied.
        for (let i = 0; i < pending.length; i++) {
          const item = pending[i];
          try {
            const current = parseInt(await env.TOKENS.get(item.key) || "0", 10);
            await env.TOKENS.put(item.key, String(current + item.amt));
            synced++;
          } catch (err) {
            if (isKvLimitError(err)) break;
            throw err;
          }
        }

        snapshot.data.pending_stats = pending.slice(synced);
        snapshot.data.updated_at = new Date().toISOString();
        await githubBackupWrite(env, snapshot.sha, snapshot.data, "backup(token-vault): sync pending stats");
        return Response.json({status: "ok", synced, remaining: snapshot.data.pending_stats.length});
      }

      return new Response("Not found", {status: 404});
    } catch (err) {
      return Response.json({error: err.message}, {status: 500});
    }
  }
};
