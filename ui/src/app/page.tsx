"use client";
import { useCallback, useEffect, useRef, useState } from "react";

interface FolderRow {
  id: string; name: string; type: string;
  g1Count: number; estimatedBytes: number;
  g2Count: number; g3Count: number;
}
interface FoldersData {
  rows: FolderRow[];
  sourceUser: string | null;
  dest1User: string | null;
  dest2User: string | null;
}
interface RunStatus {
  status: string;
  processed_emails: number;
  processed_bytes: number;
  last_folder: string | null;
  updated_at: string | null;
  errors_count: number;
  completed_folders: number;
}
interface StatusData { dest1: RunStatus | null; dest2: RunStatus | null; }
interface Job {
  id: number;
  name: string;
  status: string;       // queued | in_progress | completed
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  display_title: string;
}
interface TokenStatus { valid: boolean; error?: string; checkedAt?: string; }

function bytesHuman(n: number): string {
  if (!n) return "0 B";
  const units = ["B","KB","MB","GB","TB"];
  let v = n;
  for (const u of units) { if (v < 1024) return `${v.toFixed(1)} ${u}`; v /= 1024; }
  return `${v.toFixed(1)} PB`;
}

function mirrorCell(g1: number, gn: number) {
  if (g1 === 0) return { icon: "⬜", label: "—", cls: "text-gray-700" };
  if (gn >= g1)  return { icon: "✅", label: gn.toLocaleString(), cls: "text-emerald-400" };
  if (gn > 0) {
    const pct = Math.round((gn / g1) * 100);
    return { icon: "🔄", label: `${pct}%`, cls: "text-amber-400" };
  }
  return { icon: "⬜", label: "—", cls: "text-gray-600" };
}

