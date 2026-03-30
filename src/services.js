const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_EP = "https://oauth2.googleapis.com/token";
const GMAIL_PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GH_API = "https://api.github.com";
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

function qs(o){
  return Object.keys(o).map(function(k){
    return encodeURIComponent(k) + "=" + encodeURIComponent(o[k]);
  }).join("&");
}

function isKvLimitError(err){
  const message = err && err.message ? String(err.message) : String(err);
  return message.includes("KV put() limit exceeded");
}

function statsEnabled(env){
  return String(env.ENABLE_KV_STATS || "").toLowerCase() === "true";
}

function isReservedKey(name){
  return name.indexOf("stats:") === 0 || name.indexOf("vault:") === 0;
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

function githubBackupConfigured(env){
  return !!(env.GH_BACKUP_TOKEN && env.GH_BACKUP_REPO && env.GH_BACKUP_PATH);
}

async function githubBackupRead(env){
  if (!githubBackupConfigured(env)) return null;
  const url = GH_API + "/repos/" + env.GH_BACKUP_REPO + "/contents/" + env.GH_BACKUP_PATH;
  const res = await fetch(url, {
    headers: {
      Authorization: "Bearer " + env.GH_BACKUP_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "gmail-token-vault-worker"
    }
  });

  if (res.status === 404) return {sha: null, data: {sessions: {}, pending_stats: []}};
  if (!res.ok) return null;

  const payload = await res.json();
  const raw = atob(payload.content.replace(/\n/g, ""));
  const parsed = JSON.parse(raw || "{}");
  return {
    sha: payload.sha,
    data: {
      sessions: parsed.sessions || {},
      pending_stats: parsed.pending_stats || [],
      updated_at: parsed.updated_at || null
    }
  };
}

async function githubBackupWrite(env, sha, data, message){
  const url = GH_API + "/repos/" + env.GH_BACKUP_REPO + "/contents/" + env.GH_BACKUP_PATH;
  const body = {
    message,
    content: btoa(JSON.stringify(data, null, 2)),
    branch: env.GH_BACKUP_BRANCH || "main"
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + env.GH_BACKUP_TOKEN,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "gmail-token-vault-worker"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error("GitHub backup write failed: " + text.slice(0, 400));
  }
}

async function backupSessionToGithub(env, email, session){
  if (!githubBackupConfigured(env)) return false;
  const snapshot = await githubBackupRead(env);
  if (!snapshot) return false;
  snapshot.data.sessions[email] = session;
  snapshot.data.updated_at = new Date().toISOString();
  await githubBackupWrite(env, snapshot.sha, snapshot.data, "backup(token-vault): store " + email);
  return true;
}

async function getToken(env, email){
  let session = await env.TOKENS.get(email, "json");
  if (!session && githubBackupConfigured(env)) {
    const snapshot = await githubBackupRead(env);
    session = snapshot && snapshot.data && snapshot.data.sessions ? snapshot.data.sessions[email] : null;
  }
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
  try {
    await env.TOKENS.put(email, JSON.stringify(session));
  } catch (err) {
    if (!isKvLimitError(err)) throw err;
    await backupSessionToGithub(env, email, session);
  }
  return session.access_token;
}

async function track(env, type, amt){
  if (!statsEnabled(env)) return;

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const month = new Date().toISOString().slice(0, 7).replace(/-/g, "");
  const dKey = "stats:" + day + ":" + type;
  const mKey = "stats:" + month + ":" + type;
  const tKey = "stats:total:" + type;

  const dv = parseInt(await env.TOKENS.get(dKey) || "0", 10);
  const mv = parseInt(await env.TOKENS.get(mKey) || "0", 10);
  const tv = parseInt(await env.TOKENS.get(tKey) || "0", 10);

  try {
    await env.TOKENS.put(dKey, String(dv + amt));
    await env.TOKENS.put(mKey, String(mv + amt));
    await env.TOKENS.put(tKey, String(tv + amt));
  } catch (err) {
    if (!isKvLimitError(err)) throw err;

    if (!githubBackupConfigured(env)) return;
    const snapshot = await githubBackupRead(env);
    if (!snapshot) return;

    snapshot.data.pending_stats.push({
      day,
      month,
      type,
      amt,
      ts: new Date().toISOString()
    });
    snapshot.data.updated_at = new Date().toISOString();
    await githubBackupWrite(env, snapshot.sha, snapshot.data, "backup(token-vault): queue stats delta");
  }
}

function buildAuthRedirect(url, env, hint){
  const nonce = crypto.randomUUID();
  const ts = Date.now();
  const state = btoa(JSON.stringify({nonce, ts}));
  const redirectUri = url.origin + "/callback";
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
  return {location, state};
}

function parseCookies(request){
  const raw = request.headers.get("Cookie") || "";
  const parts = raw.split(";");
  const out = {};
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].trim();
    if (!seg) continue;
    const idx = seg.indexOf("=");
    if (idx === -1) continue;
    const key = seg.slice(0, idx).trim();
    const val = seg.slice(idx + 1).trim();
    out[key] = val;
  }
  return out;
}

function isOAuthStateValid(request, stateFromQuery){
  if (!stateFromQuery) return false;
  const cookies = parseCookies(request);
  if (!cookies.oauth_state || cookies.oauth_state !== stateFromQuery) return false;
  try {
    const decoded = JSON.parse(atob(stateFromQuery));
    if (!decoded.ts || !decoded.nonce) return false;
    return Math.abs(Date.now() - decoded.ts) <= OAUTH_STATE_MAX_AGE_MS;
  } catch (_err) {
    return false;
  }
}

async function persistOAuthSession(env, email, tokenData, refreshToken){
  const session = {
    access_token: tokenData.access_token,
    refresh_token: refreshToken,
    expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000
  };

  try {
    await env.TOKENS.put(email, JSON.stringify(session));
    return {mode: "kv"};
  } catch (err) {
    if (!isKvLimitError(err)) throw err;

    const savedToGithub = await backupSessionToGithub(env, email, session);
    return savedToGithub ? {mode: "github"} : {mode: "none"};
  }
}

export {
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
};
