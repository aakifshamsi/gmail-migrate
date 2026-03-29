# Gmail Migrator — Architect Review Brief

**For:** Codex / Claude Code / Any AI Agent
**Date:** 2026-03-29
**Task:** Review codebase, propose & implement refactoring

## Problem Statement

The CF Worker runs ALL migration work (Gmail API calls, label creation, message import) in its request handler. CF Workers have strict limits:
- 1,000 subrequests per invocation
- 10s CPU time (free) / 30s (paid)
- 1 KV write/second

We're burning through CF quota doing heavy lifting that should be on GH Actions. Already breached 90% quota.

## What Needs to Change

**CF Worker → Thin Layer Only:**
- `/api/token?email=xxx` — Return fresh OAuth token (KEEP)
- `/auth/:email`, `/callback` — Google OAuth flow (KEEP)
- `GET /api/stats`, `GET /api/jobs` — Read-only dashboards (KEEP)
- `POST /api/migrate`, `POST /api/delete-source`, cancel/reset — REMOVE (move to GH Actions)
- `*/5 cron` — REMOVE (GH Actions handles scheduling)

**GH Actions → Migration Engine:**
- Workflow calls `/api/token` for fresh OAuth tokens
- Runs migrate.py which uses Gmail API directly
- Triggered by workflow_dispatch or schedule

## Known Bugs

1. **UI crash on progress updates** — `o += ...` coerces DOM element to string, then `o.appendChild()` fails. Fixed in current deploy but worth noting.

2. **Cancel button HTML injection** — `JSON.stringify(email)` inside onclick attribute produces broken HTML when emails contain special chars.

3. **No dedup on re-run** — `:migrated` key stores IDs but migrate endpoint doesn't check it. Re-runs re-copy same messages.

4. **Jobs endpoint shows stale data** — `:migrated` key persists forever, shows as "done" even after reset.

## KV Namespace
- ID: `8499bbd2bcf0437aba2e0cd579ba41a3`
- Binding: `TOKENS`
- Keys: `aakifshamsi@gmail.com`, `aakif17@gmail.com`, `aakif007@gmail.com` (OAuth), `vault:api_token`, `migration:*`, `stats:*`

## Secrets

> Security note: credentials below are intentionally redacted in-repo. Configure real values in your local shell / CI secrets manager.

```
CLOUDFLARE_API_TOKEN=<REDACTED>
WORKER_URL=<REDACTED>
WORKER_AUTH_TOKEN=<REDACTED>
CF_ACCESS_CLIENT_ID=<REDACTED>
CF_ACCESS_CLIENT_SECRET=<REDACTED>
```

## Deploy

```bash
cd gmail-migrator-cf
CLOUDFLARE_API_TOKEN=<REDACTED> npx wrangler deploy --name gmail-migrator
```

## Source Code

### `src/index.js` (CF Worker — main file to refactor)

