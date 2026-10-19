"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Timeframe, ZoneSide } from "@/lib/scanner/types";
import type { ZoneFilters } from "@/hooks/use-zones";

interface ScannerControlsProps {
  filters: ZoneFilters;
  onFiltersChange: (f: ZoneFilters) => void;
  onRunScan: () => void;
  onRefreshZones: () => void;
  isRunning: boolean;
  launching: boolean;
  isAuthenticated: boolean;
}

const TIMEFRAMES: Array<Timeframe | "ALL"> = ["ALL", "1H", "4H", "1D", "1W", "1M", "3M", "6M", "1Y"];
const TF_LABELS: Record<string, string> = {
  ALL: "All", "1H": "1H", "4H": "4H", "1D": "1D", "1W": "1W", "1M": "1M", "3M": "3M", "6M": "6M", "1Y": "1Y",
};

const SIDES: Array<ZoneSide | "ALL"> = ["ALL", "DEMAND", "SUPPLY"];
const LIFECYCLES = ["ALL", "CONFIRMED_FRESH", "TOUCHED_ONCE", "RETESTED", "BROKEN"] as const;
const LIFECYCLE_LABELS: Record<string, string> = {
  ALL: "All", CONFIRMED_FRESH: "Fresh", TOUCHED_ONCE: "Tested", RETESTED: "Retested", BROKEN: "Broken",
};

const SORT_OPTIONS: Array<{ value: NonNullable<ZoneFilters["sort"]>; label: string }> = [
  { value: "composite_score", label: "Composite Score" },
  { value: "score",           label: "Formation Score" },
  { value: "distance_pct",    label: "Distance %" },
  { value: "formation_ts",    label: "Formation Date" },
];

