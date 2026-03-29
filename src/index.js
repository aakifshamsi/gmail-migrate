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
