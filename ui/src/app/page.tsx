"use client";

import { useCallback, useEffect, useState } from "react";

interface Folder {
  id: string;
  name: string;
  type: string;
  messagesTotal: number;
  estimatedBytes: number;
}

interface TriggerPayload {
  strategy: string;
  sizeLimitMb: number;
  emailLimit: number;
  folder: string;
  destination: string;
  dryRun: boolean;
  skipDedup: boolean;
  batchSize: number;
  migrationFolders: string;
  deleteFromSource: boolean;
}

function bytesHuman(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = n;
  for (const u of units) {
    if (val < 1024) return `${val.toFixed(1)} ${u}`;
    val /= 1024;
  }
  return `${val.toFixed(1)} PB`;
}

function FolderIcon({ name }: { name: string }) {
  if (name === "INBOX") return <span title="Inbox">📥</span>;
  if (name === "SENT") return <span title="Sent">📤</span>;
  if (name === "STARRED") return <span title="Starred">⭐</span>;
  if (name === "IMPORTANT") return <span title="Important">🔖</span>;
  return <span title="Label">🏷️</span>;
}

export default function Home() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dispatching, setDispatching] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Migration options
  const [strategy, setStrategy] = useState("size");
  const [destination, setDestination] = useState("both");
  const [sizeLimitMb, setSizeLimitMb] = useState(500);
  const [emailLimit, setEmailLimit] = useState(0);
  const [batchSize, setBatchSize] = useState(10);
  const [dryRun, setDryRun] = useState(true);
  const [skipDedup, setSkipDedup] = useState(false);
  const [deleteFromSource, setDeleteFromSource] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fetchFolders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/folders");
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      const data: Folder[] = await res.json();
      setFolders(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchFolders(); }, [fetchFolders]);

  const toggleFolder = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === folders.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(folders.map(f => f.name)));
    }
  };

  const selectedFolders = folders.filter(f => selected.has(f.name));
  const selectedEmails = selectedFolders.reduce((s, f) => s + f.messagesTotal, 0);
  const selectedBytes = selectedFolders.reduce((s, f) => s + f.estimatedBytes, 0);

  const runMigration = async (dry: boolean) => {
    if (!dry && !confirm(
      `⚠️ This will copy ${selectedEmails > 0 ? selectedEmails.toLocaleString() + " emails" : "all emails"} to ${destination}.\n\nProceed?`
    )) return;

    setDispatching(true);
    setResult(null);

    const payload: TriggerPayload = {
      strategy,
      sizeLimitMb,
      emailLimit,
      folder: strategy === "folder" ? (selectedFolders[0]?.name || "INBOX") : "INBOX",
      destination,
      dryRun: dry,
      skipDedup,
      batchSize,
      migrationFolders: selected.size > 0 ? Array.from(selected).join(",") : "",
      deleteFromSource: !dry && deleteFromSource,
    };

    try {
      const res = await fetch("/api/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      setResult({ ok: true, msg: "Workflow dispatched! Check GitHub Actions for progress." });
    } catch (e: unknown) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setDispatching(false);
    }
  };

  const totalEmails = folders.reduce((s, f) => s + f.messagesTotal, 0);
  const totalBytes = folders.reduce((s, f) => s + f.estimatedBytes, 0);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Gmail Migrate</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {process.env.NEXT_PUBLIC_SOURCE_LABEL || "Source account"} → free up storage
          </p>
        </div>
        <button
          onClick={fetchFolders}
          disabled={loading}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded-lg border border-gray-700 disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>

      {/* Folder Panel */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="font-semibold text-sm text-gray-300 uppercase tracking-wide">
            Source Folders
          </h2>
          {!loading && !error && (
            <span className="text-xs text-gray-500">
              {folders.length} folders · {totalEmails.toLocaleString()} emails · ~{bytesHuman(totalBytes)}
            </span>
          )}
        </div>

        {loading && (
          <div className="px-4 py-10 text-center text-gray-500 text-sm">
            Fetching folders from Gmail…
          </div>
        )}

        {error && (
          <div className="px-4 py-6 text-center">
            <p className="text-red-400 text-sm">{error}</p>
            <button
              onClick={fetchFolders}
              className="mt-3 text-xs text-gray-400 hover:text-white underline"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && folders.length === 0 && (
          <div className="px-4 py-10 text-center text-gray-500 text-sm">
            No folders found.
          </div>
        )}

        {!loading && !error && folders.length > 0 && (
          <>
            {/* Table header */}
            <div className="grid grid-cols-[2rem_1fr_6rem_7rem] gap-2 px-4 py-2 text-xs font-medium text-gray-500 border-b border-gray-800/60">
              <div>
                <input
                  type="checkbox"
                  checked={selected.size === folders.length}
                  onChange={toggleAll}
                  className="accent-blue-500"
                />
              </div>
              <div>Folder</div>
              <div className="text-right">Messages</div>
              <div className="text-right">Est. size</div>
            </div>

            {/* Folder rows */}
            <div className="divide-y divide-gray-800/50 max-h-[420px] overflow-y-auto">
              {folders.map(f => (
                <label
                  key={f.id}
                  className="grid grid-cols-[2rem_1fr_6rem_7rem] gap-2 px-4 py-2.5 hover:bg-gray-800/50 cursor-pointer items-center group"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(f.name)}
                    onChange={() => toggleFolder(f.name)}
                    className="accent-blue-500"
                  />
                  <div className="flex items-center gap-2 min-w-0">
                    <FolderIcon name={f.name} />
                    <span className="text-sm truncate text-gray-100 group-hover:text-white">
                      {f.name}
                    </span>
                    {f.type === "system" && (
                      <span className="text-xs text-gray-600 shrink-0">(system)</span>
                    )}
                  </div>
                  <div className="text-right text-sm text-gray-400 tabular-nums">
                    {f.messagesTotal.toLocaleString()}
                  </div>
                  <div className="text-right text-sm text-gray-400 tabular-nums">
                    {bytesHuman(f.estimatedBytes)}
                  </div>
                </label>
              ))}
            </div>

            {/* Selection footer */}
            <div className="px-4 py-2.5 bg-gray-800/40 border-t border-gray-800 text-xs text-gray-400 flex items-center justify-between">
              <span>
                {selected.size > 0
                  ? `${selected.size} folder${selected.size > 1 ? "s" : ""} selected · ${selectedEmails.toLocaleString()} messages`
                  : "No folders selected — all will be migrated"}
              </span>
              {selected.size > 0 && (
                <span className="font-medium text-emerald-400">
                  ~{bytesHuman(selectedBytes)} estimated recovery
                </span>
              )}
            </div>
            <p className="px-4 py-1.5 text-xs text-gray-600 border-t border-gray-800/40">
              Size estimates based on 75 KB/message average. Actual may vary.
            </p>
          </>
        )}
      </div>

      {/* Migration Options */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 space-y-4">
        <h2 className="font-semibold text-sm text-gray-300 uppercase tracking-wide">
          Migration Options
        </h2>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {/* Destination */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Destination</label>
            <select
              value={destination}
              onChange={e => setDestination(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
            >
              <option value="both">Both (dest1 + dest2)</option>
              <option value="dest1">dest1 only</option>
              <option value="dest2">dest2 only</option>
            </select>
          </div>

          {/* Strategy */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Strategy</label>
            <select
              value={strategy}
              onChange={e => setStrategy(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
            >
              <option value="size">Size (largest first)</option>
              <option value="folder">Single folder</option>
              <option value="random">Random sample</option>
            </select>
          </div>

          {/* Size limit */}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Max size (MB)</label>
            <input
              type="number"
              value={sizeLimitMb}
              onChange={e => setSizeLimitMb(parseInt(e.target.value) || 0)}
              min={0}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              placeholder="0 = unlimited"
            />
          </div>
        </div>

        {/* Dry run toggle */}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <div
              onClick={() => setDryRun(v => !v)}
              className={`relative w-10 h-5 rounded-full transition-colors ${dryRun ? "bg-amber-500" : "bg-gray-700"}`}
            >
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${dryRun ? "left-0.5" : "left-5"}`} />
            </div>
            <span className="text-sm text-gray-300">Dry run</span>
          </label>
          {dryRun && (
            <span className="text-xs text-amber-400 bg-amber-900/30 px-2 py-0.5 rounded">
              Report only — nothing will be written
            </span>
          )}
        </div>

        {/* Advanced options */}
        <div>
          <button
            onClick={() => setShowAdvanced(v => !v)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            {showAdvanced ? "▲ Hide" : "▼ Show"} advanced options
          </button>

          {showAdvanced && (
            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 pt-3 border-t border-gray-800">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Email limit (0 = ∞)</label>
                <input
                  type="number"
                  value={emailLimit}
                  onChange={e => setEmailLimit(parseInt(e.target.value) || 0)}
                  min={0}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Batch size</label>
                <input
                  type="number"
                  value={batchSize}
                  onChange={e => setBatchSize(parseInt(e.target.value) || 10)}
                  min={1}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 cursor-pointer select-none mt-1">
                  <input
                    type="checkbox"
                    checked={skipDedup}
                    onChange={e => setSkipDedup(e.target.checked)}
                    className="accent-blue-500"
                  />
                  <span className="text-sm text-gray-300">Skip dedup</span>
                </label>

                {!dryRun && (
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={deleteFromSource}
                      onChange={e => setDeleteFromSource(e.target.checked)}
                      className="accent-red-500"
                    />
                    <span className="text-sm text-red-400">Delete from source after migration</span>
                  </label>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3">
        <button
          onClick={() => runMigration(true)}
          disabled={dispatching || loading}
          className="flex-1 py-3 rounded-xl border border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 font-semibold text-sm transition-colors disabled:opacity-50"
        >
          {dispatching && dryRun ? "Dispatching…" : "Dry Run"}
        </button>
        <button
          onClick={() => runMigration(false)}
          disabled={dispatching || loading}
          className="flex-[2] py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm transition-colors disabled:opacity-50"
        >
          {dispatching && !dryRun ? "Dispatching…" : "Run Migration →"}
        </button>
      </div>

      {/* Result */}
      {result && (
        <div
          className={`px-4 py-3 rounded-xl text-sm font-medium ${
            result.ok
              ? "bg-emerald-900/40 border border-emerald-700 text-emerald-300"
              : "bg-red-900/40 border border-red-700 text-red-300"
          }`}
        >
          {result.ok ? "✅ " : "❌ "}
          {result.msg}
          {result.ok && (
            <>
              {" "}
              <a
                href={`https://github.com/${process.env.NEXT_PUBLIC_GITHUB_REPO || ""}/actions`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                View Actions
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