```javascript
/**
 * Gmail Migrator — Cloudflare Worker v3
 * Optimized: format=full (2 calls/msg), dest-set dedup, ntfy alerts, job management.
 */

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gmail Migrator</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#f8f9fa;color:#1a1a1a;padding:1rem;max-width:520px;margin:0 auto}
h1{font-size:1.3rem;margin-bottom:.75rem}
.card{background:#fff;border-radius:12px;padding:1.2rem;margin-bottom:.75rem;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h2{font-size:.9rem;margin-bottom:.6rem;color:#444}
.tabs{display:flex;gap:0;margin-bottom:1rem;border-radius:10px;overflow:hidden;border:1px solid #dadce0}
.tab{flex:1;padding:.55rem;text-align:center;cursor:pointer;font-size:.82rem;font-weight:500;background:#fff;border:none;color:#5f6368}
.tab.on{background:#1a73e8;color:#fff}
.btn{display:inline-block;padding:.45rem .9rem;border-radius:8px;border:1px solid #dadce0;background:#fff;cursor:pointer;font-size:.82rem;text-decoration:none;color:#1a1a1a}
.btn:hover{background:#f1f3f4}.btn-p{background:#1a73e8;color:#fff;border-color:#1a73e8}
.btn-p:hover{background:#1557b0}.btn-d{color:#d93025}.btn-d:hover{background:#fce8e6}
.btn-s{background:#34a853;color:#fff;border-color:#34a853}
.acct{display:flex;justify-content:space-between;align-items:center;padding:.35rem 0;border-bottom:1px solid #f1f3f4}
.acct:last-child{border:0}.email{font-weight:500;font-size:.82rem}
select,input{width:100%;padding:.45rem;border:1px solid #dadce0;border-radius:8px;font-size:.82rem;margin-top:.2rem}
label{font-size:.78rem;font-weight:500;display:block;margin-bottom:.2rem}
.row{display:flex;gap:.5rem;margin-top:.4rem;flex-wrap:wrap}
.result{margin-top:.6rem;padding:.6rem;border-radius:8px;font-size:.78rem}
.ok{background:#e6f4ea;color:#137333}.err{background:#fce8e6;color:#c5221f}.info{background:#e8f0fe;color:#1a73e8}
pre{background:#f1f3f4;padding:.4rem;border-radius:6px;font-size:.72rem;overflow-x:auto;margin-top:.4rem;white-space:pre-wrap;word-break:break-all}
.chk{display:flex;align-items:center;gap:.35rem;font-size:.82rem;margin-top:.3rem}
.chk input{width:auto;margin:0}
table{width:100%;border-collapse:collapse;font-size:.78rem}th{text-align:left;padding:.3rem .2rem;border-bottom:2px solid #dadce0;color:#5f6368;font-weight:600}
td{padding:.3rem .2rem;border-bottom:1px solid #f1f3f4}.warn{color:#ea8600;font-weight:600}.danger{color:#d93025;font-weight:600}
.badge{display:inline-block;padding:.15rem .4rem;border-radius:4px;font-size:.7rem;font-weight:600}
.badge-run{background:#e8f0fe;color:#1a73e8}.badge-done{background:#e6f4ea;color:#137333}.badge-err{background:#fce8e6;color:#c5221f}
</style>
</head>
<body>
<h1>&#9993;&#65039; Gmail Migrator</h1>
<div class="tabs">
  <button class="tab on" onclick="showTab('home')">&#127968; Home</button>
  <button class="tab" onclick="showTab('stats')">&#128202; Stats</button>
  <button class="tab" onclick="showTab('jobs')">&#9881; Jobs</button>
</div>
<div id="auth-card" class="card">
  <h2>&#128274; Login</h2>
  <input id="auth-token" type="password" placeholder="Enter auth token">
  <div class="row"><button class="btn btn-p" onclick="doAuth()">Login</button></div>
  <div id="auth-msg"></div>
</div>
<div id="main" style="display:none">
<!-- HOME -->
<div id="tab-home">
<div class="card"><h2>Accounts</h2><div id="acct-list"></div>
<div class="row"><a href="/auth/any" class="btn">+ Add Account</a></div></div>
<div class="card" id="mig" style="display:none"><h2>Migrate</h2>
<label>From</label><select id="src"></select>
<label>To (destinations)</label><div id="dests"></div>
<label style="margin-top:.4rem">Max emails</label><input id="max" type="number" value="50" min="1" max="2000">
<div class="chk"><input type="checkbox" id="delsrc"><label for="delsrc" style="margin:0;display:inline">Delete from source after</label></div>
<div class="row"><button class="btn" onclick="go(true)">Dry Run</button><button class="btn btn-p" onclick="go(false)">Migrate</button></div>
<div id="out"></div></div>
</div>
<!-- STATS -->
<div id="tab-stats" style="display:none">
<div class="card"><h2>Usage</h2><div id="stats-body">Loading...</div></div>
<div class="card"><h2>Limits</h2><div id="limits-body"></div></div>
</div>
<!-- JOBS -->
<div id="tab-jobs" style="display:none">
<div class="card"><h2>Active Migrations</h2><div id="jobs-body">Loading...</div>
<div class="row"><button class="btn" onclick="loadJobs()">&#128260; Refresh</button></div></div>
</div>
</div>
<script>
var TK=localStorage.getItem('gmt')||'',PH={};
function ah(){return TK?{Authorization:'Bearer '+TK}:{}}
function doAuth(){TK=document.getElementById('auth-token').value.trim();
if(!TK){$('auth-msg').innerHTML='<p class="result err">Required</p>';return}
localStorage.setItem('gmt',TK);checkAuth()}
function $(id){return document.getElementById(id)}
function checkAuth(){fetch('/api/accounts',{headers:ah()}).then(function(r){
if(r.status===401){$('auth-card').style.display='block';$('main').style.display='none';return null}
$('auth-card').style.display='none';$('main').style.display='block';return r.json()}).then(function(d){if(d)loadAccts(d)})}
function loadAccts(d){var el=$('acct-list');
if(!d.length){el.innerHTML='<p style="color:#5f6368;font-size:.8rem">No accounts.</p>';return}
el.innerHTML=d.map(function(e){var ej=JSON.stringify(e);return'<div class="acct"><span class="email">'+e+'</span><button class="btn btn-d" onclick="rmAcct('+ej+')">&#10005;</button></div>'}).join('');
if(d.length>=2){$('mig').style.display='block';$('src').innerHTML=d.map(function(e){return'<option value="'+e+'">'+e+'</option>'}).join('');
$('dests').innerHTML=d.map(function(e){return'<div class="chk"><input type="checkbox" class="dst-cb" value="'+e+'" id="d-'+e+'"><label for="d-'+e+'" style="margin:0;display:inline">'+e+'</label></div>'}).join('')}}
function rmAcct(e){if(!confirm('Remove '+decodeURIComponent(e)+'?'))return;
fetch('/api/remove',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},ah()),body:JSON.stringify({email:decodeURIComponent(e)})}).then(function(){location.reload()})}
if(TK)checkAuth();else {
// Check if authenticated via CF Access (SSO) — try API without token
fetch('/api/accounts').then(function(r){return r.ok?r.json():null}).then(function(d){
if(d){$('auth-card').style.display='none';$('main').style.display='block';loadAccts(d)}
else{$('auth-card').style.display='block'}}).catch(function(){$('auth-card').style.display='block'})}
function showTab(n){['home','stats','jobs'].forEach(function(t){$('tab-'+t).style.display=t===n?'block':'none';
document.querySelectorAll('.tab').forEach(function(b){b.classList.toggle('on',b.textContent.toLowerCase().indexOf(n)>=0)})});
if(n==='stats')loadStats();if(n==='jobs')loadJobs()}
function fmtB(b){if(!b)return'0 B';var u=['B','KB','MB','GB'];var i=Math.floor(Math.log(b)/Math.log(1024));return(b/Math.pow(1024,i)).toFixed(1)+' '+u[i]}
function go(dry){var o=$('out');o.className='result info';o.innerHTML='Working...';
var dsts=[];document.querySelectorAll('.dst-cb:checked').forEach(function(c){dsts.push(c.value)});
if(!dsts.length){o.className='result err';o.innerHTML='Select destination';return}
var src=$('src').value;if(dsts.indexOf(src)!==-1){o.className='result err';o.innerHTML='Source = dest';return}
o.innerHTML='Starting...<br>';runN(src,dsts,0,dry,o,+$('max').value,$('delsrc').checked)}
function runN(s,d,i,dy,o,m,del,ids){if(i>=d.length){if(!dy&&del&&ids&&ids.length){
o.innerHTML+='<br><b>Deleting '+ids.length+' from source...</b> ';
fetch('/api/delete-source',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},ah()),body:JSON.stringify({source:s,ids:ids})})
.then(function(r){return r.text()}).then(function(t){o.innerHTML+='<pre>'+t+'</pre>'})}return}
o.innerHTML+='<b>'+(i+1)+'/'+d.length+': '+s+' &#8594; '+d[i]+'</b> ';if(!ids)ids=[];
mb(s,d[i],m,dy,o,function(r){if(r&&r.copied_ids)ids=ids.concat(r.copied_ids);runN(s,d,i+1,dy,o,m,del,ids)})}
function mb(s,d,m,dy,o,cb){fetch('/api/migrate',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},ah()),
body:JSON.stringify({source:s,destination:d,max:m,dry:dy})})
.then(function(r){return r.text().then(function(t){try{return{ok:r.ok,data:JSON.parse(t)}}catch(e){return{ok:false,err:t.slice(0,300)}}})})
.then(function(r){var x=r.data||{error:r.err};
if(r.ok&&x.total_bytes!==undefined)x.size=fmtB(x.total_bytes);
if(r.ok&&x.progress&&x.progress.total_bytes!==undefined)x.progress.size=fmtB(x.progress.total_bytes);
o.innerHTML+='<pre class="'+(r.ok?'ok':'err')+'">'+JSON.stringify(x,null,2)+'</pre>';
if(r.ok&&x.status==='in_progress'){var b=document.createElement('button');b.className='btn btn-p';
b.textContent='Continue ('+x.progress.copied+'/'+x.progress.total+(x.progress.size?', '+x.progress.size:'')+')';
b.onclick=function(){b.disabled=true;b.textContent='Continuing...';mb(s,d,m,dy,o,cb)};o.appendChild(b);return}
cb(r.ok?x:null)})}
function loadStats(){fetch('/api/stats',{headers:ah()}).then(function(r){return r.json()}).then(function(d){
var h='<table><tr><th>Metric</th><th>Today</th><th>Month</th><th>Total</th></tr>';
['cf_requests','gmail_api_calls','gmail_quota_units','messages_copied','messages_skipped','bytes_transferred'].forEach(function(k){
var label=k.replace(/_/g,' ');var tv=d.today[k]||0;var mv=d.month[k]||0;var xv=d.total[k]||0;
if(k==='bytes_transferred'){tv=fmtB(tv);mv=fmtB(mv);xv=fmtB(xv)}
h+='<tr><td>'+label+'</td><td>'+tv+'</td><td>'+mv+'</td><td>'+xv+'</td></tr>'});
h+='</table>';
if(d.warnings&&d.warnings.length)h+='<div class="result err" style="margin-top:.5rem">'+d.warnings.join('<br>')+'</div>';
$('stats-body').innerHTML=h;
var l=d.limits||{};var rm=d.remaining||{};
$('limits-body').innerHTML='<table><tr><th>Resource</th><th>Limit</th><th>Used</th><th>Remaining</th></tr>'+
'<tr><td>CF requests/day</td><td>100K</td><td>'+(d.today.cf_requests||0)+'</td><td class="'+(rm.cf_requests_today<10000?'danger':'')+'">'+(rm.cf_requests_today||'—')+'</td></tr>'+
'<tr><td>Gmail imports/day</td><td>~25K</td><td>'+(d.today.messages_copied||0)+'</td><td>'+(rm.gmail_imports_today_estimate||'—')+'</td></tr>'+
'<tr><td>Cron triggers</td><td>3</td><td>1</td><td>2</td></tr>'+
'</table>'})}
function loadJobs(){fetch('/api/jobs',{headers:ah()}).then(function(r){return r.json()}).then(function(d){
if(!d.jobs||!d.jobs.length){$('jobs-body').innerHTML='<p style="color:#5f6368;font-size:.8rem">No migrations.</p>';return}
var h='';d.jobs.forEach(function(j){var pct=j.total?Math.round(j.copied/j.total*100):0;
var badge=j.status==='done'?'<span class="badge badge-done">DONE ('+j.copied+')</span>':'<span class="badge badge-run">'+pct+'% ('+j.copied+'/'+j.total+')</span>';
h+='<div class="card" style="margin-bottom:.5rem"><b>'+j.source+' &#8594; '+j.destination+'</b><br>'+badge;
if(j.total_bytes)h+=' <span style="color:#5f6368;font-size:.75rem">'+fmtB(j.total_bytes)+'</span>';
if(j.status==='active')h+='<br><button class="btn btn-d" style="margin-top:.3rem;font-size:.75rem" onclick="cancelJob('+JSON.stringify(j.source)+','+JSON.stringify(j.destination)+')">Cancel</button>';
if(j.status==='done')h+='<br><button class="btn" style="margin-top:.3rem;font-size:.75rem" onclick="resetJob('+JSON.stringify(j.source)+','+JSON.stringify(j.destination)+')">Reset &amp; Re-migrate</button>';
h+='</div>'});$('jobs-body').innerHTML=h})}
function cancelJob(s,d){if(!confirm('Cancel '+s+' to '+d+'?'))return;
fetch('/api/jobs/cancel',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},ah()),
body:JSON.stringify({source:s,destination:d})}).then(function(){loadJobs()})}
function resetJob(s,d){if(!confirm('Reset migration record for '+s+' to '+d+'? This allows re-migrating.'))return;
fetch('/api/jobs/reset',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},ah()),
body:JSON.stringify({source:s,destination:d})}).then(function(){loadJobs()})}
</script>
</body>
</html>`;

const GMAIL = "https://gmail.googleapis.com/gmail/v1";
const GUPLOAD = "https://www.googleapis.com/upload/gmail/v1";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_EP = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/gmail.modify";

function qs(o){return Object.keys(o).map(function(k){return encodeURIComponent(k)+"="+encodeURIComponent(o[k])}).join("&")}

