"use client";

import { Badge } from "@/components/ui/badge";

type Timeframe = "5m" | "15m" | "1h" | "1D";

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "1D"];

export function ScannerPanel() {
  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">Scanner Configuration</h3>
          <p className="text-xs text-slate-500 mt-0.5">Supply/demand zone filters</p>
        </div>
        <Badge variant="warning" size="sm">Phase 2</Badge>
      </div>

      {/* Timeframe selector — UI ready, logic in Phase 2 */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
          Timeframe
        </label>
        <div className="flex gap-1.5">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              id={`timeframe-${tf}`}
              disabled
              title="Available in Phase 2"
              className="px-3 py-1.5 text-xs rounded-md border border-slate-700/50 text-slate-600 bg-slate-800/40 cursor-not-allowed"
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Zone type */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
          Zone Type
        </label>
        <div className="flex gap-1.5">
          {["Supply", "Demand", "Both"].map((zt) => (
            <button
              key={zt}
              id={`zone-type-${zt.toLowerCase()}`}
              disabled
              title="Available in Phase 2"
              className="px-3 py-1.5 text-xs rounded-md border border-slate-700/50 text-slate-600 bg-slate-800/40 cursor-not-allowed"
            >
              {zt}
            </button>
          ))}
        </div>
      </div>

      {/* Zone status */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
          Zone Status
        </label>
        <div className="flex gap-1.5">
          {["Fresh", "Tested", "Broken"].map((zs) => (
            <button
              key={zs}
              id={`zone-status-${zs.toLowerCase()}`}
              disabled
              title="Available in Phase 2"
              className="px-3 py-1.5 text-xs rounded-md border border-slate-700/50 text-slate-600 bg-slate-800/40 cursor-not-allowed"
            >
              {zs}
            </button>
          ))}
        </div>
      </div>

      {/* Min R:R */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
          Min Risk : Reward
        </label>
        <input
          disabled
          placeholder="e.g. 1:3"
          title="Available in Phase 2"
          className="w-full rounded-md border border-slate-700/50 bg-slate-800/40 px-3 py-1.5 text-xs text-slate-600 placeholder-slate-700 cursor-not-allowed"
        />
      </div>

      <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-3">
        <p className="text-xs text-amber-500/80 leading-relaxed">
          <strong className="text-amber-400">Coming in Phase 2:</strong> Supply and demand zone
          detection with multi-timeframe analysis, zone strength scoring, and retest
          invalidation tracking.
        </p>
      </div>
    </div>
  );
}
