/**
 * Gmail Token Vault Worker
 * Thin Cloudflare Worker for OAuth token storage + vending.
 */

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Gmail Token Vault Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-950 text-slate-100">
  <div class="mx-auto max-w-5xl px-4 py-8">
    <header class="mb-6 flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl backdrop-blur">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-xs uppercase tracking-widest text-sky-400">Cloudflare Worker</p>
          <h1 class="mt-1 text-2xl font-bold">Gmail Token Vault Dashboard</h1>
          <p class="mt-2 text-sm text-slate-400">OAuth token authority for GitHub Actions migration engine.</p>
        </div>
        <span id="auth-badge" class="rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300">Not Authenticated</span>
      </div>
      <div class="grid gap-3 sm:grid-cols-3">
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs uppercase text-slate-400">Connected Accounts</p>
          <p id="metric-accounts" class="mt-1 text-2xl font-semibold">0</p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs uppercase text-slate-400">CF Requests Today</p>
          <p id="metric-requests" class="mt-1 text-2xl font-semibold">0</p>
        </div>
        <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <p class="text-xs uppercase text-slate-400">Token Endpoint</p>
          <p class="mt-1 truncate font-mono text-sm text-slate-300">GET /api/token?email=...</p>
        </div>
      </div>
    </header>

    <section id="auth-card" class="mb-6 rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <h2 class="text-lg font-semibold">Authenticate Dashboard</h2>
      <p class="mt-1 text-sm text-slate-400">Use your Worker API token to access protected endpoints.</p>
      <div class="mt-4 flex flex-col gap-3 sm:flex-row">
        <input id="auth-token" type="password" placeholder="Enter Worker API token"
          class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm outline-none ring-sky-500 focus:ring" />
        <button onclick="doAuth()" class="rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400">Login</button>
      </div>
      <div id="auth-msg" class="mt-3 text-sm"></div>
    </section>

    <section id="main" class="hidden space-y-6">
      <div class="grid gap-6 lg:grid-cols-2">
        <div class="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-lg font-semibold">Connected Accounts</h2>
            <button onclick="refreshDashboard()" class="rounded-lg border border-slate-700 px-3 py-1 text-xs hover:bg-slate-800">Refresh</button>
          </div>
          <div id="acct-list" class="space-y-2"></div>
          <a href="/auth/any" class="mt-4 inline-flex rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400">+ Add Google Account</a>
        </div>

        <div class="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h2 class="text-lg font-semibold">Quick Token Check</h2>
          <p class="mt-1 text-sm text-slate-400">Test token vending for a connected account.</p>
          <label class="mt-4 block text-xs uppercase text-slate-400">Email</label>
          <input id="token-email" type="email" placeholder="user@example.com"
            class="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm outline-none ring-sky-500 focus:ring" />
          <button onclick="probeToken()" class="mt-3 rounded-xl bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400">Request /api/token</button>
          <pre id="token-result" class="mt-3 hidden overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300"></pre>
        </div>
      </div>

      <div class="rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 class="text-lg font-semibold">API Usage Snapshot</h2>
        <p class="mt-1 text-sm text-slate-400">Read-only stats from KV.</p>
        <div id="stats-panel" class="mt-4 grid gap-3 sm:grid-cols-3"></div>
      </div>
    </section>
  </div>

  <script>
  var TK = localStorage.getItem('gmt') || '';

  function $(id){return document.getElementById(id)}
  function ah(){return TK ? {Authorization:'Bearer '+TK} : {}}
  function escapeHtml(str){return String(str).replace(/[&<>"]/g, function(m){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[m]})}

  function setAuthState(ok){
    $('auth-badge').textContent = ok ? 'Authenticated' : 'Not Authenticated';
    $('auth-badge').className = ok
      ? 'rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300'
      : 'rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300';
  }

  function notify(msg, type){
    var c = type === 'err' ? 'text-rose-300' : 'text-emerald-300';
    $('auth-msg').className = 'mt-3 text-sm ' + c;
    $('auth-msg').textContent = msg;
  }

  function doAuth(){
    TK = $('auth-token').value.trim();
    if(!TK){ notify('Token is required.', 'err'); return; }
    localStorage.setItem('gmt', TK);
    checkAuth();
  }

  function loadAccounts(accts){
    $('metric-accounts').textContent = String(accts.length || 0);
    var box = $('acct-list');
    if(!accts.length){
      box.innerHTML = '<p class="rounded-lg border border-dashed border-slate-700 p-4 text-sm text-slate-400">No connected accounts yet.</p>';
      return;
    }

    box.innerHTML = accts.map(function(email){
      return '<div class="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950 px-4 py-3">'+
        '<span class="truncate text-sm">'+escapeHtml(email)+'</span>'+
        '<button class="rounded-lg border border-rose-500/30 px-3 py-1 text-xs text-rose-300 hover:bg-rose-500/10" onclick="rmAcct('+JSON.stringify(email)+')">Remove</button>'+
      '</div>';
    }).join('');
  }

  function loadStats(stats){
    $('metric-requests').textContent = String((stats.today && stats.today.cf_requests) || 0);
    var total = (stats.total && stats.total.cf_requests) || 0;
    var month = (stats.month && stats.month.cf_requests) || 0;
    $('stats-panel').innerHTML = [
      {k:'Today',v:(stats.today && stats.today.cf_requests) || 0},
      {k:'This Month',v:month},
      {k:'All Time',v:total}
    ].map(function(item){
      return '<div class="rounded-xl border border-slate-800 bg-slate-950 p-4">'+
        '<p class="text-xs uppercase text-slate-400">'+item.k+'</p>'+
        '<p class="mt-1 text-xl font-semibold">'+item.v+'</p>'+
      '</div>';
    }).join('');
  }

  function checkAuth(){
    fetch('/api/accounts', {headers: ah()}).then(function(r){
      if(r.status === 401){ throw new Error('Unauthorized'); }
      return r.json();
    }).then(function(accts){
      $('auth-card').classList.add('hidden');
      $('main').classList.remove('hidden');
      setAuthState(true);
      loadAccounts(accts);
      notify('Authenticated successfully.', 'ok');
      refreshStats();
    }).catch(function(){
      $('main').classList.add('hidden');
      $('auth-card').classList.remove('hidden');
      setAuthState(false);
      if(TK) notify('Token invalid or expired.', 'err');
    });
  }

  function refreshStats(){
    fetch('/api/stats', {headers: ah()}).then(function(r){
      if(!r.ok) throw new Error('Stats unavailable');
      return r.json();
    }).then(loadStats).catch(function(){
      $('stats-panel').innerHTML = '<p class="text-sm text-slate-400">Stats unavailable right now.</p>';
    });
  }

  function refreshDashboard(){
    checkAuth();
  }

  function rmAcct(email){
    if(!confirm('Remove '+email+' from token vault?')) return;
    fetch('/api/remove', {
      method:'POST',
      headers:Object.assign({'Content-Type':'application/json'}, ah()),
      body:JSON.stringify({email:email})
    }).then(function(r){return r.json()})
      .then(function(d){if(d.error)throw new Error(d.error); refreshDashboard();})
      .catch(function(e){alert('Failed: '+e.message)});
  }

  function probeToken(){
    var email = $('token-email').value.trim();
    if(!email){ alert('Enter an email first.'); return; }
    fetch('/api/token?email='+encodeURIComponent(email), {headers: ah()})
      .then(function(r){return r.json().then(function(data){return {ok:r.ok,data:data}})})
      .then(function(res){
        var out = $('token-result');
        out.classList.remove('hidden');
        if(res.ok && res.data.access_token){
          out.textContent = JSON.stringify({email:res.data.email, access_token:'[redacted:'+String(res.data.access_token).length+' chars]'}, null, 2);
        }else{
          out.textContent = JSON.stringify(res.data, null, 2);
        }
      })
      .catch(function(e){
        var out = $('token-result');
        out.classList.remove('hidden');
        out.textContent = e.message;
      });
  }

  if(TK){ checkAuth(); } else { setAuthState(false); }
  </script>
</body>
</html>`;

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_EP = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";

function qs(o){
  return Object.keys(o).map(function(k){
    return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]);
  }).join("&");
}

function isReservedKey(name){
  return name.indexOf("stats:")===0 || name.indexOf("vault:")===0;
}

function isAuthorized(request, env, url, vaultToken){
  const authH = request.headers.get("Authorization") || "";
  const bearer = authH.startsWith("Bearer ") ? authH.slice(7) : "";
  const queryToken = url.searchParams.get("token") || "";
  const cfAccessJwt = request.headers.get("CF-Access-Jwt-Assertion");
  const supplied = bearer || queryToken;

  if (cfAccessJwt) return true;
  if (!supplied) return false;

  return (vaultToken && supplied === vaultToken) || (env.AUTH_TOKEN && supplied === env.AUTH_TOKEN);
}

async function gmailProfile(accessToken){
  const res = await fetch(GMAIL_PROFILE, {headers: {Authorization: "Bearer " + accessToken}});
  const text = await res.text();
  if (!res.ok) throw new Error("Profile fetch failed: " + text.slice(0, 300));
  return JSON.parse(text);
}

async function getToken(env, email){
  const session = await env.TOKENS.get(email, "json");
  if (!session) return null;

  if (session.expires_at && session.expires_at > Date.now() + 60000 && session.access_token) {
    return session.access_token;
  }

  const res = await fetch(TOKEN_EP, {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: qs({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: session.refresh_token,
      grant_type: "refresh_token"
    })
  });

  const data = await res.json();
  if (!data.access_token) return null;

  session.access_token = data.access_token;
  session.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
  await env.TOKENS.put(email, JSON.stringify(session));
  return session.access_token;
}

async function track(env, type, amt){
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const month = new Date().toISOString().slice(0, 7).replace(/-/g, "");
  const dKey = "stats:" + day + ":" + type;
  const mKey = "stats:" + month + ":" + type;
  const tKey = "stats:total:" + type;

  const dv = parseInt(await env.TOKENS.get(dKey) || "0", 10);
  const mv = parseInt(await env.TOKENS.get(mKey) || "0", 10);
  const tv = parseInt(await env.TOKENS.get(tKey) || "0", 10);

  await env.TOKENS.put(dKey, String(dv + amt));
  await env.TOKENS.put(mKey, String(mv + amt));
  await env.TOKENS.put(tKey, String(tv + amt));
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

      if (path === "/") return new Response(HTML, {headers: {"Content-Type": "text/html; charset=utf-8"}});

      if (path.startsWith("/auth/")) {
        const hint = decodeURIComponent(path.slice("/auth/".length) || "any");
        const redirectUri = url.origin + "/callback";
        const state = crypto.randomUUID();
        const location = AUTH + "?" + qs({
          client_id: env.GOOGLE_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPE + " email",
          access_type: "offline",
          prompt: "consent",
          login_hint: hint === "any" ? "" : hint,
          state
        });
        return new Response(null, {status: 302, headers: {Location: location}});
      }

      if (path === "/callback") {
        const code = url.searchParams.get("code");
        if (!code) return new Response("Missing code", {status: 400});

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

        await env.TOKENS.put(email, JSON.stringify({
          access_token: tokenData.access_token,
          refresh_token: refreshToken,
          expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000
        }));

        return new Response(null, {status: 302, headers: {Location: "/"}});
      }

      if (path === "/api/accounts" && request.method === "GET") {
        await track(env, "cf_requests", 1);
        const list = await env.TOKENS.list();
        const accounts = list.keys.map(function(k){ return k.name; }).filter(function(name){ return !isReservedKey(name); });
        return Response.json(accounts.sort());
      }

      if (path === "/api/remove" && request.method === "POST") {
        await track(env, "cf_requests", 1);
        const body = await request.json();
        if (!body.email) return Response.json({error: "Missing email"}, {status: 400});
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

      return new Response("Not found", {status: 404});
    } catch (err) {
      return Response.json({error: err.message}, {status: 500});
    }
  }
};
