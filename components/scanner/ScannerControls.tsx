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

const TIMEFRAMES: Array<Timeframe | "ALL"> = ["ALL", "1D", "1W", "1M", "3M", "6M", "1Y"];
const SIDES: Array<ZoneSide | "ALL"> = ["ALL", "DEMAND", "SUPPLY"];
const LIFECYCLES = ["ALL", "CONFIRMED_FRESH", "TOUCHED_ONCE", "RETESTED", "BROKEN"] as const;
const LIFECYCLE_LABELS: Record<string, string> = {
  ALL: "All",
  CONFIRMED_FRESH: "Fresh",
  TOUCHED_ONCE: "Tested",
  RETESTED: "Retested",
  BROKEN: "Broken",
};

export function ScannerControls({
  filters,
  onFiltersChange,
  onRunScan,
  onRefreshZones,
  isRunning,
  launching,
  isAuthenticated,
}: ScannerControlsProps) {
  const busy = isRunning || launching;

  function setTf(tf: Timeframe | "ALL") {
    onFiltersChange({ ...filters, timeframe: tf === "ALL" ? undefined : tf, offset: 0 });
  }
  function setSide(s: ZoneSide | "ALL") {
    onFiltersChange({ ...filters, side: s === "ALL" ? undefined : s, offset: 0 });
  }
  function setLifecycle(l: string) {
    onFiltersChange({ ...filters, lifecycle: l === "ALL" ? undefined : l, offset: 0 });
  }
  function setMinScore(v: number) {
    onFiltersChange({ ...filters, minScore: v || undefined, offset: 0 });
  }

  const activeTf = filters.timeframe ?? "ALL";
  const activeSide = filters.side ?? "ALL";
  const activeLifecycle = filters.lifecycle ?? "ALL";

  return (
    <div className="space-y-4">
      {/* ── Run scan ── */}
      <div className="flex gap-2">
        <Button
          id="run-scan-btn"
          variant="primary"
          size="sm"
          onClick={onRunScan}
          disabled={!isAuthenticated || busy}
          className="flex-1"
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

        <button
          id="refresh-zones-btn"
          onClick={onRefreshZones}
          disabled={!isAuthenticated}
          title="Refresh zones"
          className="rounded-lg border border-slate-700/50 bg-slate-800/40 px-2.5 py-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-700/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      {/* ── Timeframe ── */}
      <FilterGroup label="Timeframe">
        <div className="flex flex-wrap gap-1">
          {TIMEFRAMES.map((tf) => (
            <FilterChip
              key={tf}
              id={`tf-${tf}`}
              active={activeTf === tf}
              onClick={() => setTf(tf)}
            >
              {tf}
            </FilterChip>
          ))}
        </div>
      </FilterGroup>

      {/* ── Zone side ── */}
      <FilterGroup label="Zone Type">
        <div className="flex gap-1">
          {SIDES.map((s) => (
            <FilterChip
              key={s}
              id={`side-${s}`}
              active={activeSide === s}
              onClick={() => setSide(s)}
              colorClass={
                s === "DEMAND"
                  ? "data-[active=true]:border-emerald-500/50 data-[active=true]:bg-emerald-500/15 data-[active=true]:text-emerald-300"
                  : s === "SUPPLY"
                  ? "data-[active=true]:border-rose-500/50 data-[active=true]:bg-rose-500/15 data-[active=true]:text-rose-300"
                  : ""
              }
            >
              {s === "ALL" ? "Both" : s === "DEMAND" ? "Demand" : "Supply"}
            </FilterChip>
          ))}
        </div>
      </FilterGroup>

      {/* ── Lifecycle ── */}
      <FilterGroup label="Zone Status">
        <div className="flex flex-wrap gap-1">
          {LIFECYCLES.map((lc) => (
            <FilterChip
              key={lc}
              id={`lc-${lc}`}
              active={activeLifecycle === lc}
              onClick={() => setLifecycle(lc)}
            >
              {LIFECYCLE_LABELS[lc]}
            </FilterChip>
          ))}
        </div>
      </FilterGroup>

      {/* ── Min Score ── */}
      <FilterGroup label={`Min Score — ${filters.minScore ?? 0}`}>
        <input
          id="min-score-slider"
          type="range"
          min={0}
          max={100}
          step={5}
          value={filters.minScore ?? 0}
          onChange={(e) => setMinScore(Number(e.target.value))}
          className="w-full h-1.5 rounded-full accent-indigo-500 cursor-pointer"
        />
        <div className="flex justify-between text-xs text-slate-600 mt-0.5">
          <span>0</span><span>50</span><span>100</span>
        </div>
      </FilterGroup>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{label}</p>
      {children}
    </div>
  );
}

function FilterChip({
  id,
  active,
  onClick,
  children,
  colorClass = "",
}: {
  id: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  colorClass?: string;
}) {
  const base = "px-2.5 py-1 text-xs rounded-md border transition-all duration-150 cursor-pointer";
  const inactive = "border-slate-700/50 bg-slate-800/40 text-slate-500 hover:text-slate-300 hover:border-slate-600/60";
  const activeDefault = "border-indigo-500/50 bg-indigo-500/15 text-indigo-300";

  return (
    <button
      id={id}
      data-active={active}
      onClick={onClick}
      className={`${base} ${active ? (colorClass || activeDefault) : inactive} ${colorClass}`}
    >
      {children}
    </button>
  );
}
