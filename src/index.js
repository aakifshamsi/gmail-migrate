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
        const auth = buildAuthRedirect(url, env, hint);
        return new Response(null, {
          status: 302,
          headers: {
            Location: auth.location,
            "Set-Cookie": "oauth_state=" + auth.state + "; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/callback"
          }
        });
      }

      if (path === "/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code) return new Response("Missing code", {status: 400});
        if (!isOAuthStateValid(request, state)) return new Response("Invalid OAuth state", {status: 400});

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

        await env.TOKENS.delete(body.email);
        if (githubBackupConfigured(env)) {
          const snapshot = await githubBackupRead(env);
          if (snapshot && snapshot.data && snapshot.data.sessions && snapshot.data.sessions[body.email]) {
            delete snapshot.data.sessions[body.email];
            snapshot.data.updated_at = new Date().toISOString();
            await githubBackupWrite(env, snapshot.sha, snapshot.data, "backup(token-vault): remove " + body.email);
          }
        }
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

        for (let i = 0; i < pending.length; i++) {
          const item = pending[i];
          const dKey = "stats:" + item.day + ":" + item.type;
          const mKey = "stats:" + item.month + ":" + item.type;
          const tKey = "stats:total:" + item.type;
          try {
            const dv = parseInt(await env.TOKENS.get(dKey) || "0", 10);
            const mv = parseInt(await env.TOKENS.get(mKey) || "0", 10);
            const tv = parseInt(await env.TOKENS.get(tKey) || "0", 10);
            await env.TOKENS.put(dKey, String(dv + item.amt));
            await env.TOKENS.put(mKey, String(mv + item.amt));
            await env.TOKENS.put(tKey, String(tv + item.amt));
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
