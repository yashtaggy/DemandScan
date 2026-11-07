"use client";

import type {
  LiveTradeNearestZoneDto,
  LiveTradeQuoteDto,
  LiveTradeZoneSummaryDto,
} from "@/lib/live-trade/client";
import type { ZoneSide } from "@/lib/scanner/types";
import type { QuoteDisplayState } from "@/hooks/use-live-trade-quotes";
import { CoverageBadge } from "./coverage-badge";
import {
  LIFECYCLE_CLASS,
  LIFECYCLE_LABEL,
  SIDE_META,
  TIMEFRAME_MATCH_LABEL,
  formatDateOnly,
  formatDistance,
  formatPrice,
  scoreTextClass,
} from "@/lib/live-trade/ui";
import { cn } from "@/lib/utils";

interface ZoneSummaryProps {
  summary: LiveTradeZoneSummaryDto | undefined;
  quote: LiveTradeQuoteDto | null | undefined;
  zonesAvailable: boolean;
  displayState: QuoteDisplayState;
}

function StructuralZone({
  zone,
  side,
}: {
  zone: LiveTradeNearestZoneDto | null;
  side: ZoneSide;
}) {
  const sideMeta = SIDE_META[side];

  if (!zone) {
    return (
      <div className="rounded-lg border border-slate-700/40 bg-slate-800/25 px-2.5 py-2 text-[11px] text-slate-500">
        No structural {sideMeta.label.toLowerCase()} zone.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border bg-slate-800/25 px-2.5 py-2",
        sideMeta.border
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 rounded-full", sideMeta.dot)} />
          <span className={cn("text-[11px] font-semibold", sideMeta.text)}>
            {sideMeta.label}
          </span>
          <span className="text-[11px] text-slate-400">
            {zone.timeframe} · {zone.pattern}
          </span>
          <span className="text-[10px] text-slate-600">
            {TIMEFRAME_MATCH_LABEL[zone.timeframeMatch]}
          </span>
        </div>
        <span
          className={cn(
            "rounded-full border px-1.5 py-0.5 text-[10px]",
            LIFECYCLE_CLASS[zone.lifecycleState]
          )}
        >
          {LIFECYCLE_LABEL[zone.lifecycleState]}
        </span>
      </div>

      <p className="mt-1 text-[11px] tabular-nums text-slate-300">
        {formatPrice(zone.zoneLow)} – {formatPrice(zone.zoneHigh)}
        <span className={cn("ml-1.5", scoreTextClass(zone.formationScore))}>
          Formation {zone.formationScore}
        </span>
      </p>
      <p className="text-[10px] tabular-nums text-slate-500">
        Proximal {formatPrice(zone.proximal)} · Distal {formatPrice(zone.distal)}
      </p>
      <p className="text-[10px] text-slate-600">
        Formed {formatDateOnly(zone.formationTs)}
        {zone.touchCount > 0 ? ` · ${zone.touchCount}× touched` : ""}
      </p>
    </div>
  );
}

function QuoteDistance({
  label,
  zone,
}: {
  label: string;
  zone: LiveTradeNearestZoneDto | null;
}) {
  if (!zone || zone.distancePercent === null) {
    return (
      <p className="text-[10px] text-slate-500">
        {label}: no price-eligible zone for this quote.
      </p>
    );
  }
  return (
    <p className="text-[10px] tabular-nums text-slate-400">
      {label}:{" "}
      <span className="text-slate-300">{formatDistance(zone.distancePercent)}</span>{" "}
      from LTP · proximal {formatPrice(zone.proximal)} · {zone.timeframe}
    </p>
  );
}

/**
 * Structural scanner zones (from the board) are rendered separately from
 * price-relative distances (from the latest valid quote). Distances are hidden
 * for retained, stale, invalid or unavailable quotes.
 */
export function ZoneSummary({
  summary,
  quote,
  zonesAvailable,
  displayState,
}: ZoneSummaryProps) {
  const coverage = summary?.coverage ?? "UNKNOWN";
  const freshness = summary?.zoneFreshness;

  const hasCurrentQuote =
    displayState === "current" &&
    quote !== null &&
    quote !== undefined &&
    quote.freshness !== "UNAVAILABLE" &&
    quote.lastPrice !== null;
  const distancesSuppressed =
    displayState === "stale" || displayState === "sign-in";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="text-[10px] uppercase tracking-wider text-slate-600">
          Scanner structure
        </p>
        <CoverageBadge coverage={coverage} />
        {summary?.preferredTimeframe && (
          <span className="text-[10px] text-slate-500">
            Preferred {summary.preferredTimeframe}
          </span>
        )}
      </div>

      <p className="text-[10px] text-slate-500">
        {freshness?.latestCoveringScanAt
          ? `Latest covering scan ${formatDateOnly(freshness.latestCoveringScanAt)}`
          : "No completed scan covering this instrument"}
        {freshness
          ? ` · ${freshness.zoneCount} zones (${freshness.activeZoneCount} active)`
          : ""}
      </p>

      <div className="grid gap-1.5">
        <StructuralZone zone={summary?.nearestDemand ?? null} side="DEMAND" />
        <StructuralZone zone={summary?.nearestSupply ?? null} side="SUPPLY" />
      </div>

      <div className="rounded-lg border border-slate-700/30 bg-slate-900/30 px-2.5 py-1.5">
        <p className="text-[10px] uppercase tracking-wider text-slate-600">
          Price-relative (latest quote)
        </p>
        {distancesSuppressed ? (
          <p className="mt-0.5 text-[10px] text-amber-400/80">
            Distance hidden: the retained quote is not current.
          </p>
        ) : !hasCurrentQuote ? (
          <p className="mt-0.5 text-[10px] text-slate-500">
            A valid quote is required to calculate distance.
          </p>
        ) : !zonesAvailable ? (
          <p className="mt-0.5 text-[10px] text-amber-400/80">
            Nearest zones for the latest quote were unavailable. Structural
            zones above are unaffected.
          </p>
        ) : (
          <div className="mt-0.5 space-y-0.5">
            <QuoteDistance label="Demand" zone={quote?.nearestDemand ?? null} />
            <QuoteDistance label="Supply" zone={quote?.nearestSupply ?? null} />
            {quote?.freshness === "DELAYED" && (
              <p className="text-[10px] text-amber-400/80">
                Based on a delayed quote timestamp.
              </p>
            )}
            {quote?.freshness === "LAST_CLOSE" && (
              <p className="text-[10px] text-slate-500">
                Based on the last close; the market is closed.
              </p>
            )}
          </div>
        )}
      </div>

      {coverage !== "AVAILABLE" && (
        <p className="text-[10px] leading-relaxed text-slate-500">
          {coverage === "STALE"
            ? `Scan data is older than the ${freshness?.freshnessThresholdDays ?? 7}-day freshness window.`
            : "Structural zones may be incomplete for this instrument."}
        </p>
      )}

      {summary?.nearestDemand === null &&
        summary?.nearestSupply === null &&
        quote?.nearestDemand === null &&
        quote?.nearestSupply === null && (
          <p className="text-[10px] text-slate-600">
            No demand or supply zone currently qualifies.
          </p>
        )}

      {freshness && freshness.latestCoveringScanAt && (
        <p className="text-[10px] text-slate-600">
          Scan freshness window {freshness.freshnessThresholdDays} days. Each
          zone keeps its own formation date.
        </p>
      )}
    </div>
  );
}
