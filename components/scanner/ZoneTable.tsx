"use client";

import { useState } from "react";
import type { Zone } from "@/lib/scanner/types";
import { ZoneDetailDrawer } from "./ZoneDetailDrawer";

interface ZoneTableProps {
  zones: Zone[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelect?: (zone: Zone) => void;
}

const SIDE_STYLE = {
  DEMAND: { pill: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30", dot: "bg-emerald-400" },
  SUPPLY: { pill: "text-rose-400 bg-rose-400/10 border-rose-400/30", dot: "bg-rose-400" },
};

const LC_STYLE: Record<string, string> = {
  CONFIRMED_FRESH: "text-emerald-400 bg-emerald-400/10 border-emerald-400/25",
  TOUCHED_ONCE:    "text-amber-400 bg-amber-400/10 border-amber-400/25",
  RETESTED:        "text-orange-400 bg-orange-400/10 border-orange-400/25",
  BROKEN:          "text-rose-500/70 bg-rose-500/5 border-rose-500/20",
};

const LC_LABEL: Record<string, string> = {
  CONFIRMED_FRESH: "Fresh",
  TOUCHED_ONCE:    "Tested ×1",
  RETESTED:        "Retested",
  BROKEN:          "Broken",
};

function fmtPrice(n: number) {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d: Date | string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

function ScoreBar({ score, color = "bg-indigo-500" }: { score: number; color?: string }) {
  const autoColor =
    score >= 70 ? "bg-emerald-500" : score >= 45 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex-1 h-1.5 rounded-full bg-slate-700/60 overflow-hidden">
        <div className={`h-full rounded-full ${color === "auto" ? autoColor : color} transition-all`}
          style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs tabular-nums text-slate-400 w-5 text-right">{score}</span>
    </div>
  );
}

function DataQualityBadge({ score }: { score: number | undefined }) {
  if (score == null) return null;
  if (score >= 5) return null; // full quality — no warning needed
  const color = score >= 3 ? "text-amber-400" : "text-rose-400";
  return (
    <span title={`Data quality: ${score}/5`} className={`text-xs ${color} cursor-help`}>⚠</span>
  );
}

function DistanceBadge({ pct }: { pct: number | null | undefined }) {
  if (pct == null) return <span className="text-slate-600">—</span>;
  const color = pct < 1 ? "text-emerald-400" : pct < 3 ? "text-amber-400" : "text-slate-400";
  return <span className={`tabular-nums ${color}`}>{pct.toFixed(1)}%</span>;
}

function ConfluenceBadge({ score }: { score: number | undefined }) {
  if (!score) return <span className="text-slate-600">—</span>;
  const color = score >= 20 ? "text-cyan-400" : "text-slate-400";
  return <span className={`tabular-nums ${color}`}>{score}</span>;
}

export function ZoneTable({ zones, loading, error, onRetry, onSelect }: ZoneTableProps) {
  const [selectedZone, setSelectedZone] = useState<Zone | null>(null);

  function handleSelect(zone: Zone) {
    if (onSelect) onSelect(zone);
    else setSelectedZone(zone);
  }

  if (error) {
    return (
      <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-4 flex items-center justify-between gap-3">
        <p className="text-xs text-rose-400">{error}</p>
        <button onClick={onRetry} className="text-xs text-rose-400 hover:text-rose-300 underline">Retry</button>
      </div>
    );
  }

  if (loading && zones.length === 0) {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 rounded-lg bg-slate-800/40 animate-pulse" style={{ opacity: 1 - i * 0.15 }} />
        ))}
      </div>
    );
  }

  if (zones.length === 0) {
    return (
      <div className="rounded-lg border border-slate-700/40 bg-slate-800/20 p-6 text-center">
        <p className="text-sm text-slate-500">No zones found</p>
        <p className="text-xs text-slate-600 mt-1">Run a scan or adjust your filters.</p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-slate-700/40 overflow-x-auto">
        <table className="w-full text-xs min-w-[700px]">
          <thead>
            <tr className="border-b border-slate-700/40 bg-slate-800/40">
              <th className="px-3 py-2 text-left text-slate-500 font-medium">Symbol</th>
              <th className="px-2 py-2 text-left text-slate-500 font-medium">TF</th>
              <th className="px-2 py-2 text-left text-slate-500 font-medium">Pattern</th>
              <th className="px-2 py-2 text-left text-slate-500 font-medium">Proximal</th>
              <th className="px-2 py-2 text-left text-slate-500 font-medium">Status</th>
              <th className="px-2 py-2 text-left text-slate-500 font-medium" title="Distance from current price">Dist %</th>
              <th className="px-2 py-2 text-left text-slate-500 font-medium" title="Higher-timeframe confluence score">Conf.</th>
              <th className="px-2 py-2 text-left text-slate-500 font-medium">Formation</th>
              <th className="px-3 py-2 text-left text-slate-500 font-medium">Score</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/20">
            {zones.map((zone) => {
              const s  = SIDE_STYLE[zone.side]          ?? SIDE_STYLE.DEMAND;
              const lc = LC_STYLE[zone.lifecycleState]  ?? "text-slate-400";
              const lcLabel = LC_LABEL[zone.lifecycleState] ?? zone.lifecycleState;
              const compositeScore = zone.compositeScore ?? zone.score;
              return (
                <tr key={zone.zoneId} id={`zone-row-${zone.zoneId}`}
                  className="hover:bg-slate-800/40 cursor-pointer transition-colors group"
                  onClick={() => handleSelect(zone)}
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${s.dot}`} />
                      <span className="font-medium text-slate-200 group-hover:text-white transition-colors">
                        {zone.symbol ?? zone.instrumentId}
                      </span>
                      <DataQualityBadge score={zone.dataQualityScore} />
                    </div>
                  </td>
                  <td className="px-2 py-2.5 text-slate-500 font-mono">{zone.timeframe}</td>
                  <td className="px-2 py-2.5">
                    <span className={`inline-flex px-1.5 py-0.5 rounded border text-xs font-medium ${s.pill}`}>
                      {zone.pattern}
                    </span>
                  </td>
                  <td className="px-2 py-2.5 text-slate-300 tabular-nums">₹{fmtPrice(zone.proximal)}</td>
                  <td className="px-2 py-2.5">
                    <span className={`inline-flex px-1.5 py-0.5 rounded border text-xs font-medium ${lc}`}>
                      {lcLabel}
                    </span>
                  </td>
                  <td className="px-2 py-2.5">
                    <DistanceBadge pct={zone.distancePct} />
                  </td>
                  <td className="px-2 py-2.5">
                    <ConfluenceBadge score={zone.confluenceScore} />
                  </td>
                  <td className="px-2 py-2.5 text-slate-500">
                    {fmtDate(zone.formationTs)}
                  </td>
                  <td className="px-3 py-2.5 w-28">
                    <ScoreBar score={compositeScore} color="auto" />
                    {zone.compositeScore != null && zone.score !== zone.compositeScore && (
                      <span className="text-slate-600 text-xs tabular-nums">F:{zone.score}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ZoneDetailDrawer zone={selectedZone} onClose={() => setSelectedZone(null)} />
    </>
  );
}