async function gmailApi(token,path,method,body){
  var opts={method:method||"GET",headers:{Authorization:"Bearer "+token}};
  if(body){opts.body=typeof body==="string"?body:JSON.stringify(body);
    if(method&&method!=="GET"&&method!=="DELETE")opts.headers["Content-Type"]="application/json"}
  var res=await fetch(GMAIL+path,opts);var text=await res.text();
  if(!res.ok)throw new Error(res.status+": "+text.slice(0,300));
  try{return JSON.parse(text)}catch(e){return text}}

async function getToken(env,email){
  var s=await env.TOKENS.get(email,"json");if(!s)return null;
  if(s.expires_at&&s.expires_at>Date.now()+60000)return s.access_token;
  var res=await fetch(TOKEN_EP,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:qs({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:s.refresh_token,grant_type:"refresh_token"})});
  var d=await res.json();if(!d.access_token)return null;
  s.access_token=d.access_token;s.expires_at=Date.now()+(d.expires_in||3600)*1000;
  try{await env.TOKENS.put(email,JSON.stringify(s))}catch(e){/* KV write limit — token still valid */}return s.access_token}

function hdr(headers,name){if(!headers)return null;for(var i=0;i<headers.length;i++)
  if(headers[i].name.toLowerCase()===name.toLowerCase())return headers[i].value;return null}

function fmtDate(ts){var d=new Date(parseInt(ts));return{y:d.getUTCFullYear(),m:("0"+(d.getUTCMonth()+1)).slice(-2),d:("0"+d.getUTCDate()).slice(-2)}}

async function mkLabel(env,token,email,name,cache){
  if(cache[name])return cache[name];
  try{var r=await gmailApi(token,"/users/me/labels","POST",{name:name,labelListVisibility:"labelShow",messageListVisibility:"show"});
    cache[name]=r.id;return r.id}catch(e){
    if(e.message.indexOf("409")!==-1||e.message.indexOf("ALREADY_EXISTS")!==-1){
      var ls=await gmailApi(token,"/users/me/labels");
      if(ls&&ls.labels)for(var i=0;i<ls.labels.length;i++)
        if(ls.labels[i].name===name){cache[name]=ls.labels[i].id;return ls.labels[i].id}}return null}}

async function ntfy(url,msg){
  try{await fetch(url,{method:"POST",body:msg,title:"Gmail Migrator",priority:"default",tags:"email"})}catch(e){}}

// Batched stats — accumulate in memory, flush once per invocation
var _statsBatch = {};
function track(type,amt){_statsBatch[type]=(_statsBatch[type]||0)+amt}
async function flushStats(env){
  var t=new Date().toISOString().slice(0,10).replace(/-/g,"");
  var m=new Date().toISOString().slice(0,7).replace(/-/g,"");
  var keys=Object.keys(_statsBatch);if(!keys.length)return;
  try{
  for(var i=0;i<keys.length;i++){
    var type=keys[i];var amt=_statsBatch[type];
    var dk="stats:"+t+":"+type;var mk="stats:"+m+":"+type;var tk="stats:total:"+type;
    var dv=parseInt(await env.TOKENS.get(dk)||"0");await env.TOKENS.put(dk,String(dv+amt));
    var mv=parseInt(await env.TOKENS.get(mk)||"0");await env.TOKENS.put(mk,String(mv+amt));
    var tv=parseInt(await env.TOKENS.get(tk)||"0");await env.TOKENS.put(tk,String(tv+amt))}
  }catch(e){/* KV limit hit — skip stats */}
  _statsBatch={}}

async function checkLimits(env){
  var t=new Date().toISOString().slice(0,10).replace(/-/g,"");
  var cf=parseInt(await env.TOKENS.get("stats:"+t+":cf_requests")||"0");
  var gu=parseInt(await env.TOKENS.get("stats:"+t+":gmail_quota_units")||"0");
  var w=[];if(cf>90000)w.push("CF requests near limit: "+cf);if(gu>200000)w.push("Gmail quota high: "+gu);
  return{cf:cf,gu:gu,warnings:w}}

async function getDestMsgSet(dstToken){
  var set={};var pt=null;
  while(true){var d=await gmailApi(dstToken,"/users/me/messages?maxResults=500"+(pt?"&pageToken="+pt:""));
    if(d.messages)for(var i=0;i<d.messages.length;i++)set[d.messages[i].id]=true;
    pt=d.nextPageToken;if(!pt)break}return set}

var LABEL_MAP={"INBOX":"INBOX","SENT":"SENT","DRAFT":"DRAFT","SPAM":"SPAM","TRASH":"TRASH","STARRED":"STARRED",
  "IMPORTANT":"IMPORTANT","CATEGORY_PERSONAL":"Personal","CATEGORY_SOCIAL":"Social",
  "CATEGORY_PROMOTIONS":"Promotions","CATEGORY_UPDATES":"Updates","CATEGORY_FORUMS":"Forums"};

function fmtBytes(b){if(!b)return'0 B';var u=['B','KB','MB','GB'];var i=Math.floor(Math.log(b)/Math.log(1024));return(b/Math.pow(1024,i)).toFixed(1)+' '+u[i]};

