export const DASHBOARD_HTML = `<!DOCTYPE html>
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
  function escapeHtml(str){return String(str).replace(/[&<>\"]/g, function(m){return ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[m]})}

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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function(){});
  }
  </script>
</body>
</html>`;
