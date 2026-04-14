'use client';

import { useState, useCallback } from 'react';

type IdlVersion = {
  type: 'pmp' | 'anchor';
  version: string | null;
  slot: string;
  time: string | null;
  activeFrom: { slot: string; time: string | null };
  activeTo: { slot: string; time: string | null } | 'current';
  content: string;
};

type HistoryResponse = {
  programId: string;
  pmpAddress: string;
  anchorAddress: string;
  pmp: IdlVersion[];
  anchor: IdlVersion[];
  error?: string;
};

function downloadJson(content: string, filename: string) {
  let formatted: string;
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    formatted = content;
  }
  const blob = new Blob([formatted], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ActiveRange({ v }: { v: IdlVersion }) {
  const to = v.activeTo === 'current' ? 'current' : `slot ${v.activeTo.slot}`;
  const toTime = v.activeTo !== 'current' ? v.activeTo.time : null;
  return (
    <span className="text-zinc-400 text-sm">
      slot {v.activeFrom.slot}
      {v.activeFrom.time && <span className="text-zinc-500"> ({v.activeFrom.time})</span>}
      <span className="mx-1.5 text-zinc-600">&rarr;</span>
      {v.activeTo === 'current' ? (
        <span className="text-emerald-400">current</span>
      ) : (
        <>
          {to}
          {toTime && <span className="text-zinc-500"> ({toTime})</span>}
        </>
      )}
    </span>
  );
}

function IdlTable({ versions, type }: { versions: IdlVersion[]; type: string }) {
  if (versions.length === 0) {
    return (
      <p className="text-zinc-500 text-sm italic">No {type} IDL found for this program.</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-400 text-left">
            <th className="py-2 pr-4 font-medium">#</th>
            <th className="py-2 pr-4 font-medium">Version</th>
            <th className="py-2 pr-4 font-medium">Active range</th>
            <th className="py-2 font-medium text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v, i) => (
            <tr key={v.slot} className="border-b border-zinc-800/50 hover:bg-zinc-900/50 transition-colors">
              <td className="py-3 pr-4 text-zinc-500 tabular-nums">{i + 1}</td>
              <td className="py-3 pr-4">
                <span className="font-mono text-amber-400">
                  {v.version ? `v${v.version}` : '(no version)'}
                </span>
              </td>
              <td className="py-3 pr-4">
                <ActiveRange v={v} />
              </td>
              <td className="py-3 text-right">
                <button
                  onClick={() => {
                    const suffix = v.version ? `_v${v.version}` : '';
                    downloadJson(v.content, `${v.slot}${suffix}.json`);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded-md text-zinc-200 text-xs font-medium transition-colors cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Download
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Home() {
  const [programId, setProgramId] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async () => {
    const id = programId.trim();
    if (!id) return;

    setLoading(true);
    setError(null);
    setData(null);

    try {
      const res = await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ programId: id }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
      } else {
        setData(json);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }, [programId]);

  const totalIdls = data ? data.pmp.length + data.anchor.length : 0;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">IDL History Explorer</h1>
          <span className="text-xs text-zinc-500 border border-zinc-800 rounded px-1.5 py-0.5">Solana</span>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-10">
        <div className="mb-10">
          <p className="text-zinc-400 mb-6 text-sm leading-relaxed max-w-xl">
            Enter a Solana program address to reconstruct its on-chain IDL history.
            Supports both Program Metadata (PMP) and Anchor IDL formats.
          </p>

          <div className="flex gap-3">
            <input
              type="text"
              value={programId}
              onChange={(e) => setProgramId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !loading && search()}
              placeholder="Program address, e.g. TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
              className="flex-1 px-4 py-2.5 bg-zinc-900 border border-zinc-800 rounded-lg text-sm font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600 transition-colors"
            />
            <button
              onClick={search}
              disabled={loading || !programId.trim()}
              className="px-6 py-2.5 bg-white text-zinc-900 rounded-lg text-sm font-semibold hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
                    <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  Scanning...
                </span>
              ) : (
                'Search'
              )}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-8 px-4 py-3 bg-red-950/50 border border-red-900/50 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        {loading && (
          <div className="text-center py-20">
            <svg className="w-8 h-8 animate-spin mx-auto mb-4 text-zinc-500" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
              <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            <p className="text-zinc-500 text-sm">Reconstructing IDL history from on-chain transactions...</p>
            <p className="text-zinc-600 text-xs mt-1">This may take a moment</p>
          </div>
        )}

        {data && !loading && (
          <div className="space-y-10">
            <div className="flex items-baseline gap-3 mb-2">
              <p className="text-zinc-400 text-sm">
                Found <span className="text-white font-medium">{totalIdls}</span> distinct IDL version{totalIdls !== 1 ? 's' : ''} for
              </p>
              <code className="text-xs font-mono text-zinc-500 bg-zinc-900 px-2 py-1 rounded">
                {data.programId}
              </code>
            </div>

            <section>
              <div className="flex items-center gap-3 mb-4">
                <h2 className="text-base font-semibold">Anchor IDL</h2>
                <span className="text-xs text-zinc-500 bg-zinc-900 px-2 py-0.5 rounded font-mono">
                  {data.anchorAddress.slice(0, 8)}...
                </span>
                {data.anchor.length > 0 && (
                  <span className="text-xs text-emerald-500 bg-emerald-950/50 px-2 py-0.5 rounded">
                    {data.anchor.length} version{data.anchor.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <IdlTable versions={data.anchor} type="Anchor" />
            </section>

            <section>
              <div className="flex items-center gap-3 mb-4">
                <h2 className="text-base font-semibold">Program Metadata (PMP)</h2>
                <span className="text-xs text-zinc-500 bg-zinc-900 px-2 py-0.5 rounded font-mono">
                  {data.pmpAddress.slice(0, 8)}...
                </span>
                {data.pmp.length > 0 && (
                  <span className="text-xs text-emerald-500 bg-emerald-950/50 px-2 py-0.5 rounded">
                    {data.pmp.length} version{data.pmp.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <IdlTable versions={data.pmp} type="PMP" />
            </section>
          </div>
        )}
      </main>

      <footer className="border-t border-zinc-800 py-4 text-center text-zinc-600 text-xs">
        historical-idl &middot; Reconstructs IDL history from on-chain Solana transactions
      </footer>
    </div>
  );
}
