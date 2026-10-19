"use client";

import type { Zone, ScoreComponents } from "@/lib/scanner/types";

interface ZoneDetailDrawerProps {
  zone: Zone | null;
  onClose: () => void;
}

const SIDE_COLOR = {
  DEMAND: { border: "border-emerald-500/30", bg: "bg-emerald-500/8", text: "text-emerald-400", dot: "bg-emerald-400" },
  SUPPLY: { border: "border-rose-500/30",    bg: "bg-rose-500/8",    text: "text-rose-400",    dot: "bg-rose-400" },
};

const LIFECYCLE_COLOR: Record<string, string> = {
  CONFIRMED_FRESH: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30",
  TOUCHED_ONCE:    "text-amber-400   bg-amber-400/10   border-amber-400/30",
  RETESTED:        "text-orange-400  bg-orange-400/10  border-orange-400/30",
  BROKEN:          "text-rose-400    bg-rose-400/10    border-rose-400/30",
};

const LIFECYCLE_LABEL: Record<string, string> = {
  CONFIRMED_FRESH: "Fresh", TOUCHED_ONCE: "Tested", RETESTED: "Retested", BROKEN: "Broken",
};

function fmt(n: number) {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d: Date | string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function ZoneDetailDrawer({ zone, onClose }: ZoneDetailDrawerProps) {
  if (!zone) return null;

  const c = SIDE_COLOR[zone.side] ?? SIDE_COLOR.DEMAND;
  const lc = LIFECYCLE_COLOR[zone.lifecycleState] ?? "text-slate-400";
  const lcLabel = LIFECYCLE_LABEL[zone.lifecycleState] ?? zone.lifecycleState;
  const compositeScore = zone.compositeScore ?? zone.score;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={onClose} aria-hidden="true" />

      {/* Drawer */}
      <aside role="dialog" aria-label="Zone Details"
        className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-slate-900 border-l border-slate-700/60 shadow-2xl flex flex-col animate-in slide-in-from-right duration-250"
      >
        {/* Header */}
        <div className={`flex items-start justify-between p-5 border-b ${c.border} ${c.bg}`}>
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${c.dot}`} />
              <h3 className={`text-base font-bold ${c.text}`}>
                {zone.symbol ?? `ID #${zone.instrumentId}`}
              </h3>
              <span className="font-mono text-xs text-slate-500">{zone.timeframe}</span>
            </div>
            <p className="text-xs text-slate-500">
              {zone.pattern} · {zone.side === "DEMAND" ? "Demand Zone" : "Supply Zone"}
            </p>
          </div>
          <button id="zone-drawer-close" onClick={onClose}
            className="text-slate-500 hover:text-slate-200 transition-colors p-1 rounded-md hover:bg-slate-700/50"
            aria-label="Close"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">

          {/* Score cards */}
          <div className="grid grid-cols-3 gap-2">
            <ScoreCard label="Composite" value={compositeScore} color="text-violet-400"
              incomplete={zone.scoreComponents?.isComplete === false} />
            <ScoreCard label="Formation" value={zone.score}   color="text-indigo-400" />
            <div className="rounded-lg bg-slate-800/60 border border-slate-700/40 p-3 text-center">
              <p className="text-xs text-slate-500 mb-0.5">Status</p>
              <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${lc}`}>
                {lcLabel}
              </span>
              {zone.touchCount > 0 && (
                <p className="text-xs text-slate-600 mt-1">{zone.touchCount}× touched</p>
              )}
            </div>
          </div>

          {/* Incomplete score warning */}
          {zone.scoreComponents?.isComplete === false && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-400">
              ⚠ Composite score is incomplete. Missing:{" "}
              {zone.scoreComponents.missingComponents.join(", ")}
            </div>
          )}

          {/* Score component breakdown */}
          {zone.scoreComponents && (
            <Section title="Score Breakdown (v1 — not empirically optimal)">
              <ComponentBar label="TF Quality"     value={zone.scoreComponents.timeframeQuality}  max={20} />
              <ComponentBar label="Leg-out Body"   value={zone.scoreComponents.legOutBodyRatio}   max={15} />
              <ComponentBar label="Base Tightness" value={zone.scoreComponents.baseTightness}     max={15} />
              <ComponentBar label="Volume Surge"   value={zone.scoreComponents.volumeSurge}       max={10} />
              <ComponentBar label="Freshness"      value={zone.scoreComponents.freshness}         max={10} />
              <ComponentBar label="Zone Age"       value={zone.scoreComponents.zoneAge}           max={5}  />
              <ComponentBar label="Dist. from Price"
                value={zone.scoreComponents.distanceFromPrice ?? 0} max={5}
                note={zone.scoreComponents.distanceFromPrice == null ? "unavailable" : undefined} />
              <ComponentBar label="Confluence"     value={zone.scoreComponents.confluenceScore}   max={10} />
              <ComponentBar label="Opposing Room"  value={zone.scoreComponents.opposingZoneRoom}  max={5}  />
              <ComponentBar label="Data Quality"   value={zone.scoreComponents.dataQuality}       max={5}  />
            </Section>
          )}

          {/* Confluence + risk */}
          {(zone.confluenceScore || zone.oppositionRisk) && (
            <Section title="Confluence & Risk">
              {zone.confluenceScore != null && (
                <Row label="Confluence Score" value={`${zone.confluenceScore} / 100`} />
              )}
              {zone.oppositionRisk != null && (
                <Row label="Opposition Risk" value={`${zone.oppositionRisk} / 100`} />
              )}
              {zone.distancePct != null && (
                <Row label="Distance from Price" value={`${zone.distancePct.toFixed(2)}%`} highlight />
              )}
            </Section>
          )}

          {/* Price levels */}
          <Section title="Price Levels">
            <Row label="Proximal" value={`₹${fmt(zone.proximal)}`} highlight />
            <Row label="Distal"   value={`₹${fmt(zone.distal)}`}   />
            <Row label="Zone High" value={`₹${fmt(zone.zoneHigh)}`} />
            <Row label="Zone Low"  value={`₹${fmt(zone.zoneLow)}`}  />
            <Row label="Zone Width" value={`₹${fmt(zone.zoneHigh - zone.zoneLow)}`} />
          </Section>

          {/* Timeline */}
          <Section title="Formation Timeline">
            <Row label="Leg-In"     value={fmtDate(zone.legInTs)} />
            <Row label="Base Start" value={fmtDate(zone.baseStart)} />
            <Row label="Base End"   value={fmtDate(zone.baseEnd)} />
            <Row label="Leg-Out"    value={fmtDate(zone.legOutTs)} />
            {zone.lastTouchTs && (
              <Row label="Last Touch" value={fmtDate(zone.lastTouchTs)} />
            )}
          </Section>

          {/* Data quality */}
          {zone.dataQualityScore != null && zone.dataQualityScore < 5 && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
              <p className="text-xs font-semibold text-amber-400 mb-1">Data Quality Warning</p>
              <p className="text-xs text-slate-400">
                Quality score: {zone.dataQualityScore}/5. Some candles may be missing or incomplete for this timeframe. Historical results may differ from full-data analysis.
              </p>
            </div>
          )}

          {/* Meta */}
          <Section title="Meta">
            <Row label="Pattern"    value={zone.pattern} />
            <Row label="Timeframe"  value={zone.timeframe} />
            <Row label="Config v"   value={String(zone.configVersion)} />
            <Row label="Zone ID"    value={zone.zoneId.slice(0, 12) + "…"} />
          </Section>
        </div>
      </aside>
    </>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function ScoreCard({ label, value, color, incomplete }: {
  label: string; value: number; color: string; incomplete?: boolean;
}) {
  return (
    <div className="rounded-lg bg-slate-800/60 border border-slate-700/40 p-3 text-center">
      <p className="text-xs text-slate-500 mb-0.5">{label}</p>
      <p className={`text-2xl font-bold tabular-nums ${color}`}>
        {value}{incomplete && <span className="text-amber-400 text-base">*</span>}
      </p>
      <p className="text-xs text-slate-600">/100</p>
    </div>
  );
}

function ComponentBar({ label, value, max, note }: {
  label: string; value: number; max: number; note?: string;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const color = pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-slate-500";
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-700/30 last:border-0">
      <span className="text-xs text-slate-500 w-32 shrink-0">{label}</span>
      <div className="flex-1 h-1 rounded-full bg-slate-700/60 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-slate-400 w-10 text-right">
        {note ? <span className="text-amber-500/60">{note}</span> : `${value}/${max}`}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{title}</p>
      <div className="rounded-lg border border-slate-700/40 bg-slate-800/30 divide-y divide-slate-700/30">
        {children}
      </div>
    </div>
  );
}

function Row({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`text-xs font-medium tabular-nums ${highlight ? "text-indigo-300" : "text-slate-300"}`}>
        {value}
      </span>
    </div>
  );
}