export function ScannerControls({
  filters, onFiltersChange, onRunScan, onRefreshZones,
  isRunning, launching, isAuthenticated,
}: ScannerControlsProps) {
  const busy = isRunning || launching;
  const [showAdvanced, setShowAdvanced] = useState(false);

  function set(patch: Partial<ZoneFilters>) {
    onFiltersChange({ ...filters, ...patch, offset: 0 });
  }

  const activeTf        = filters.timeframe ?? "ALL";
  const activeSide      = filters.side      ?? "ALL";
  const activeLifecycle = filters.lifecycle ?? "ALL";

  return (
    <div className="space-y-4">
      {/* ── Run / Refresh ──────────────────────────────────────────────── */}
      <div className="flex gap-2">
        <Button id="run-scan-btn" variant="primary" size="sm"
          onClick={onRunScan} disabled={!isAuthenticated || busy} className="flex-1"
        >
          {busy ? (
            <span className="flex items-center gap-2">
              <span className="scanner-spinner" />
              {launching ? "Launching…" : "Scanning…"}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Run Full Scan
            </span>
          )}
        </Button>
        <button id="refresh-zones-btn" onClick={onRefreshZones} disabled={!isAuthenticated}
          title="Refresh zones"
          className="rounded-lg border border-slate-700/50 bg-slate-800/40 px-2.5 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      {/* ── Symbol search ──────────────────────────────────────────────── */}
      <FilterGroup label="Symbol">
        <input
          id="symbol-search"
          type="text"
          placeholder="e.g. RELIANCE"
          value={filters.symbol ?? ""}
          onChange={(e) => set({ symbol: e.target.value.toUpperCase() || undefined })}
          className="w-full rounded-md border border-slate-700/50 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
        />
      </FilterGroup>

      {/* ── Timeframe ─────────────────────────────────────────────────── */}
      <FilterGroup label="Timeframe">
        <div className="flex flex-wrap gap-1">
          {TIMEFRAMES.map((tf) => (
            <FilterChip key={tf} id={`tf-${tf}`} active={activeTf === tf}
              onClick={() => set({ timeframe: tf === "ALL" ? undefined : tf })}
            >
              {TF_LABELS[tf]}
            </FilterChip>
          ))}
        </div>
        {(activeTf === "1H" || activeTf === "4H") && (
          <p className="text-xs text-amber-500/70 mt-1">
            {activeTf === "1H" ? "1H: session candles (09:15–15:30 IST)" : "4H: AM session only (09:15–13:15 IST, complete bars)"}
          </p>
        )}
      </FilterGroup>

      {/* ── Zone type ─────────────────────────────────────────────────── */}
      <FilterGroup label="Zone Type">
        <div className="flex gap-1">
          {SIDES.map((s) => (
            <FilterChip key={s} id={`side-${s}`} active={activeSide === s}
              onClick={() => set({ side: s === "ALL" ? undefined : s })}
              colorClass={
                s === "DEMAND" ? "data-[active=true]:border-emerald-500/50 data-[active=true]:bg-emerald-500/15 data-[active=true]:text-emerald-300"
                  : s === "SUPPLY" ? "data-[active=true]:border-rose-500/50 data-[active=true]:bg-rose-500/15 data-[active=true]:text-rose-300"
                  : ""
              }
            >
              {s === "ALL" ? "Both" : s === "DEMAND" ? "Demand" : "Supply"}
            </FilterChip>
          ))}
        </div>
      </FilterGroup>

      {/* ── Lifecycle ─────────────────────────────────────────────────── */}
      <FilterGroup label="Zone Status">
        <div className="flex flex-wrap gap-1">
          {LIFECYCLES.map((lc) => (
            <FilterChip key={lc} id={`lc-${lc}`} active={activeLifecycle === lc}
              onClick={() => set({ lifecycle: lc === "ALL" ? undefined : lc })}
            >
              {LIFECYCLE_LABELS[lc]}
            </FilterChip>
          ))}
        </div>
      </FilterGroup>

      {/* ── Formation score ────────────────────────────────────────────── */}
      <FilterGroup label={`Formation Score ≥ ${filters.minScore ?? 0}`}>
        <input id="min-score-slider" type="range" min={0} max={100} step={5}
          value={filters.minScore ?? 0}
          onChange={(e) => set({ minScore: Number(e.target.value) || undefined })}
          className="w-full h-1.5 rounded-full accent-indigo-500 cursor-pointer"
        />
        <div className="flex justify-between text-xs text-slate-600 mt-0.5">
          <span>0</span><span>50</span><span>100</span>
        </div>
      </FilterGroup>

      {/* ── Composite score ────────────────────────────────────────────── */}
      <FilterGroup label={`Composite Score ≥ ${filters.minCompositeScore ?? 0}`}>
        <input id="min-composite-slider" type="range" min={0} max={100} step={5}
          value={filters.minCompositeScore ?? 0}
          onChange={(e) => set({ minCompositeScore: Number(e.target.value) || undefined })}
          className="w-full h-1.5 rounded-full accent-violet-500 cursor-pointer"
        />
        <div className="flex justify-between text-xs text-slate-600 mt-0.5">
          <span>0</span><span>50</span><span>100</span>
        </div>
      </FilterGroup>

      {/* ── Sort ─────────────────────────────────────────────────────── */}
      <FilterGroup label="Sort By">
        <select
          id="sort-select"
          value={filters.sort ?? "composite_score"}
          onChange={(e) => set({ sort: e.target.value as ZoneFilters["sort"] })}
          className="w-full rounded-md border border-slate-700/50 bg-slate-800/60 px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
        >
          {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div className="flex gap-1 mt-1.5">
          <FilterChip id="dir-desc" active={(filters.dir ?? "desc") === "desc"} onClick={() => set({ dir: "desc" })}>↓ Desc</FilterChip>
          <FilterChip id="dir-asc"  active={filters.dir === "asc"}              onClick={() => set({ dir: "asc" })}>↑ Asc</FilterChip>
        </div>
      </FilterGroup>

      {/* ── Advanced toggle ─────────────────────────────────────────── */}
      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="w-full text-left text-xs text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
      >
        <span className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}>▶</span>
        Advanced Filters
      </button>

      {showAdvanced && (
        <div className="space-y-4 border-t border-slate-700/40 pt-4">
          {/* Distance from price */}
          <FilterGroup label={`Max Distance from Price ≤ ${filters.maxDistancePct ?? 20}%`}>
            <input id="max-dist-slider" type="range" min={0} max={20} step={0.5}
              value={filters.maxDistancePct ?? 20}
              onChange={(e) => {
                const v = Number(e.target.value);
                set({ maxDistancePct: v >= 20 ? undefined : v });
              }}
              className="w-full h-1.5 rounded-full accent-amber-500 cursor-pointer"
            />
            <div className="flex justify-between text-xs text-slate-600 mt-0.5">
              <span>0%</span><span>10%</span><span>20%</span>
            </div>
          </FilterGroup>

          {/* Confluence */}
          <FilterGroup label={`Min Confluence ≥ ${filters.minConfluence ?? 0}`}>
            <input id="min-conf-slider" type="range" min={0} max={100} step={5}
              value={filters.minConfluence ?? 0}
              onChange={(e) => set({ minConfluence: Number(e.target.value) || undefined })}
              className="w-full h-1.5 rounded-full accent-cyan-500 cursor-pointer"
            />
          </FilterGroup>

          {/* Opposition risk */}
          <FilterGroup label={`Max Opposition Risk ≤ ${filters.maxOppositionRisk ?? 100}`}>
            <input id="max-opp-slider" type="range" min={0} max={100} step={5}
              value={filters.maxOppositionRisk ?? 100}
              onChange={(e) => {
                const v = Number(e.target.value);
                set({ maxOppositionRisk: v >= 100 ? undefined : v });
              }}
              className="w-full h-1.5 rounded-full accent-rose-500 cursor-pointer"
            />
          </FilterGroup>

          {/* Formation date range */}
          <FilterGroup label="Formation Date Range">
            <div className="flex gap-2">
              <input id="formation-from" type="date"
                value={filters.formationFrom ?? ""}
                onChange={(e) => set({ formationFrom: e.target.value || undefined })}
                className="flex-1 rounded-md border border-slate-700/50 bg-slate-800/60 px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
              />
              <span className="text-xs text-slate-500 self-center">to</span>
              <input id="formation-to" type="date"
                value={filters.formationTo ?? ""}
                onChange={(e) => set({ formationTo: e.target.value || undefined })}
                className="flex-1 rounded-md border border-slate-700/50 bg-slate-800/60 px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
              />
            </div>
          </FilterGroup>

          {/* Reset advanced */}
          <button
            onClick={() => set({
              maxDistancePct: undefined, minConfluence: undefined,
              maxOppositionRisk: undefined, formationFrom: undefined, formationTo: undefined,
            })}
            className="text-xs text-slate-600 hover:text-slate-400 transition-colors"
          >
            Reset advanced filters
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Shared subcomponents ──────────────────────────────────────────────────────

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{label}</p>
      {children}
    </div>
  );
}

function FilterChip({
  id, active, onClick, children, colorClass = "",
}: {
  id: string; active: boolean; onClick: () => void;
  children: React.ReactNode; colorClass?: string;
}) {
  const base = "px-2.5 py-1 text-xs rounded-md border transition-all duration-150 cursor-pointer";
  const inactive = "border-slate-700/50 bg-slate-800/40 text-slate-500 hover:text-slate-300 hover:border-slate-600/60";
  const activeDefault = "border-indigo-500/50 bg-indigo-500/15 text-indigo-300";
  return (
    <button id={id} data-active={active} onClick={onClick}
      className={`${base} ${active ? (colorClass || activeDefault) : inactive} ${colorClass}`}
    >
      {children}
    </button>
  );
}
