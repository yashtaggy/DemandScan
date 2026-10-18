"use client";

import { useState } from "react";
import { Header } from "@/components/header";
import { useAuth } from "@/hooks/use-auth";
import { useZones, type ZoneFilters } from "@/hooks/use-zones";
import { useScannerJob } from "@/hooks/use-scanner-job";
import { ScanProgress } from "@/components/scanner/ScanProgress";
import { ScannerControls } from "@/components/scanner/ScannerControls";
import { ZoneTable } from "@/components/scanner/ZoneTable";
import { ZoneDetailDrawer } from "@/components/scanner/ZoneDetailDrawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Zone } from "@/lib/scanner/types";

const PAGE_SIZE = 100;

export default function ScannerPage() {
  const { status: authStatus } = useAuth();
  const isAuthenticated = authStatus?.authenticated ?? false;

  // ── Filter / pagination state ────────────────────────────────────────────
  const [filters, setFilters] = useState<ZoneFilters>({ limit: PAGE_SIZE });
  const [page, setPage] = useState(1);

  const activeFilters: ZoneFilters = {
    ...filters,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  };

  // ── Data hooks ───────────────────────────────────────────────────────────
  const { zones, count, loading, error, refetch } = useZones(
    isAuthenticated ? activeFilters : {}
  );
  const { job, launching, launch, reset } = useScannerJob();

  const isRunning = job?.status === "RUNNING" || job?.status === "PENDING";
  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));

  // ── Drawer ───────────────────────────────────────────────────────────────
  const [selectedZone, setSelectedZone] = useState<Zone | null>(null);

  function handleFiltersChange(f: ZoneFilters) {
    setFilters(f);
    setPage(1);
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header lastRefreshed={null} />

      <main className="mx-auto max-w-screen-2xl px-4 sm:px-6 py-6 space-y-6">
        {/* ── Page heading ── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <span className="text-indigo-400">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              S/D Zone Scanner
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Nifty 500 · Multi-timeframe supply &amp; demand zone detection
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-600">
            {count > 0 && (
              <Badge variant="neutral" size="sm">{count} zones total</Badge>
            )}
            {job?.status === "SUCCESS" && (
              <Badge variant="success" size="sm">Last scan complete</Badge>
            )}
          </div>
        </div>

        {/* ── Not-authenticated banner ── */}
        {!isAuthenticated && authStatus !== null && (
          <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-6 text-center space-y-3">
            <p className="text-sm text-slate-400">Connect your Zerodha account to run the scanner.</p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => { window.location.href = "/api/kite/login"; }}
              id="scanner-connect-btn"
            >
              Connect with Zerodha
            </Button>
          </div>
        )}

        {/* ── Main layout ── */}
        {isAuthenticated && (
          <div className="flex gap-6 items-start">
            {/* ── Left sidebar: controls ── */}
            <aside className="w-72 shrink-0 space-y-4">
              <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-5 space-y-5">
                <div>
                  <h2 className="text-sm font-semibold text-slate-200">Scanner Controls</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Filters &amp; scan trigger</p>
                </div>

                <ScanProgress job={job} launching={launching} />

                {job?.status === "SUCCESS" && (
                  <button
                    onClick={reset}
                    className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    Clear status
                  </button>
                )}

                <ScannerControls
                  filters={filters}
                  onFiltersChange={handleFiltersChange}
                  onRunScan={() => launch()}
                  onRefreshZones={refetch}
                  isRunning={isRunning}
                  launching={launching}
                  isAuthenticated={isAuthenticated}
                />
              </div>

              {/* ── Stats card ── */}
              <StatsCard zones={zones} loading={loading} />
            </aside>

            {/* ── Right: zone table ── */}
            <div className="flex-1 min-w-0 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-200">
                  Detected Zones
                  {count > 0 && (
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {count} matching
                    </span>
                  )}
                </h2>
                {loading && (
                  <span className="text-xs text-slate-500 flex items-center gap-1.5">
                    <span className="scanner-spinner" /> Loading…
                  </span>
                )}
              </div>

              <ZoneTable
                zones={zones}
                loading={loading}
                error={error}
                onRetry={refetch}
                onSelect={setSelectedZone}
              />

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-slate-500">
                    Page {page} of {totalPages}
                  </span>
                  <div className="flex gap-1">
                    <PaginationBtn
                      disabled={page <= 1}
                      onClick={() => setPage((p) => p - 1)}
                      label="← Prev"
                    />
                    <PaginationBtn
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => p + 1)}
                      label="Next →"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Zone detail drawer — rendered at page level for full-height coverage */}
      <ZoneDetailDrawer zone={selectedZone} onClose={() => setSelectedZone(null)} />
    </div>
  );
}

// ── Mini stats card ────────────────────────────────────────────────────────────
function StatsCard({ zones, loading }: { zones: Zone[]; loading: boolean }) {
  if (loading || zones.length === 0) return null;

  const demand = zones.filter((z) => z.side === "DEMAND").length;
  const supply = zones.filter((z) => z.side === "SUPPLY").length;
  const fresh = zones.filter((z) => z.lifecycleState === "CONFIRMED_FRESH").length;
  const avgScore = Math.round(zones.reduce((s, z) => s + z.score, 0) / zones.length);

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-4 grid grid-cols-2 gap-3">
      <Stat label="Demand" value={demand} color="text-emerald-400" />
      <Stat label="Supply" value={supply} color="text-rose-400" />
      <Stat label="Fresh" value={fresh} color="text-indigo-400" />
      <Stat label="Avg Score" value={avgScore} color="text-amber-400" />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center">
      <p className={`text-lg font-bold tabular-nums ${color}`}>{value}</p>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  );
}

function PaginationBtn({ disabled, onClick, label }: { disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="px-3 py-1.5 text-xs rounded-md border border-slate-700/50 bg-slate-800/40 text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {label}
    </button>
  );
}