function statusBadge(s: string) {
  const map: Record<string, string> = {
    completed: "text-emerald-400", "dry-run": "text-emerald-400",
    running: "text-blue-400", failed: "text-red-400",
    interrupted: "text-amber-400",
  };
  return map[s] ?? "text-gray-500";
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full bg-gray-800 rounded-full overflow-hidden">
      <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${Math.min(Math.max(pct,0),100)}%` }} />
    </div>
  );
}

function Select({ value, onChange, options, placeholder }: {
  value: string; onChange: (v: string) => void;
  options: string[]; placeholder?: string;
}) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-100 focus:outline-none">
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function TokenBadge({ status, loading }: { status?: TokenStatus; loading?: boolean }) {
  if (loading) return <span className="text-xs text-gray-600">checking…</span>;
  if (!status) return null;
  if (status.valid) return <span className="text-xs text-emerald-400" title="Token valid">✅</span>;
  return <span className="text-xs text-red-400" title={status.error ?? "Token invalid"}>❌ Re-auth</span>;
}

export default function Home() {
  const [accounts, setAccounts] = useState<string[]>([]);
  const [srcAcc, setSrcAcc] = useState("");
  const [d1Acc, setD1Acc] = useState("");
  const [d2Acc, setD2Acc] = useState("");
  const [tokenStatuses, setTokenStatuses] = useState<Record<string, TokenStatus>>({});
  const [checkingToken, setCheckingToken] = useState<Record<string, boolean>>({});

  const [data, setData] = useState<FoldersData | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadingF, setLoadingF] = useState(false);
  const [loadingS, setLoadingS] = useState(true);
  const [loadingJ, setLoadingJ] = useState(false);
  const [errF, setErrF] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dispatching, setDispatching] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [jobAction, setJobAction] = useState<number | null>(null);

  // controls
  const [strategy, setStrategy] = useState("size");
  const [sizeMb, setSizeMb] = useState(500);
  const [emailLim, setEmailLim] = useState(0);
  const [batch, setBatch] = useState(10);
  const [dryRun, setDryRun] = useState(true);
  const [skipDedup, setSkipDedup] = useState(false);
  const [delSrc, setDelSrc] = useState(false);
  const [ntfyEmails, setNtfyEmails] = useState(100);
  const [ntfyMb, setNtfyMb] = useState(50);
  const [adv, setAdv] = useState(false);

  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch connected accounts from CF Worker
  useEffect(() => {
    fetch("/api/accounts").then(r => r.json()).then((accts: string[]) => {
      if (!Array.isArray(accts)) return;
      setAccounts(accts);
      if (accts[0]) setSrcAcc(accts[0]);
      if (accts[1]) setD1Acc(accts[1]);
      if (accts[2]) setD2Acc(accts[2]);
    }).catch(() => {});
  }, []);

  // Check token health for an account
  const checkToken = useCallback(async (email: string) => {
    if (!email) return;
    setCheckingToken(p => ({ ...p, [email]: true }));
    try {
      const r = await fetch(`/api/token-status?email=${encodeURIComponent(email)}`);
      const d: TokenStatus = await r.json();
      setTokenStatuses(p => ({ ...p, [email]: d }));
    } catch {
      setTokenStatuses(p => ({ ...p, [email]: { valid: false, error: "fetch failed" } }));
    } finally {
      setCheckingToken(p => ({ ...p, [email]: false }));
    }
  }, []);

  // Recheck tokens when account selection changes
  useEffect(() => { if (srcAcc) checkToken(srcAcc); }, [srcAcc, checkToken]);
  useEffect(() => { if (d1Acc) checkToken(d1Acc); }, [d1Acc, checkToken]);
  useEffect(() => { if (d2Acc) checkToken(d2Acc); }, [d2Acc, checkToken]);

  const fetchFolders = useCallback(async () => {
    if (!srcAcc) return;
    setLoadingF(true); setErrF(null);
    try {
      const params = new URLSearchParams({ source: srcAcc });
      if (d1Acc) params.set("dest1", d1Acc);
      if (d2Acc) params.set("dest2", d2Acc);
      const r = await fetch(`/api/folders?${params}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
    } catch (e) { setErrF(e instanceof Error ? e.message : String(e)); }
    finally { setLoadingF(false); }
  }, [srcAcc, d1Acc, d2Acc]);

  const fetchStatus = useCallback(async () => {
    setLoadingS(true);
    try {
      const r = await fetch("/api/status");
      if (r.ok) setStatus(await r.json());
    } catch { /* silent */ }
    finally { setLoadingS(false); }
  }, []);

  const fetchJobs = useCallback(async () => {
    setLoadingJ(true);
    try {
      const r = await fetch("/api/jobs");
      if (r.ok) setJobs(await r.json());
    } catch { /* silent */ }
    finally { setLoadingJ(false); }
  }, []);

  const doJobAction = async (runId: number, action: "cancel" | "rerun") => {
    setJobAction(runId);
    try {
      await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, action }) });
      setTimeout(fetchJobs, 2_000);
    } finally { setJobAction(null); }
  };

  useEffect(() => { fetchStatus(); fetchJobs(); }, [fetchStatus, fetchJobs]);
  useEffect(() => { if (srcAcc) fetchFolders(); }, [srcAcc, d1Acc, d2Acc, fetchFolders]);

  // Poll status while any run is active
  useEffect(() => {
    const running = status?.dest1?.status === "running" || status?.dest2?.status === "running";
    if (running && !pollRef.current) pollRef.current = setInterval(fetchStatus, 20_000);
    if (!running && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status, fetchStatus]);

  // Poll jobs while any job is queued/in_progress
  useEffect(() => {
    const active = jobs.some(j => j.status === "queued" || j.status === "in_progress");
    if (active && !jobPollRef.current) jobPollRef.current = setInterval(() => { fetchJobs(); fetchStatus(); }, 15_000);
    if (!active && jobPollRef.current) { clearInterval(jobPollRef.current); jobPollRef.current = null; }
    return () => { if (jobPollRef.current) clearInterval(jobPollRef.current); };
  }, [jobs, fetchJobs, fetchStatus]);

  const rows = data?.rows ?? [];
  const totalFolders = rows.length;
  const toggle = (n: string) => setSelected(p => { const s = new Set(p); s.has(n) ? s.delete(n) : s.add(n); return s; });
  const toggleAll = () => setSelected(selected.size === rows.length ? new Set() : new Set(rows.map(r => r.name)));

  const selRows = rows.filter(r => selected.has(r.name));
  const selEmails = selRows.reduce((a, r) => a + r.g1Count, 0);
  const selBytes  = selRows.reduce((a, r) => a + r.estimatedBytes, 0);

  // Derive destination from which account slots are populated
  const destination = d1Acc && d2Acc ? "both" : d1Acc ? "dest1" : "dest2";

  const srcTokenValid = tokenStatuses[srcAcc]?.valid !== false; // true if valid or unchecked
  const srcTokenInvalid = tokenStatuses[srcAcc]?.valid === false;

  const runMigration = async (dry: boolean) => {
    if (!d1Acc && !d2Acc) { setResult({ ok: false, msg: "Select at least one destination account." }); return; }
    if (!dry && !confirm(
      `Copy ${selEmails > 0 ? selEmails.toLocaleString() + " emails" : "all emails"} to ${destination}?\n\nThis will dispatch a GitHub Actions workflow.`
    )) return;
    setDispatching(true); setResult(null);
    try {
      const res = await fetch("/api/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy, sizeLimitMb: sizeMb, emailLimit: emailLim,
          folder: strategy === "folder" ? (selRows[0]?.name ?? "INBOX") : "INBOX",
          destination, dryRun: dry, skipDedup, batchSize: batch,
          migrationFolders: selected.size > 0 ? Array.from(selected).join(",") : "",
          deleteFromSource: !dry && delSrc,
          ntfy_email_milestone: String(ntfyEmails),
          ntfy_mb_milestone: String(ntfyMb),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setResult({ ok: true, msg: "Workflow dispatched!" });
      // Poll jobs aggressively until run appears
      setTimeout(() => { fetchJobs(); fetchStatus(); }, 3_000);
      setTimeout(() => { fetchJobs(); fetchStatus(); }, 8_000);
      setTimeout(() => { fetchJobs(); fetchStatus(); }, 15_000);
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally { setDispatching(false); }
  };

  const ghRepo = process.env.NEXT_PUBLIC_GITHUB_REPO ?? "";
  const otherAccounts = (exclude: string[]) => accounts.filter(a => !exclude.includes(a));

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Gmail Migration Dashboard</h1>
          {accounts.length === 0 && (
            <p className="text-xs text-red-400 mt-0.5">No accounts found — check CF Worker connection</p>
          )}
        </div>
        <button onClick={() => { fetchFolders(); fetchStatus(); }} disabled={loadingF || !srcAcc}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg disabled:opacity-50">
          {loadingF ? "…" : "↻ Refresh"}
        </button>
      </div>

      {/* Account selectors with token status */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Accounts</p>
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Source (G1)", value: srcAcc, onChange: setSrcAcc, exclude: [d1Acc, d2Acc] },
            { label: "Dest 1 (G2)", value: d1Acc, onChange: setD1Acc, exclude: [srcAcc, d2Acc], optional: true },
            { label: "Dest 2 (G3)", value: d2Acc, onChange: setD2Acc, exclude: [srcAcc, d1Acc], optional: true },
          ].map(({ label, value, onChange, exclude, optional }) => (
            <div key={label}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-gray-600">{label}</p>
                <TokenBadge
                  status={value ? tokenStatuses[value] : undefined}
                  loading={value ? checkingToken[value] : false}
                />
              </div>
              <Select value={value} onChange={onChange}
                options={optional ? ["", ...otherAccounts(exclude)] : accounts}
                placeholder={optional ? "— none —" : "— select —"} />
            </div>
          ))}
        </div>
        {accounts.length > 0 && (
          <p className="text-xs text-gray-700 mt-2">{accounts.length} account{accounts.length !== 1 ? "s" : ""} connected in CF Worker</p>
        )}
        {srcTokenInvalid && (
          <p className="text-xs text-red-400 mt-2">
            ❌ Source token invalid — <a href={`/auth/${encodeURIComponent(srcAcc)}`} className="underline">re-authorize {srcAcc}</a>
          </p>
        )}
      </div>

      {/* Folder comparison table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="grid grid-cols-[2rem_1fr_5.5rem_7rem_7rem] px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-800">
          <input type="checkbox" className="accent-blue-500"
            checked={selected.size === rows.length && rows.length > 0} onChange={toggleAll} />
          <span>Folder</span>
          <span className="text-right">G1</span>
          <span className="text-right">{d1Acc ? d1Acc.split("@")[0] : "G2"} Mirror</span>
          <span className="text-right">{d2Acc ? d2Acc.split("@")[0] : "G3"} Mirror</span>
        </div>

        {!srcAcc && <p className="px-4 py-10 text-center text-sm text-gray-600">Select a source account above.</p>}
        {srcAcc && loadingF && <p className="px-4 py-10 text-center text-sm text-gray-600">Fetching folders…</p>}
        {errF && (
          <div className="px-4 py-6 text-center">
            <p className="text-red-400 text-sm font-mono">{errF}</p>
            <button onClick={fetchFolders} className="mt-2 text-xs text-gray-500 hover:text-white underline">Retry</button>
          </div>
        )}
        {!loadingF && !errF && srcAcc && rows.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-gray-600">No folders found.</p>
        )}

        {rows.length > 0 && (
          <div className="divide-y divide-gray-800/40 max-h-96 overflow-y-auto">
            {rows.map(row => {
              const g2 = mirrorCell(row.g1Count, row.g2Count);
              const g3 = mirrorCell(row.g1Count, row.g3Count);
              return (
                <label key={row.id}
                  className="grid grid-cols-[2rem_1fr_5.5rem_7rem_7rem] px-4 py-2 hover:bg-gray-800/40 cursor-pointer items-center">
                  <input type="checkbox" className="accent-blue-500"
                    checked={selected.has(row.name)} onChange={() => toggle(row.name)} />
                  <span className="text-sm text-gray-100 truncate pr-2">{row.name}</span>
                  <span className="text-right text-sm text-gray-400 tabular-nums">{row.g1Count.toLocaleString()}</span>
                  <span className={`text-right text-sm tabular-nums ${g2.cls}`}>{g2.icon} {g2.label}</span>
                  <span className={`text-right text-sm tabular-nums ${g3.cls}`}>{g3.icon} {g3.label}</span>
                </label>
              );
            })}
          </div>
        )}

        <div className="px-4 py-2 bg-gray-800/30 border-t border-gray-800 flex justify-between text-xs text-gray-600">
          <span>
            {selected.size > 0
              ? `${selected.size} folder${selected.size > 1 ? "s" : ""} selected · ${selEmails.toLocaleString()} msgs`
              : "No selection — all folders will be migrated"}
          </span>
          {selected.size > 0 && <span className="text-emerald-400 font-medium">~{bytesHuman(selBytes)} est.</span>}
        </div>
      </div>

      {/* Controls + Status */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Migration Controls */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Migration Controls</h2>

          <div className="grid grid-cols-3 gap-2">
            {[{
              label: "Strategy",
              el: <select value={strategy} onChange={e => setStrategy(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-100 focus:outline-none">
                <option value="size">Size</option>
                <option value="folder">Folder</option>
                <option value="random">Random</option></select>
            }, {
              label: "Max MB",
              el: <input type="number" value={sizeMb} min={0} onChange={e => setSizeMb(+e.target.value || 0)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-100 focus:outline-none" />
            }, {
              label: "Batch",
              el: <input type="number" value={batch} min={1} onChange={e => setBatch(+e.target.value || 10)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-100 focus:outline-none" />
            }].map(({ label, el }) => (
              <div key={label}><p className="text-xs text-gray-600 mb-1">{label}</p>{el}</div>
            ))}
          </div>

          <div>
            <p className="text-xs text-gray-600 mb-1.5">Alert every</p>
            <div className="flex items-center gap-2 text-sm">
              <input type="number" value={ntfyEmails} min={0} onChange={e => setNtfyEmails(+e.target.value || 0)}
                className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-100 focus:outline-none" />
              <span className="text-gray-600">emails,</span>
              <input type="number" value={ntfyMb} min={0} onChange={e => setNtfyMb(+e.target.value || 0)}
                className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-100 focus:outline-none" />
              <span className="text-gray-600">MB</span>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1 border-t border-gray-800">
            <label className="flex items-center gap-2 cursor-pointer">
              <button onClick={() => { setDryRun(v => !v); if (dryRun) setDelSrc(false); }}
                className={`relative w-9 h-5 rounded-full transition-colors ${dryRun ? "bg-amber-500" : "bg-gray-700"}`}>
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${dryRun ? "left-0.5" : "left-4"}`} />
              </button>
              <span className="text-sm text-gray-300">Dry run</span>
              {dryRun && <span className="text-xs text-amber-400">no writes</span>}
            </label>
            <button onClick={() => setAdv(v => !v)} className="text-xs text-gray-700 hover:text-gray-400">
              {adv ? "▲ less" : "▼ more"}
            </button>
          </div>

          {!dryRun && (
            <label className="flex items-center gap-2 text-sm cursor-pointer px-3 py-2 rounded-lg border border-red-900/40 bg-red-950/20">
              <input type="checkbox" checked={delSrc} onChange={e => setDelSrc(e.target.checked)} className="accent-red-500" />
              <span className="text-red-400">Delete from source after confirmed migration</span>
            </label>
          )}

          {adv && (
            <div className="pt-2 border-t border-gray-800 space-y-2">
              <div>
                <p className="text-xs text-gray-600 mb-1">Email limit (0 = ∞)</p>
                <input type="number" value={emailLim} min={0} onChange={e => setEmailLim(+e.target.value || 0)}
                  className="w-32 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-100 focus:outline-none" />
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={skipDedup} onChange={e => setSkipDedup(e.target.checked)} className="accent-blue-500" />
                <span className="text-gray-400">Skip dedup (faster first-run on empty dest)</span>
              </label>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={() => runMigration(true)} disabled={dispatching || !srcAcc || srcTokenInvalid}
              className="flex-1 py-2 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-sm font-semibold disabled:opacity-50"
              title={srcTokenInvalid ? "Source token invalid — re-authorize first" : undefined}>
              Dry Run
            </button>
            <button onClick={() => runMigration(false)}
              disabled={dispatching || !srcAcc || (!d1Acc && !d2Acc) || srcTokenInvalid}
              className="flex-[2] py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-50"
              title={srcTokenInvalid ? "Source token invalid — re-authorize first" : undefined}>
              {dispatching ? "Dispatching…" : "▶ Run Migration"}
            </button>
          </div>

          {result && (
            <div className={`px-3 py-2 rounded-lg text-sm ${
              result.ok ? "bg-emerald-900/30 border border-emerald-800 text-emerald-300"
                        : "bg-red-900/30 border border-red-800 text-red-300"
            }`}>
              {result.ok ? "✅ " : "❌ "}{result.msg}
              {result.ok && ghRepo && (
                <a href={`https://github.com/${ghRepo}/actions`} target="_blank" rel="noopener noreferrer"
                  className="ml-1 underline">Actions →</a>
              )}
            </div>
          )}
        </div>

        {/* Status Panel — per-destination, not rolled up */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Last Run Status</h2>
            {ghRepo && (
              <a href={`https://github.com/${ghRepo}/actions`} target="_blank" rel="noopener noreferrer"
                className="text-xs text-gray-700 hover:text-blue-400">View Actions →</a>
            )}
          </div>

          {loadingS && !status && <p className="text-sm text-gray-700">Loading…</p>}

          {(["dest1", "dest2"] as const).map((key, i) => {
            const s = status?.[key];
            const label = i === 0 ? (d1Acc || "dest1") : (d2Acc || "dest2");
            const pct = totalFolders > 0 && s ? Math.round((s.completed_folders / totalFolders) * 100) : 0;
            return (
              <div key={key} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-300 truncate max-w-[60%]">{label}</span>
                  {s
                    ? <span className={`text-xs font-semibold ${statusBadge(s.status)}`}>{s.status}</span>
                    : <span className="text-xs text-gray-700">no run data</span>
                  }
                </div>
                {s ? (
                  <>
                    <ProgressBar pct={pct} />
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500">
                      <span>{s.processed_emails.toLocaleString()} emails</span>
                      <span>{bytesHuman(s.processed_bytes)}</span>
                      <span>{s.completed_folders}/{totalFolders} folders</span>
                      {s.last_folder && <span>last: <span className="text-gray-400">{s.last_folder}</span></span>}
                      {s.errors_count > 0 && <span className="text-red-400">{s.errors_count} errors</span>}
                    </div>
                    {s.updated_at && (
                      <p className="text-xs text-gray-700">{new Date(s.updated_at).toLocaleString()}</p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-gray-700">No run data yet.</p>
                )}
              </div>
            );
          })}

          {(status?.dest1?.status === "running" || status?.dest2?.status === "running") && (
            <p className="text-xs text-blue-400">● Live — auto-refreshing every 20s</p>
          )}
        </div>
      </div>

      {/* Jobs Panel */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            GitHub Actions Jobs
            {jobs.some(j => j.status !== "completed") && (
              <span className="ml-2 text-blue-400">● Live</span>
            )}
          </h2>
          <button onClick={fetchJobs} disabled={loadingJ}
            className="text-xs text-gray-700 hover:text-gray-400 disabled:opacity-50">
            {loadingJ ? "…" : "↻ Refresh"}
          </button>
        </div>

        {jobs.length === 0 && !loadingJ && (
          <p className="text-sm text-gray-700">No recent runs found.</p>
        )}

        <div className="space-y-2">
          {jobs.slice(0, 8).map(job => {
            const isActive = job.status === "queued" || job.status === "in_progress";
            const statusColor =
              job.status === "in_progress" ? "text-blue-400" :
              job.status === "queued"      ? "text-amber-400" :
              job.conclusion === "success" ? "text-emerald-400" :
              job.conclusion === "failure" ? "text-red-400" :
              job.conclusion === "cancelled" ? "text-gray-500" : "text-gray-500";
            const statusLabel =
              job.status === "in_progress" ? "● running" :
              job.status === "queued"      ? "◌ queued" :
              job.conclusion ?? job.status;

            return (
              <div key={job.id} className="flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-800/30 px-3 py-2">
                <div className="flex-1 min-w-0">
                  <a href={job.html_url} target="_blank" rel="noopener noreferrer"
                    className="text-sm text-gray-200 hover:text-white truncate block">
                    {job.display_title}
                  </a>
                  <p className="text-xs text-gray-600">
                    {new Date(job.created_at).toLocaleString()}
                  </p>
                </div>
                <span className={`text-xs font-medium shrink-0 ${statusColor}`}>{statusLabel}</span>
                <div className="flex gap-1.5 shrink-0">
                  {isActive && (
                    <button onClick={() => doJobAction(job.id, "cancel")}
                      disabled={jobAction === job.id}
                      className="px-2 py-1 text-xs rounded border border-red-800/60 text-red-400 hover:bg-red-900/20 disabled:opacity-50">
                      Cancel
                    </button>
                  )}
                  {job.status === "completed" && job.conclusion === "failure" && (
                    <button onClick={() => doJobAction(job.id, "rerun")}
                      disabled={jobAction === job.id}
                      className="px-2 py-1 text-xs rounded border border-amber-800/60 text-amber-400 hover:bg-amber-900/20 disabled:opacity-50">
                      Re-run
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
