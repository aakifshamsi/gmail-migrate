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

function bytesHuman(n: number): string {
  if (!n) return "0 B";
  const units = ["B","KB","MB","GB","TB"];
  let v = n;
  for (const u of units) { if (v < 1024) return `${v.toFixed(1)} ${u}`; v /= 1024; }
  return `${v.toFixed(1)} PB`;
}

function mirrorCell(g1: number, gn: number) {
  if (g1 === 0) return { icon: "\u2B1C", label: "\u2014", cls: "text-gray-700" };
  if (gn >= g1)  return { icon: "\u2705", label: gn.toLocaleString(), cls: "text-emerald-400" };
  if (gn > 0) {
    const pct = Math.round((gn / g1) * 100);
    return { icon: "\uD83D\uDD04", label: `${pct}%`, cls: "text-amber-400" };
  }
  return { icon: "\u2B1C", label: "\u2014", cls: "text-gray-600" };
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

export default function Home() {
  const [data, setData] = useState<FoldersData | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loadingF, setLoadingF] = useState(true);
  const [loadingS, setLoadingS] = useState(true);
  const [errF, setErrF] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dispatching, setDispatching] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // controls
  const [destG2, setDestG2] = useState(true);
  const [destG3, setDestG3] = useState(true);
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

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchFolders = useCallback(async () => {
    setLoadingF(true); setErrF(null);
    try {
      const r = await fetch("/api/folders");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
    } catch (e) { setErrF(e instanceof Error ? e.message : String(e)); }
    finally { setLoadingF(false); }
  }, []);

  const fetchStatus = useCallback(async () => {
    setLoadingS(true);
    try {
      const r = await fetch("/api/status");
      if (r.ok) setStatus(await r.json());
    } catch { /* silent */ }
    finally { setLoadingS(false); }
  }, []);

  useEffect(() => { fetchFolders(); fetchStatus(); }, [fetchFolders, fetchStatus]);

  // auto-refresh status while a run is active
  useEffect(() => {
    const running = status?.dest1?.status === "running" || status?.dest2?.status === "running";
    if (running && !pollRef.current) pollRef.current = setInterval(fetchStatus, 30_000);
    if (!running && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status, fetchStatus]);

  const rows = data?.rows ?? [];
  const totalFolders = rows.length;
  const toggle = (n: string) => setSelected(p => { const s = new Set(p); s.has(n) ? s.delete(n) : s.add(n); return s; });
  const toggleAll = () => setSelected(selected.size === rows.length ? new Set() : new Set(rows.map(r => r.name)));

  const selRows = rows.filter(r => selected.has(r.name));
  const selEmails = selRows.reduce((a, r) => a + r.g1Count, 0);
  const selBytes  = selRows.reduce((a, r) => a + r.estimatedBytes, 0);
  const destination = destG2 && destG3 ? "both" : destG2 ? "dest1" : "dest2";

  const runMigration = async (dry: boolean) => {
    if (!destG2 && !destG3) { setResult({ ok: false, msg: "Select at least one destination." }); return; }
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
      setTimeout(fetchStatus, 6_000);
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally { setDispatching(false); }
  };

  const srcLabel = process.env.NEXT_PUBLIC_SOURCE_LABEL ?? "G1";
  const d1Label  = process.env.NEXT_PUBLIC_DEST1_LABEL  ?? "G2";
  const d2Label  = process.env.NEXT_PUBLIC_DEST2_LABEL  ?? "G3";
  const ghRepo   = process.env.NEXT_PUBLIC_GITHUB_REPO  ?? "";

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Gmail Migration Dashboard</h1>
          <p className="text-xs text-gray-600 mt-0.5">
            {data?.sourceUser ?? "\u2014"} \u2192 {data?.dest1User ?? "?"} + {data?.dest2User ?? "?"}
          </p>
        </div>
        <button onClick={() => { fetchFolders(); fetchStatus(); }} disabled={loadingF}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg disabled:opacity-50">
          {loadingF ? "\u2026" : "\u21BB Refresh"}
        </button>
      </div>

      {/* Folder comparison table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="grid grid-cols-[2rem_1fr_5.5rem_7rem_7rem] px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide border-b border-gray-800">
          <input type="checkbox" className="accent-blue-500"
            checked={selected.size === rows.length && rows.length > 0} onChange={toggleAll} />
          <span>Folder</span>
          <span className="text-right">{srcLabel}</span>
          <span className="text-right">{d1Label} Mirror</span>
          <span className="text-right">{d2Label} Mirror</span>
        </div>

        {loadingF && <p className="px-4 py-10 text-center text-sm text-gray-600">Fetching folders\u2026</p>}
        {errF && (
          <div className="px-4 py-6 text-center">
            <p className="text-red-400 text-sm font-mono">{errF}</p>
            <button onClick={fetchFolders} className="mt-2 text-xs text-gray-500 hover:text-white underline">Retry</button>
          </div>
        )}
        {!loadingF && !errF && rows.length === 0 && (
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
              ? `${selected.size} folder${selected.size > 1 ? "s" : ""} selected \u00b7 ${selEmails.toLocaleString()} msgs`
              : "No selection \u2014 all folders will be migrated"}
          </span>
          {selected.size > 0 && <span className="text-emerald-400 font-medium">~{bytesHuman(selBytes)} est. recovery</span>}
        </div>
        <p className="px-4 py-1 text-xs text-gray-700 border-t border-gray-800/40">Size estimates based on 75 KB/message average.</p>
      </div>

      {/* Controls + Status */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Migration Controls */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Migration Controls</h2>

          {/* Destination */}
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Destination</p>
            <div className="flex gap-5">
              {[{ label: d1Label + " (dest1)", val: destG2, set: setDestG2 },
                { label: d2Label + " (dest2)", val: destG3, set: setDestG3 }].map(d => (
                <label key={d.label} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={d.val} onChange={e => d.set(e.target.checked)} className="accent-blue-500" />
                  <span className={d.val ? "text-white" : "text-gray-600"}>{d.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Strategy / Size / Batch */}
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

          {/* ntfy milestones */}
          <div>
            <p className="text-xs text-gray-600 mb-1.5">Alert every</p>
            <div className="flex items-center gap-2 text-sm">
              <input type="number" value={ntfyEmails} min={0} onChange={e => setNtfyEmails(+e.target.value || 0)}
                className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-100 focus:outline-none" />
              <span className="text-gray-600">emails,</span>
              <input type="number" value={ntfyMb} min={0} onChange={e => setNtfyMb(+e.target.value || 0)}
                className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-100 focus:outline-none" />
              <span className="text-gray-600">MB freed</span>
            </div>
          </div>

          {/* Dry run */}
          <div className="flex items-center justify-between pt-1 border-t border-gray-800">
            <label className="flex items-center gap-2 cursor-pointer">
              <button onClick={() => setDryRun(v => !v)}
                className={`relative w-9 h-5 rounded-full transition-colors ${dryRun ? "bg-amber-500" : "bg-gray-700"}`}>
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${dryRun ? "left-0.5" : "left-4"}`} />
              </button>
              <span className="text-sm text-gray-300">Dry run</span>
              {dryRun && <span className="text-xs text-amber-400">no writes</span>}
            </label>
            <button onClick={() => setAdv(v => !v)} className="text-xs text-gray-700 hover:text-gray-400">
              {adv ? "\u25b2 less" : "\u25bc more"}
            </button>
          </div>

          {adv && (
            <div className="pt-2 border-t border-gray-800 space-y-2">
              <div>
                <p className="text-xs text-gray-600 mb-1">Email limit (0 = \u221e)</p>
                <input type="number" value={emailLim} min={0} onChange={e => setEmailLim(+e.target.value || 0)}
                  className="w-32 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-gray-100 focus:outline-none" />
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={skipDedup} onChange={e => setSkipDedup(e.target.checked)} className="accent-blue-500" />
                <span className="text-gray-400">Skip dedup (faster first-run)</span>
              </label>
              {!dryRun && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={delSrc} onChange={e => setDelSrc(e.target.checked)} className="accent-red-500" />
                  <span className="text-red-400">Delete from source after migration</span>
                </label>
              )}
            </div>
          )}

          {/* Buttons */}
          <div className="flex gap-2 pt-1">
            <button onClick={() => runMigration(true)} disabled={dispatching}
              className="flex-1 py-2 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-sm font-semibold disabled:opacity-50">
              Dry Run
            </button>
            <button onClick={() => runMigration(false)} disabled={dispatching || (!destG2 && !destG3)}
              className="flex-[2] py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-50">
              {dispatching ? "Dispatching\u2026" : "\u25B6 Run Migration"}
            </button>
          </div>

          {result && (
            <div className={`px-3 py-2 rounded-lg text-sm ${
              result.ok ? "bg-emerald-900/30 border border-emerald-800 text-emerald-300"
                        : "bg-red-900/30 border border-red-800 text-red-300"
            }`}>
              {result.ok ? "\u2705 " : "\u274C "}{result.msg}
              {result.ok && ghRepo && (
                <a href={`https://github.com/${ghRepo}/actions`} target="_blank" rel="noopener noreferrer"
                  className="ml-1 underline">Actions \u2192</a>
              )}
            </div>
          )}
        </div>

        {/* Status Panel */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Last Run Status</h2>
            {ghRepo && (
              <a href={`https://github.com/${ghRepo}/actions`} target="_blank" rel="noopener noreferrer"
                className="text-xs text-gray-700 hover:text-blue-400">View Actions \u2192</a>
            )}
          </div>

          {loadingS && !status && <p className="text-sm text-gray-700">Loading\u2026</p>}

          {(["dest1", "dest2"] as const).map((key, i) => {
            const s = status?.[key];
            const label = i === 0 ? d1Label : d2Label;
            const pct = totalFolders > 0 && s ? Math.round((s.completed_folders / totalFolders) * 100) : 0;
            return (
              <div key={key} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-300">{label} <span className="text-gray-600 text-xs">({key})</span></span>
                  {s && <span className={`text-xs font-semibold ${statusBadge(s.status)}`}>{s.status}</span>}
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
            <p className="text-xs text-blue-400">\u25CF Live \u2014 auto-refreshing every 30s</p>
          )}
        </div>
      </div>
    </div>
  );
}