export default{
  async fetch(request,env){
    try{var url=new URL(request.url);var path=url.pathname;
      track("cf_requests",1);

      // Auth gate — check CF Access JWT (SSO) first, then KV-stored token, then AUTH_TOKEN
      if(path.startsWith("/api/")){
        var authH=request.headers.get("Authorization")||"";
        var tk=authH.startsWith("Bearer ")?authH.slice(7):url.searchParams.get("token")||"";
        var cfAccessJwt=request.headers.get("CF-Access-Jwt-Assertion");
        // Allow if authenticated via CF Access SSO
        if(!tk&&!cfAccessJwt)return Response.json({error:"Unauthorized"},{status:401});
        if(tk){
          var vaultTk=await env.TOKENS.get("vault:api_token");
          var valid=(vaultTk&&tk===vaultTk)||(env.AUTH_TOKEN&&tk===env.AUTH_TOKEN);
          if(!valid&&!cfAccessJwt)return Response.json({error:"Unauthorized"},{status:401})}}

      if(path==="/")return new Response(HTML,{headers:{"Content-Type":"text/html"}});

      // Accounts
      if(path==="/api/accounts"){var list=await env.TOKENS.list();
        return Response.json(list.keys.map(function(k){return k.name}).filter(function(n){return n.indexOf("migration:")!==0&&n.indexOf("stats:")!==0&&n.indexOf("vault:")!==0}))}

      // Token endpoint — returns fresh access token for Gmail API usage (e.g., from GitHub Actions)
      if(path==="/api/token"&&request.method==="GET"){
        var email=url.searchParams.get("email");
        if(!email)return Response.json({error:"?email= required"},{status:400});
        var token=await getToken(env,email);
        if(!token)return Response.json({error:"No token for "+email+" — re-auth at /auth/"+encodeURIComponent(email)},{status:404});
        return Response.json({email:email,access_token:token})}

      // Stats
      if(path==="/api/stats"){var today=new Date().toISOString().slice(0,10).replace(/-/g,"");
        var month=new Date().toISOString().slice(0,7).replace(/-/g,"");
        var types=["cf_requests","gmail_api_calls","gmail_quota_units","messages_copied","messages_skipped","bytes_transferred"];
        var res={today:{},month:{},total:{}};
        for(var i=0;i<types.length;i++){res.today[types[i]]=parseInt(await env.TOKENS.get("stats:"+today+":"+types[i])||"0");
          res.month[types[i]]=parseInt(await env.TOKENS.get("stats:"+month+":"+types[i])||"0");
          res.total[types[i]]=parseInt(await env.TOKENS.get("stats:total:"+types[i])||"0")}
        var cl=await checkLimits(env);res.warnings=cl.warnings;
        res.limits={cf_daily:100000,gmail_daily:25000,cron:3};
        res.remaining={cf_requests_today:Math.max(0,100000-res.today.cf_requests),
          gmail_imports_today_estimate:Math.max(0,25000-res.today.messages_copied)};
        return Response.json(res)}

      // Jobs list — active + completed
      if(path==="/api/jobs"&&request.method==="GET"){
        var jobs=[];var seen={};
        // Active migrations (have progress key)
        var all=await env.TOKENS.list({prefix:"migration:"});
        for(var i=0;i<all.keys.length;i++){var k=all.keys[i].name;
          if(k.indexOf(":migrated")!==-1||k.indexOf(":cancelled")!==-1)continue;
          var prog=await env.TOKENS.get(k,"json");
          var pair=k.replace("migration:","");
          seen[pair]=true;
          if(prog){jobs.push({source:prog.source,destination:prog.destination,total:prog.total_messages||0,
            copied:prog.copied||0,total_bytes:prog.total_bytes||0,last_index:prog.last_index||0,status:"active"})}
        }
        // Completed migrations (have migrated record but no active progress)
        for(var i=0;i<all.keys.length;i++){var mk=all.keys[i].name;
          if(mk.indexOf(":migrated")===-1)continue;
          var mprog=await env.TOKENS.get(mk,"json");if(!mprog)continue;
          var mpair=mk.replace("migration:","").replace(":migrated","");
          if(seen[mpair])continue;
          var parts=mpair.split(":");
          jobs.push({source:parts[0],destination:parts[1],total:mprog.count||0,copied:mprog.count||0,
            total_bytes:0,last_index:0,status:"done",ids_count:mprog.ids?mprog.ids.length:0})}
        return Response.json({jobs:jobs})}

      // SSE progress stream for a specific job
      if(path.match(/^\/api\/jobs\/.+\/progress$/)&&request.method==="GET"){
        var parts=path.replace("/api/jobs/","").replace("/progress","").split("/");
        if(parts.length<2)return Response.json({error:"Format: /api/jobs/{source}/{dest}/progress"},{status:400});
        var psrc=decodeURIComponent(parts[0]);var pdst=decodeURIComponent(parts.slice(1).join("/"));
        var ppkey="migration:"+psrc+":"+pdst;
        var stream=new ReadableStream({start(controller){
          var enc=new TextEncoder();var iv=setInterval(async()=>{
            try{
              var pg=await env.TOKENS.get(ppkey,"json");
              if(!pg){controller.enqueue(enc.encode("data: "+JSON.stringify({status:"done"})+"\n\n"));clearInterval(iv);controller.close();return}
              var data=JSON.stringify({status:"active",source:pg.source,destination:pg.destination,
                total:pg.total_messages||0,copied:pg.copied||0,total_bytes:pg.total_bytes||0,
                current_folder:pg.current_folder||"",last_index:pg.last_index||0,
                pct:pg.total_messages?Math.round((pg.copied||0)/pg.total_messages*100):0});
              controller.enqueue(enc.encode("data: "+data+"\n\n"));
            }catch(e){controller.enqueue(enc.encode("data: "+JSON.stringify({error:e.message})+"\n\n"))}
          },3000);}});return new Response(stream,{headers:{"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"}})}

      // Jobs cancel — works on active migrations
      if(path==="/api/jobs/cancel"&&request.method==="POST"){
        var cb=await request.json();var ckey="migration:"+cb.source+":"+cb.destination;
        await env.TOKENS.put(ckey+":cancelled","true");
        await env.TOKENS.delete(ckey);
        await ntfy(env.NTFY_URL||"https://ntfy.sh/abbsjai","Migration cancelled: "+cb.source+" → "+cb.destination);
        return Response.json({status:"cancelled"})}

      // Reset migrated record (to start fresh)
      if(path==="/api/jobs/reset"&&request.method==="POST"){
        var rb=await request.json();var rkey="migration:"+rb.source+":"+rb.destination;
        await env.TOKENS.delete(rkey);await env.TOKENS.delete(rkey+":migrated");await env.TOKENS.delete(rkey+":cancelled");
        return Response.json({status:"reset"})}

      // Auth flow
      if(path.startsWith("/auth/")){var state=crypto.randomUUID();var cbUrl=url.origin+"/callback";
        return new Response(null,{status:302,headers:{Location:AUTH+"?"+qs({
          client_id:env.GOOGLE_CLIENT_ID,redirect_uri:cbUrl,response_type:"code",
          scope:SCOPE+" email",access_type:"offline",prompt:"consent",state:state})}})}

      if(path==="/callback"){var code=url.searchParams.get("code");if(!code)return new Response("Missing code",{status:400});
        var tr=await fetch(TOKEN_EP,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
          body:qs({code:code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,
            redirect_uri:url.origin+"/callback",grant_type:"authorization_code"})});
        var td=await tr.json();if(!td.access_token)return new Response("Auth failed",{status:400});
        var profile=await gmailApi(td.access_token,"/users/me/profile");var email=profile.emailAddress;
        await env.TOKENS.put(email,JSON.stringify({access_token:td.access_token,refresh_token:td.refresh_token,
          expires_at:Date.now()+(td.expires_in||3600)*1000}));
        return new Response(null,{status:302,headers:{Location:"/"}})}

      // Remove account
      if(path==="/api/remove"&&request.method==="POST"){var rb=await request.json();
        if(!rb.email)return Response.json({error:"Missing email"},{status:400});
        await env.TOKENS.delete(rb.email);return Response.json({status:"removed"})}



{
        var cs=request.headers.get("X-Cron-Secret")||"";
        if(env.CRON_SECRET&&cs!==env.CRON_SECRET)return Response.json({error:"denied"},{status:401});
        var lim=await checkLimits(env);if(lim.warnings.length)return Response.json({status:"skipped",warnings:lim.warnings});
        var allM=await env.TOKENS.list({prefix:"migration:"});var cont=[];
        for(var ci=0;ci<allM.keys.length;ci++){var mk=allM.keys[ci].name;
          if(mk.indexOf(":migrated")!==-1||mk.indexOf(":cancelled")!==-1)continue;
          var pg=await env.TOKENS.get(mk,"json");if(!pg||!pg.last_index)continue;
          // Re-run migrate logic for this pair with small batch
          var csrc=pg.source;var cdst=pg.destination;
          var ctk=await getToken(env,csrc);var dtok=await getToken(env,cdst);if(!ctk||!dtok)continue;
          // List remaining messages
          var remaining=[];var rpt=null;var rskip=pg.last_index||0;
          while(remaining.length<20){var rnd=await gmailApi(ctk,"/users/me/messages?maxResults="+Math.min(100,20-remaining.length)+(rpt?"&pageToken="+rpt:""));
            if(!rnd.messages||!rnd.messages.length)break;
            if(rskip>0){if(rskip>=rnd.messages.length){rskip-=rnd.messages.length;rpt=rnd.nextPageToken;if(!rpt)break;continue}
              rnd.messages=rnd.messages.slice(rskip);rskip=0}
            remaining=remaining.concat(rnd.messages);rpt=rnd.nextPageToken;if(!rpt)break}
          track("gmail_api_calls",1);
          if(!remaining.length){await env.TOKENS.delete(mk);continue}
          // Pre-create labels
          var csrcUser=csrc.split("@")[0];var clc={};await mkLabel(env,dtok,cdst,"G-"+csrcUser,clc);
          var ccopied=0,cerrs=[],ccids=[],ctb=pg.total_bytes||0,chit=false;
          for(var ci2=0;ci2<remaining.length;ci2++){
            try{var f=await gmailApi(ctk,"/users/me/messages/"+remaining[ci2].id+"?format=metadata&metadataHeaders=Message-ID");
              track("gmail_api_calls",1);track("gmail_quota_units",5);
              var ms=f.sizeEstimate||0;var d2=fmtDate(f.internalDate);var fp2="G-"+csrcUser+"/"+d2.y+"/"+d2.m+"/"+d2.d;
              var lids=[];var yl2=await mkLabel(env,dtok,cdst,fp2,clc);if(yl2)lids.push(yl2);
              var sl2=f.labelIds||[];
              for(var li2=0;li2<sl2.length;li2++){if(sl2[li2]==="UNREAD")continue;var nm2=LABEL_MAP[sl2[li2]]||sl2[li2];
                var fl2=await mkLabel(env,dtok,cdst,fp2+"/"+nm2,clc);if(fl2)lids.push(fl2)}
              var fraw=await gmailApi(ctk,"/users/me/messages/"+remaining[ci2].id+"?format=raw");
              track("gmail_api_calls",1);track("gmail_quota_units",5);
              var rs=fraw.raw.replace(/-/g,"+").replace(/_/g,"/");var eb=atob(rs);
              var iu=GUPLOAD+"/users/me/messages/import?uploadType=media&internalDateSource=dateHeader&neverMarkSpam=true";
              if(lids.length)iu+="&"+lids.map(function(l){return"addedLabelIds="+encodeURIComponent(l)}).join("&");
              var ir=await fetch(iu,{method:"POST",headers:{Authorization:"Bearer "+dtok,"Content-Type":"message/rfc822"},body:eb});
              if(!ir.ok){var et2=await ir.text();throw new Error(ir.status+": "+et2.slice(0,200))}
              track("gmail_api_calls",1);track("gmail_quota_units",10);
              ccopied++;ccids.push(remaining[ci2].id);ctb+=ms;
              var cronNtfyCount=(pg.copied||0)+ccopied;
              if(cronNtfyCount%100===0&&env.NTFY_URL)await ntfy(env.NTFY_URL,cronNtfyCount+" emails migrated: "+csrc+" → "+cdst);
              track("messages_copied",1);track("bytes_transferred",ms);
            }catch(e){if(e.message.indexOf("Too many subrequests")!==-1){chit=true;break}
              cerrs.push({id:remaining[ci2].id,error:e.message.slice(0,200)})}}
          var ni=pg.last_index+ci2;var tc=(pg.copied||0)+ccopied;var ai=(pg.copied_ids||[]).concat(ccids);
          if(chit||ni<(pg.total_messages||ni+1)){
            await env.TOKENS.put(mk,JSON.stringify({source:csrc,destination:cdst,last_index:ni,
              copied:tc,total_bytes:ctb,copied_ids:ai,total_messages:pg.total_messages||ni+ci2}))}
          else{await env.TOKENS.delete(mk);
            if(env.NTFY_URL)await ntfy(env.NTFY_URL,"Migration complete: "+csrc+" → "+cdst+" | "+tc+" emails")}


      return new Response("Not found",{status:404})
    }catch(err){return Response.json({error:err.message,stack:err.stack?err.stack.slice(0,500):""},{status:500})}
    finally{await flushStats(env)}},
  // Cron trigger handler
  async scheduled(event,env){
    try{var lim=await checkLimits(env);if(lim.warnings.length)return;
      await fetch("https://migrator.digitalhands.in/api/cron",{
        method:"POST",headers:{"X-Cron-Secret":env.CRON_SECRET||""}})}catch(e){}}
};
```
-e 
### `scripts/migrate.py` (GH Actions migration script)
```python
#!/usr/bin/env python3
"""
Gmail API Migrator — uses Cloudflare Worker as token authority.

No app passwords needed. Gets fresh OAuth tokens from the CF Worker's
/api/token endpoint, then uses Gmail API for all operations.

Usage (env vars):
  WORKER_URL        — CF Worker URL (e.g. https://gmail-migrator.aakif-share.workers.dev)
  WORKER_AUTH_TOKEN — Auth token for CF Worker API
  GMAIL_SOURCE_USER — Source email
  GMAIL_DEST_USER   — Destination email
  DEST_ID           — dest1 or dest2
  STATE_FILE        — path to state JSON
  STRATEGY          — size | folder | random
  DRY_RUN           — true | false
  SIZE_LIMIT_MB     — max MB per run
  EMAIL_LIMIT       — max emails per run (0=unlimited)
  BATCH_SIZE        — messages per batch (default 10)
  MIGRATION_FOLDER  — folder for folder/random strategy
  SKIP_DEDUP        — true to skip Message-ID dedup
"""
import json
import os
import sys
import time
import email
import base64
import urllib.request
import urllib.error
import urllib.parse
import ssl
from datetime import datetime, timezone

# ── Config ──
WORKER_URL      = os.environ["WORKER_URL"].rstrip("/")
WORKER_TOKEN    = os.environ["WORKER_AUTH_TOKEN"]
CF_ACCESS_ID    = os.environ.get("CF_ACCESS_CLIENT_ID", "")
CF_ACCESS_SECRET = os.environ.get("CF_ACCESS_CLIENT_SECRET", "")
SOURCE_USER     = os.environ["GMAIL_SOURCE_USER"]
DEST_USER       = os.environ["GMAIL_DEST_USER"]
DEST_ID         = os.environ.get("DEST_ID", "dest")
STATE_FILE      = os.environ.get("STATE_FILE", f"migration-state-{DEST_ID}.json")
STRATEGY        = os.environ.get("STRATEGY", "size")
DRY_RUN         = os.environ.get("DRY_RUN", "true").lower() == "true"
SIZE_LIMIT      = int(os.environ.get("SIZE_LIMIT_MB", "500")) * 1024 * 1024
EMAIL_LIMIT     = int(os.environ.get("EMAIL_LIMIT", "0"))
BATCH_SIZE      = int(os.environ.get("BATCH_SIZE", "10"))
FOLDER          = os.environ.get("MIGRATION_FOLDER", "INBOX")
SKIP_DEDUP      = os.environ.get("SKIP_DEDUP", "false").lower() == "true"
SAMPLE_SIZE     = int(os.environ.get("SAMPLE_SIZE", "50"))
LOG_FILE        = "migration.log"

GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"

# Token cache (per-invocation)
_token_cache = {}

# ── Helpers ──
def log(msg):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

def bytes_human(n):
    for u in ["B","KB","MB","GB"]:
        if n < 1024:
            return f"{n:.1f}{u}"
        n /= 1024
    return f"{n:.1f}TB"

# ── Token Management (via CF Worker) ──
def get_token(email_addr):
    """Get fresh access token from CF Worker. Cached per-invocation."""
    if email_addr in _token_cache:
        return _token_cache[email_addr]

    url = f"{WORKER_URL}/api/token?email={urllib.parse.quote(email_addr)}"
    headers = {"Authorization": f"Bearer {WORKER_TOKEN}", "User-Agent": "gmail-migrate/1.0"}
    if CF_ACCESS_ID:
        headers["CF-Access-Client-Id"] = CF_ACCESS_ID
        headers["CF-Access-Client-Secret"] = CF_ACCESS_SECRET
    req = urllib.request.Request(url, headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        log(f"FATAL: token fetch failed for {email_addr}: {e.code} {body}")
        sys.exit(1)

    token = data.get("access_token")
    if not token:
        log(f"FATAL: no token in response for {email_addr}: {data}")
        sys.exit(1)

    _token_cache[email_addr] = token
    return token

def get_source_token():
    return get_token(SOURCE_USER)

def get_dest_token():
    return get_token(DEST_USER)

# ── Gmail API ──
def gmail_api(token, path, method="GET", body=None, content_type="application/json"):
    """Call Gmail API. Returns parsed JSON or raw bytes."""
    url = GMAIL_API + path
    headers = {"Authorization": f"Bearer {token}", "User-Agent": "gmail-migrate/1.0"}

    data = None
    if body is not None:
        if isinstance(body, str):
            data = body.encode("utf-8")
        elif isinstance(body, bytes):
            data = body
        else:
            data = json.dumps(body).encode("utf-8")
        if content_type:
            headers["Content-Type"] = content_type

    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                # Try JSON parse
                try:
                    return json.loads(raw)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    return raw
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt < 2:
                # Token expired — clear cache and retry
                log(f"  401 on {path}, refreshing token (attempt {attempt+1})")
                if token == get_source_token():
                    _token_cache.pop(SOURCE_USER, None)
                    token = get_source_token()
                else:
                    _token_cache.pop(DEST_USER, None)
                    token = get_dest_token()
                headers["Authorization"] = f"Bearer {token}"
                req = urllib.request.Request(url, data=data, headers=headers, method=method)
                continue
            if e.code == 429 or e.code >= 500:
                wait = 2 ** (attempt + 1)
                log(f"  {e.code} on {path}, retry in {wait}s")
                time.sleep(wait)
                continue
            body_text = e.read().decode() if e.fp else str(e)
            raise RuntimeError(f"Gmail API {method} {path}: {e.code} {body_text[:300]}")
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < 2:
                wait = 2 ** (attempt + 1)
                log(f"  Connection error on {path}: {e}, retry in {wait}s")
                time.sleep(wait)
                continue
            raise

    raise RuntimeError(f"Gmail API {method} {path}: failed after 3 attempts")

# ── Gmail Operations ──
def list_labels(token):
    """List all labels, returns {name: id} dict."""
    data = gmail_api(token, "/labels")
    result = {}
    for label in data.get("labels", []):
        result[label["name"]] = label["id"]
    return result

def list_messages(token, query="", max_results=500, page_token=None):
    """
    List messages matching a query. Returns list of {id, threadId}.
    query uses Gmail search syntax: https://support.google.com/mail/answer/7190
    """
    path = f"/messages?maxResults={min(max_results, 500)}"
    if query:
        path += f"&q={urllib.parse.quote(query)}"
    if page_token:
        path += f"&pageToken={urllib.parse.quote(page_token)}"

    data = gmail_api(token, path)
    return data.get("messages", []), data.get("nextPageToken")

def list_all_messages(token, query="", max_results=0):
    """List all messages matching query, paginating automatically."""
    all_msgs = []
    page_token = None
    while True:
        msgs, page_token = list_messages(token, query=query, max_results=500, page_token=page_token)
        if not msgs:
            break
        all_msgs.extend(msgs)
        if max_results and len(all_msgs) >= max_results:
            all_msgs = all_msgs[:max_results]
            break
        if not page_token:
            break
    return all_msgs

def get_message_raw(token, msg_id):
    """Get full message as raw RFC 2822 bytes."""
    data = gmail_api(token, f"/messages/{msg_id}?format=raw")
    if isinstance(data, dict):
        raw_b64 = data.get("raw", "")
        if raw_b64:
            return base64.urlsafe_b64decode(raw_b64)
    return None

def get_message_metadata(token, msg_id):
    """Get message metadata (headers, labelIds, sizeEstimate)."""
    return gmail_api(token, f"/messages/{msg_id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject")

def import_message(token, raw_bytes, label_ids=None):
    """
    Import a raw RFC 2822 message. This is the Gmail API equivalent of IMAP APPEND.
    Returns the created message dict.
    """
    raw_b64 = base64.urlsafe_b64encode(raw_bytes).decode("ascii")
    body = {"raw": raw_b64}
    if label_ids:
        body["labelIds"] = label_ids

    return gmail_api(token, "/messages/import?neverMarkSpam=true", method="POST", body=body)

def get_message_id_from_raw(raw_bytes):
    """Extract Message-ID header from raw RFC 2822 bytes."""
    try:
        msg = email.message_from_bytes(raw_bytes)
        return msg.get("Message-ID", "")
    except Exception:
        return ""

def search_by_message_id(token, message_id):
    """Search for a message by Message-ID header. Returns message ID or None."""
    if not message_id:
        return None
    # Gmail search syntax: rfc822msgid:<message-id>
    escaped = message_id.replace('"', '\\"')
    msgs, _ = list_messages(token, query=f'rfc822msgid:{escaped}', max_results=1)
    if msgs:
        return msgs[0]["id"]
    return None

def create_label(token, name, labels_cache):
    """Create a label if it doesn't exist. Returns label ID."""
    if name in labels_cache:
        return labels_cache[name]

    try:
        result = gmail_api(token, "/labels", method="POST", body={
            "name": name,
            "labelListVisibility": "labelShow",
            "messageListVisibility": "show"
        })
        labels_cache[name] = result["id"]
        return result["id"]
    except RuntimeError as e:
        if "409" in str(e) or "ALREADY_EXISTS" in str(e):
            # Refresh labels cache
            labels_cache.clear()
            labels_cache.update(list_labels(token))
            return labels_cache.get(name)
        raise

# ── State Management ──
def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {
            "schema_version": 3,
            "source_account": SOURCE_USER,
            "destination": DEST_ID,
            "strategy": STRATEGY,
            "processed_emails": 0,
            "processed_bytes": 0,
            "completed_folders": [],
            "last_folder": None,
            "last_msg_id": None,
            "folder_state": {},
            "status": "pending",
            "started_at": None,
            "updated_at": None,
            "errors": [],
        }

def save_state(state):
    state["updated_at"] = datetime.now(timezone.utc).isoformat()
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

def get_folder_state(state, folder):
    fs = state.setdefault("folder_state", {})
    return fs.setdefault(folder, {"copied": 0, "bytes": 0, "skipped": 0, "last_msg_id": None, "completed": False})

# ── Folder Mapping ──
# Gmail API uses label names. Source labels map to destination labels with G- prefix.
SKIP_LABELS = {"SPAM", "TRASH"}

def gmail_query_for_folder(folder):
    """Convert a folder/label name to a Gmail search query."""
    if folder == "INBOX":
        return "in:inbox"
    elif folder == "SENT":
        return "in:sent"
    elif folder == "DRAFT":
        return "in:draft"
    elif folder == "STARRED":
        return "in:starred"
    elif folder.startswith("CATEGORY_"):
        return f"in:{folder.replace('CATEGORY_', '').lower()}"
    else:
        # Custom label
        return f'label:"{folder}"'

def dest_label_name(src_label):
    """Map source label to destination label with G- prefix."""
    return f"G-{SOURCE_USER}/{src_label}"

# ── Main Copy Logic ──
def copy_messages(src_token, dst_token, src_folder, state, limit_bytes=0, limit_emails=0):
    """
    Copy messages from source folder/label to destination with G- prefix.
    Returns (copied, bytes, skipped).
    """
    folder_st = get_folder_state(state, src_folder)
    dest_label = dest_label_name(src_folder)

    # Ensure destination label exists
    dst_labels = {}
    try:
        dst_labels = list_labels(dst_token)
        create_label(dst_token, dest_label, dst_labels)
    except Exception as e:
        log(f"  Warning: couldn't create dest label {dest_label}: {e}")

    # List messages in source folder
    query = gmail_query_for_folder(src_folder)
    log(f"  Query: {query}")

    messages = list_all_messages(src_token, query=query)
    total_in_folder = len(messages)
    log(f"  {src_folder}: {total_in_folder} messages (batch_size={BATCH_SIZE})")

    if not messages:
        return 0, 0, 0

    copied = 0
    total_bytes = 0
    skipped = 0
    last_msg_id = folder_st.get("last_msg_id")
    resume = last_msg_id is not None

    batch_start = time.time()
    batch_copied = 0

    for msg_ref in messages:
        msg_id = msg_ref["id"]

        # Resume: skip until we pass last_msg_id
        if resume:
            if msg_id == last_msg_id:
                resume = False
            continue

        # Check limits
        if limit_emails and copied >= limit_emails:
            log(f"  Email limit ({limit_emails}) reached")
            break
        if limit_bytes and total_bytes >= limit_bytes:
            log(f"  Size limit ({bytes_human(limit_bytes)}) reached")
            break

        try:
            # Get raw message from source
            raw = get_message_raw(src_token, msg_id)
            if raw is None:
                skipped += 1
                batch_copied += 1
                continue

            msg_size = len(raw)

            # Dedup check
            if not SKIP_DEDUP:
                msg_id_header = get_message_id_from_raw(raw)
                if msg_id_header:
                    existing = search_by_message_id(dst_token, msg_id_header)
                    if existing:
                        skipped += 1
                        batch_copied += 1
                        continue

            # Import to destination
            if not DRY_RUN:
                dest_label_ids = [dst_labels.get(dest_label)] if dest_label in dst_labels else []
                import_message(dst_token, raw, label_ids=[lid for lid in dest_label_ids if lid])

            copied += 1
            total_bytes += msg_size
            batch_copied += 1

            # Batch progress
            if batch_copied >= BATCH_SIZE:
                elapsed = time.time() - batch_start
                rate = (batch_copied / elapsed * 60) if elapsed > 0 else 0
                log(f"[BATCH] folder={src_folder} done={copied}/{total_in_folder} "
                    f"bytes={bytes_human(total_bytes)} {elapsed:.1f}s {rate:.1f} msg/min")

                # Save state
                folder_st["last_msg_id"] = msg_id
                folder_st["copied"] = copied
                folder_st["bytes"] = total_bytes
                state["last_folder"] = src_folder
                state["last_msg_id"] = msg_id
                save_state(state)

                batch_start = time.time()
                batch_copied = 0

                # Small sleep to respect rate limits
                time.sleep(0.5)

        except RuntimeError as e:
            log(f"  Error on msg {msg_id}: {e}")
            state.setdefault("errors", []).append({
                "folder": src_folder,
                "msg_id": msg_id,
                "error": str(e)[:200],
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            skipped += 1

    # Final batch flush
    if batch_copied > 0:
        elapsed = time.time() - batch_start
        rate = (batch_copied / elapsed * 60) if elapsed > 0 else 0
        log(f"[BATCH] folder={src_folder} done={copied}/{total_in_folder} "
            f"bytes={bytes_human(total_bytes)} {elapsed:.1f}s {rate:.1f} msg/min")

    # Mark folder complete
    completed = state.get("completed_folders", [])
    if src_folder not in completed:
        completed.append(src_folder)
        state["completed_folders"] = completed

    folder_st["completed"] = True
    folder_st["last_msg_id"] = messages[-1]["id"] if messages else folder_st.get("last_msg_id")
    folder_st["copied"] = copied
    folder_st["bytes"] = total_bytes
    folder_st["skipped"] = skipped

    state["processed_emails"] = state.get("processed_emails", 0) + copied
    state["processed_bytes"] = state.get("processed_bytes", 0) + total_bytes
    state["last_folder"] = src_folder
    save_state(state)

    return copied, total_bytes, skipped

# ── Main ──
def main():
    import urllib.parse  # needed for get_token

    log("=" * 60)
    log("Gmail API Migrator (via CF Worker tokens)")
    log("=" * 60)
    log(f"Source:      {SOURCE_USER}")
    log(f"Dest:        {DEST_USER} ({DEST_ID})")
    log(f"Strategy:    {STRATEGY}")
    log(f"Dry run:     {DRY_RUN}")
    log(f"Size limit:  {bytes_human(SIZE_LIMIT) if SIZE_LIMIT else 'unlimited'}")
    log(f"Email limit: {EMAIL_LIMIT or 'unlimited'}")
    log(f"Batch size:  {BATCH_SIZE}")
    log(f"Skip dedup:  {SKIP_DEDUP}")
    log("")

    state = load_state()
    if not state.get("started_at"):
        state["started_at"] = datetime.now(timezone.utc).isoformat()
    state["status"] = "running"
    state["strategy"] = STRATEGY
    save_state(state)

    total_copied = 0
    total_bytes = 0
    total_skipped = 0

    try:
        # Verify tokens work
        src_token = get_source_token()
        dst_token = get_dest_token()
        log("✅ Tokens acquired from CF Worker")

        if STRATEGY == "folder":
            copied, bts, skipped = copy_messages(
                src_token, dst_token, FOLDER, state,
                limit_bytes=SIZE_LIMIT, limit_emails=EMAIL_LIMIT
            )
            total_copied += copied
            total_bytes += bts
            total_skipped += skipped

        elif STRATEGY == "size":
            # Get source labels (folders)
            src_labels = list_labels(src_token)
            log(f"Found {len(src_labels)} source labels")

            remaining_bytes = SIZE_LIMIT
            # Process in priority: custom labels first, then system
            priority_order = []
            system_labels = {"INBOX", "SENT", "DRAFT", "STARRED", "IMPORTANT",
                           "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS",
                           "CATEGORY_UPDATES", "CATEGORY_FORUMS"}

            for name in sorted(src_labels.keys()):
                if name in SKIP_LABELS:
                    continue
                if name in system_labels:
                    continue
                priority_order.append(name)
            for name in sorted(src_labels.keys()):
                if name in SKIP_LABELS:
                    continue
                if name in system_labels and name not in [l for l in priority_order]:
                    priority_order.append(name)

            log(f"Processing {len(priority_order)} folders")

            for folder in priority_order:
                folder_st = get_folder_state(state, folder)
                if folder_st.get("completed") and folder in state.get("completed_folders", []):
                    log(f"  Skipping completed: {folder}")
                    continue
                if remaining_bytes <= 0:
                    log("Size limit reached, stopping")
                    break

                log(f"\n--- Folder: {folder} ---")
                copied, bts, skipped = copy_messages(
                    src_token, dst_token, folder, state,
                    limit_bytes=remaining_bytes
                )
                total_copied += copied
                total_bytes += bts
                total_skipped += skipped
                remaining_bytes -= bts

        elif STRATEGY == "random":
            query = gmail_query_for_folder(FOLDER)
            messages = list_all_messages(src_token, query=query)
            import random
            sample = random.sample(messages, min(SAMPLE_SIZE, len(messages)))
            log(f"Random sample: {len(sample)} from {len(messages)}")

            for msg_ref in sample:
                raw = get_message_raw(src_token, msg_ref["id"])
                if raw:
                    if not DRY_RUN:
                        import_message(dst_token, raw)
                    total_copied += 1
                    total_bytes += len(raw)

        state["status"] = "completed" if not DRY_RUN else "dry-run"
        save_state(state)

    except KeyboardInterrupt:
        log("Interrupted — saving state")
        state["status"] = "interrupted"
        save_state(state)
    except Exception as e:
        log(f"FATAL: {e}")
        state["status"] = "failed"
        state.setdefault("errors", []).append({"error": str(e)[:500]})
        save_state(state)

    log("")
    log("=" * 60)
    log(f"Migration {'dry-run' if DRY_RUN else 'run'} complete")
    log(f"  Copied:  {total_copied} messages ({bytes_human(total_bytes)})")
    log(f"  Skipped: {total_skipped}")
    log(f"  Errors:  {len(state.get('errors', []))}")
    log("=" * 60)

    sys.exit(0 if state["status"] in ("completed", "dry-run") else 1)

if __name__ == "__main__":
    main()
```
-e 
### `.github/workflows/migrate.yml`
```yaml
name: Gmail API Migration

on:
  schedule:
    # Daily at 03:00 UTC — low-traffic window
    - cron: '0 3 * * *'

  workflow_dispatch:
    inputs:
      strategy:
        description: 'Migration strategy'
        required: true
        default: 'size'
        type: choice
        options:
          - size
          - folder
          - random
      size_limit_mb:
        description: 'Max MB to transfer per run (0 = unlimited)'
        required: false
        default: '1'
        type: string
      email_limit:
        description: 'Max emails to migrate (0 = unlimited)'
        required: false
        default: '1'
        type: string
      folder:
        description: 'Folder/label to migrate (folder strategy only)'
        required: false
        default: 'INBOX'
        type: string
      sample_size:
        description: 'Number of emails to sample (random strategy only)'
        required: false
        default: '5'
        type: string
      dry_run:
        description: 'Dry run — report only, no writes'
        required: false
        default: false
        type: boolean
      skip_dedup:
        description: 'Skip Message-ID dedup check (use for first run on empty destinations)'
        required: false
        default: false
        type: boolean
      batch_size:
        description: 'Messages per batch for progress reporting'
        required: false
        default: '5'
        type: string
      destination:
        description: 'Target destination(s)'
        required: true
        default: 'both'
        type: choice
        options:
          - both
          - dest1
          - dest2
      delete_from_source:
        description: '[WARN] DELETE migrated mail from source after both destinations succeed'
        required: false
        default: true
        type: boolean

permissions:
  contents: write   # needed to commit state file

jobs:
  # ─────────────────────────────────────────────
  # Setup: compute matrix based on destination input
  # ─────────────────────────────────────────────
  setup:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.build-matrix.outputs.matrix }}
    steps:
      - name: Build destination matrix
        id: build-matrix
        run: |
          DEST="${{ inputs.destination || 'both' }}"
          case "$DEST" in
            dest1)
              echo 'matrix={"include":[{"id":"dest1","dest_user":"GMAIL_DEST1_USER","state_file":"migration-state-dest1.json"}]}' >> "$GITHUB_OUTPUT"
              ;;
            dest2)
              echo 'matrix={"include":[{"id":"dest2","dest_user":"GMAIL_DEST2_USER","state_file":"migration-state-dest2.json"}]}' >> "$GITHUB_OUTPUT"
              ;;
            *)
              echo 'matrix={"include":[{"id":"dest1","dest_user":"GMAIL_DEST1_USER","state_file":"migration-state-dest1.json"},{"id":"dest2","dest_user":"GMAIL_DEST2_USER","state_file":"migration-state-dest2.json"}]}' >> "$GITHUB_OUTPUT"
              ;;
          esac

  # ─────────────────────────────────────────────
  # Migration: parallel per-destination
  # Tokens fetched from CF Worker — no app passwords
  # ─────────────────────────────────────────────
  migrate:
    needs: setup
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: ${{ fromJson(needs.setup.outputs.matrix) }}

    env:
      DEST_ID:            ${{ matrix.id }}
      GMAIL_DEST_USER:    ${{ secrets[matrix.dest_user] }}
      STATE_FILE:         ${{ matrix.state_file }}
      GMAIL_SOURCE_USER:  ${{ secrets.GMAIL_SOURCE_USER }}
      WORKER_URL:         ${{ secrets.WORKER_URL }}
      WORKER_AUTH_TOKEN:  ${{ secrets.WORKER_AUTH_TOKEN }}
      CF_ACCESS_CLIENT_ID:     ${{ secrets.CF_ACCESS_CLIENT_ID }}
      CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}
      STRATEGY:           ${{ inputs.strategy || 'size' }}
      SIZE_LIMIT_MB:      ${{ inputs.size_limit_mb || '500' }}
      EMAIL_LIMIT:        ${{ inputs.email_limit || '0' }}
      MIGRATION_FOLDER:   ${{ inputs.folder || 'INBOX' }}
      SAMPLE_SIZE:        ${{ inputs.sample_size || '50' }}
      DRY_RUN:            ${{ fromJSON(inputs.dry_run || false) && 'true' || 'false' }}
      SKIP_DEDUP:         ${{ fromJSON(inputs.skip_dedup || false) && 'true' || 'false' }}
      BATCH_SIZE:         ${{ inputs.batch_size || '10' }}

    steps:
      # ── Mask tokens in logs ──
      - name: Mask secrets in logs
        run: |
          echo "::add-mask::${{ secrets.WORKER_AUTH_TOKEN }}"
          echo "::add-mask::${{ secrets.CF_ACCESS_CLIENT_SECRET }}"
          echo "::add-mask::${{ secrets.GH_TOKEN }}"

      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.GH_TOKEN }}

      - name: Prepare scripts
        run: chmod +x scripts/*.sh scripts/*.py 2>/dev/null; true

      # ── Initialise state file if it doesn't exist ──
      - name: Initialise state file
        run: |
          if [ ! -f "$STATE_FILE" ]; then
            cat > "$STATE_FILE" << 'EOF'
          {
            "schema_version": 3,
            "source_account": "aakifshamsi@gmail.com",
            "destination": "",
            "strategy": "",
            "processed_emails": 0,
            "processed_bytes": 0,
            "completed_folders": [],
            "last_folder": null,
            "last_msg_id": null,
            "folder_state": {},
            "status": "pending",
            "started_at": null,
            "updated_at": null,
            "errors": []
          }
          EOF
            echo "Created fresh state file: $STATE_FILE"
          else
            echo "Loaded existing state file: $STATE_FILE"
            cat "$STATE_FILE"
          fi

      # ── Run migration ──
      - name: Run migration
        id: migration
        run: python3 scripts/migrate.py
        continue-on-error: true

      # ── Write GitHub Actions Job Summary ──
      - name: Write job summary
        if: always()
        run: |
          STATUS="${{ steps.migration.outcome }}"

          # Read stats from state file
          EMAILS=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d.get('processed_emails',0))")
          BYTES=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d.get('processed_bytes',0))")
          BYTES_HR=$(numfmt --to=iec "$BYTES" 2>/dev/null || echo "${BYTES}B")
          ERRORS=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(len(d.get('errors',[])))")
          LAST_FOLDER=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d.get('last_folder') or 'N/A')")

          cat >> "$GITHUB_STEP_SUMMARY" << EOF
          ## Gmail Migration — $DEST_ID

          | Metric | Value |
          |--------|-------|
          | Strategy | \`$STRATEGY\` |
          | Dry run | $DRY_RUN |
          | Emails migrated | $EMAILS |
          | Bytes transferred | $BYTES_HR |
          | Last folder | \`$LAST_FOLDER\` |
          | Errors | $ERRORS |
          | Outcome | $STATUS |
          | Run number | #${{ github.run_number }} |

          $([ "$DRY_RUN" = "true" ] && echo "> ⚠️ **DRY RUN** — no messages were written to destination.")
          $([ "$STATUS" != "success" ] && echo "> ❌ **Migration encountered errors.** Check logs above.")
          EOF

      # ── Upload migration log and state as artifact ──
      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: migration-${{ matrix.id }}-run-${{ github.run_number }}
          path: |
            migration.log
            ${{ matrix.state_file }}
          retention-days: 30

      # ── Commit updated state file back to repo ──
      - name: Commit state file
        if: always() && env.DRY_RUN != 'true'
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add "$STATE_FILE"
          if git diff --staged --quiet; then
            echo "No state changes to commit."
            exit 0
          fi
          TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
          git commit -m "chore: update migration state [$DEST_ID] $TIMESTAMP [skip ci]"

          # Retry push with rebase to handle parallel matrix jobs
          for attempt in 1 2 3 4 5; do
            if git push; then
              echo "State file committed on attempt $attempt."
              break
            fi
            echo "Push failed (attempt $attempt/5), rebasing and retrying..."
            git pull --rebase origin "${{ github.ref_name }}"
            sleep $((RANDOM % 8 + 3))
          done
        env:
          GITHUB_TOKEN: ${{ secrets.GH_TOKEN }}

      # ── Final step: propagate migration failure ──
      - name: Check migration result
        if: steps.migration.outcome == 'failure' && env.DRY_RUN != 'true'
        run: |
          echo "Migration failed for $DEST_ID. See logs above."
          exit 1

  # ─────────────────────────────────────────────
  # Cleanup: delete migrated mail from source
  # Only runs after BOTH destinations succeed
  # ─────────────────────────────────────────────
  cleanup:
    needs: migrate
    if: >-
      always() &&
      needs.migrate.result == 'success' &&
      inputs.delete_from_source == true &&
      inputs.dry_run != true
    runs-on: ubuntu-latest
    env:
      GMAIL_SOURCE_USER:    ${{ secrets.GMAIL_SOURCE_USER }}
      GMAIL_DEST1_USER:     ${{ secrets.GMAIL_DEST1_USER }}
      GMAIL_DEST2_USER:     ${{ secrets.GMAIL_DEST2_USER }}
      WORKER_URL:           ${{ secrets.WORKER_URL }}
      WORKER_AUTH_TOKEN:    ${{ secrets.WORKER_AUTH_TOKEN }}
      CF_ACCESS_CLIENT_ID:     ${{ secrets.CF_ACCESS_CLIENT_ID }}
      CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}
      MIGRATION_FOLDER:     ${{ inputs.folder || 'INBOX' }}

    steps:
      - name: Mask secrets
        run: |
          echo "::add-mask::${{ secrets.WORKER_AUTH_TOKEN }}"
          echo "::add-mask::${{ secrets.CF_ACCESS_CLIENT_SECRET }}"

      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Prepare scripts
        run: chmod +x scripts/*.sh scripts/*.py 2>/dev/null; true

      # ── Verify both destinations have the mail ──
      - name: Verify destinations before deletion
        id: verify
        run: |
          echo "## Pre-deletion verification" | tee cleanup-report.txt
          echo "" | tee -a cleanup-report.txt

          python3 - << 'PYEOF' | tee -a cleanup-report.txt
          import json, os, sys, urllib.request, urllib.parse, base64

          WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
          WORKER_TOKEN = os.environ["WORKER_AUTH_TOKEN"]
          SRC = os.environ["GMAIL_SOURCE_USER"]
          D1  = os.environ["GMAIL_DEST1_USER"]
          D2  = os.environ["GMAIL_DEST2_USER"]
          GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"

          def get_token(email):
              url = f"{WORKER_URL}/api/token?email={urllib.parse.quote(email)}"
              req = urllib.request.Request(url, headers={"Authorization": f"Bearer {WORKER_TOKEN}"})
              with urllib.request.urlopen(req, timeout=15) as resp:
                  return json.loads(resp.read())["access_token"]

          def api(token, path):
              req = urllib.request.Request(GMAIL_API + path, headers={"Authorization": f"Bearer {token}"})
              with urllib.request.urlopen(req, timeout=30) as resp:
                  return json.loads(resp.read())

          def count_messages(token, label_name):
              try:
                  data = api(token, f"/messages?q=label:{urllib.parse.quote(label_name)}&maxResults=1")
                  return data.get("resultSizeEstimate", 0)
              except:
                  return 0

          # Get tokens
          src_t = get_token(SRC)
          d1_t  = get_token(D1)
          d2_t  = get_token(D2)

          # Get source labels
          src_labels = api(src_t, "/labels")["labels"]
          prefix = f"G-{SRC}/"

          SKIP = {"SPAM", "TRASH", "DRAFT"}
          safe = True

          print(f"{'Label':<40} {'Src':>6} {'D1':>6} {'D2':>6} {'Safe?'}")
          print(f"{'-'*40} {'---':>6} {'---':>6} {'---':>6} {'-----'}")

          for label in sorted(src_labels, key=lambda l: l["name"]):
              name = label["name"]
              if name in SKIP or name.startswith("CATEGORY_"):
                  continue

              src_count = count_messages(src_t, name)
              d1_count = count_messages(d1_t, f"{prefix}{name}")
              d2_count = count_messages(d2_t, f"{prefix}{name}")

              if d1_count >= src_count and d2_count >= src_count:
                  status = "✅"
              else:
                  status = "⚠️ NO"
                  safe = False
              print(f"{name:<40} {src_count:>6} {d1_count:>6} {d2_count:>6} {status}")

          print()
          if safe:
              print("✅ Both destinations have all mail. Safe to delete from source.")
          else:
              print("⚠️ NOT safe to delete — deltas exist. Run more migrations first.")
              sys.exit(1)
          PYEOF

      # ── Execute deletion from source ──
      - name: Delete migrated mail from source
        id: delete
        if: steps.verify.outcome == 'success'
        run: |
          echo "=== Deleting migrated mail from source ==="
          CLEANUP_ACTION=delete python3 scripts/cleanup.py 2>&1 | tee cleanup-output.txt || true

      # ── Upload cleanup artifacts ──
      - name: Upload cleanup artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: cleanup-run-${{ github.run_number }}
          path: |
            cleanup-report.txt
            cleanup-output.txt
          retention-days: 30
          if-no-files-found: ignore
```
