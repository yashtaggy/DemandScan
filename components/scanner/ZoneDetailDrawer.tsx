"use client";

import type { Zone } from "@/lib/scanner/types";

interface ZoneDetailDrawerProps {
  zone: Zone | null;
  onClose: () => void;
}

const SIDE_COLOR = {
  DEMAND: { border: "border-emerald-500/30", bg: "bg-emerald-500/8", text: "text-emerald-400", dot: "bg-emerald-400" },
  SUPPLY: { border: "border-rose-500/30", bg: "bg-rose-500/8", text: "text-rose-400", dot: "bg-rose-400" },
};

const LIFECYCLE_COLOR: Record<string, string> = {
  CONFIRMED_FRESH: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30",
  TOUCHED_ONCE: "text-amber-400 bg-amber-400/10 border-amber-400/30",
  RETESTED: "text-orange-400 bg-orange-400/10 border-orange-400/30",
  BROKEN: "text-rose-400 bg-rose-400/10 border-rose-400/30",
};

const LIFECYCLE_LABEL: Record<string, string> = {
  CONFIRMED_FRESH: "Fresh",
  TOUCHED_ONCE: "Tested",
  RETESTED: "Retested",
  BROKEN: "Broken",
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

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <aside
        role="dialog"
        aria-label="Zone Details"
        className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-sm bg-slate-900 border-l border-slate-700/60 shadow-2xl flex flex-col animate-in slide-in-from-right duration-250"
      >
        {/* Header */}
        <div className={`flex items-start justify-between p-5 border-b ${c.border} ${c.bg}`}>
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${c.dot}`} />
              <h3 className={`text-base font-bold ${c.text}`}>
                {/* @ts-ignore symbol may be on joined row */}
                {(zone as any).symbol ?? `ID #${zone.instrumentId}`}
              </h3>
              <span className="text-xs text-slate-500">{zone.timeframe}</span>
            </div>
            <p className="text-xs text-slate-500">
              {zone.pattern} · {zone.side === "DEMAND" ? "Demand Zone" : "Supply Zone"}
            </p>
          </div>

          <button
            id="zone-drawer-close"
            onClick={onClose}
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
          {/* Score + Lifecycle badges */}
          <div className="flex items-center gap-3">
            <div className="flex-1 rounded-lg bg-slate-800/60 border border-slate-700/40 p-3 text-center">
              <p className="text-xs text-slate-500 mb-0.5">Score</p>
              <p className="text-2xl font-bold tabular-nums text-indigo-400">{zone.score}</p>
              <p className="text-xs text-slate-600">/100</p>
            </div>
            <div className="flex-1 rounded-lg bg-slate-800/60 border border-slate-700/40 p-3 text-center">
              <p className="text-xs text-slate-500 mb-0.5">Status</p>
              <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border ${lc}`}>
                {lcLabel}
              </span>
              {zone.touchCount > 0 && (
                <p className="text-xs text-slate-600 mt-1">{zone.touchCount}× touched</p>
              )}
            </div>
          </div>

          {/* Price levels */}
          <Section title="Price Levels">
            <Row label="Proximal" value={`₹${fmt(zone.proximal)}`} highlight />
            <Row label="Distal" value={`₹${fmt(zone.distal)}`} />
            <Row label="Zone High" value={`₹${fmt(zone.zoneHigh)}`} />
            <Row label="Zone Low" value={`₹${fmt(zone.zoneLow)}`} />
            <Row label="Zone Width" value={`₹${fmt(zone.zoneHigh - zone.zoneLow)}`} />
          </Section>

          {/* Timeline */}
          <Section title="Formation Timeline">
            <Row label="Leg-In" value={fmtDate(zone.legInTs)} />
            <Row label="Base Start" value={fmtDate(zone.baseStart)} />
            <Row label="Base End" value={fmtDate(zone.baseEnd)} />
            <Row label="Leg-Out" value={fmtDate(zone.legOutTs)} />
            {zone.lastTouchTs && (
              <Row label="Last Touch" value={fmtDate(zone.lastTouchTs)} />
            )}
          </Section>

          {/* Meta */}
          <Section title="Meta">
            <Row label="Pattern" value={zone.pattern} />
            <Row label="Timeframe" value={zone.timeframe} />
            <Row label="Config v" value={String(zone.configVersion)} />
          </Section>
        </div>
      </aside>
    </>
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
