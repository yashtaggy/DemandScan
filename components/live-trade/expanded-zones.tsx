"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  LiveTradeExpandedZoneDto,
  LiveTradeItemDto,
  LiveTradeZoneSummaryDto,
} from "@/lib/live-trade/client";
import { liveTradeErrorMessage } from "@/lib/live-trade/client";
import { useExpandedZones } from "@/hooks/use-expanded-zones";
import {
  COVERAGE_META,
  LIFECYCLE_CLASS,
  LIFECYCLE_LABEL,
  SIDE_META,
  formatDateOnly,
  formatPrice,
  scoreTextClass,
} from "@/lib/live-trade/ui";
import { formatCount } from "@/lib/live-trade/ui";
import { cn } from "@/lib/utils";
import { CoverageBadge } from "./coverage-badge";
import { Modal } from "./modal";

interface ExpandedZonesProps {
  item: LiveTradeItemDto;
  summary: LiveTradeZoneSummaryDto | undefined;
  /** The independent summary request is still in flight. */
  zonesLoading: boolean;
  /** The independent summary request failed. */
  zonesError: boolean;
  onRetryZones: () => void;
  onClose: () => void;
}

function ZoneRow({ zone }: { zone: LiveTradeExpandedZoneDto }) {
  const side = SIDE_META[zone.side];
  return (
    <li
      className="space-y-1.5 px-3 py-2.5"
      aria-label={`${side.label} zone ${zone.timeframe} ${zone.pattern}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("h-1.5 w-1.5 rounded-full", side.dot)} />
        <span className={cn("text-xs font-semibold", side.text)}>
          {side.label}
        </span>
        <span className="text-[11px] text-slate-400">
          {zone.timeframe} · {zone.pattern}
        </span>
        <span
          className={cn(
            "rounded-full border px-1.5 py-0.5 text-[10px]",
            LIFECYCLE_CLASS[zone.lifecycleState]
          )}
        >
          {LIFECYCLE_LABEL[zone.lifecycleState]}
        </span>
        <span
          className={cn(
            "text-[11px] tabular-nums",
            scoreTextClass(zone.formationScore)
          )}
        >
          Formation {zone.formationScore}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-600">
            Zone
          </p>
          <p className="tabular-nums text-slate-300">
            {formatPrice(zone.zoneLow)} – {formatPrice(zone.zoneHigh)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-600">
            Proximal / distal
          </p>
          <p className="tabular-nums text-slate-400">
            {formatPrice(zone.proximal)} / {formatPrice(zone.distal)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-600">
            Formed
          </p>
          <p className="text-slate-400">{formatDateOnly(zone.formationTs)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-600">
            Touches
          </p>
          <p className="text-slate-400">
            {zone.touchCount}
            {zone.lastTouchTs
              ? ` · last ${formatDateOnly(zone.lastTouchTs)}`
              : ""}
          </p>
        </div>
      </div>
    </li>
  );
}

export function ExpandedZones({
  item,
  summary,
  zonesLoading,
  zonesError,
  onRetryZones,
  onClose,
}: ExpandedZonesProps) {
  const { zones, pagination, loading, loadingMore, error, loadMore, retry } =
    useExpandedZones(item.instrumentId, true);

  // A missing summary while the request is pending or failed is unknown, not
  // a confirmed UNKNOWN coverage, so it must never render as one.
  const coverageLoading = summary === undefined && zonesLoading;
  const coverageError = summary === undefined && zonesError;
  const coverage = summary?.coverage;
  const coverageMeta = coverage ? COVERAGE_META[coverage] : null;

  return (
    <Modal
      open
      onClose={onClose}
      title={`${item.symbol} · structural zones`}
      description="All saved scanner zones for this instrument, including broken zones and any formation score. No quote is used, so price distance is not shown."
      size="xl"
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[10px] text-slate-600">
            {pagination
              ? `Page ${pagination.page} · ${formatCount(zones.length)} shown`
              : "No zones loaded"}
            {pagination && pagination.hasMore ? " · more available" : ""}
          </p>
          <div className="flex justify-end gap-2">
            {pagination?.hasMore && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={loadingMore}
                disabled={loading || loadingMore}
                onClick={loadMore}
              >
                Load more
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg border border-slate-700/40 bg-slate-800/30 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            {coverageError ? (
              <>
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                  Coverage unavailable
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  loading={zonesLoading}
                  onClick={onRetryZones}
                >
                  Retry coverage
                </Button>
              </>
            ) : coverageLoading ? (
              <span role="status" className="text-[11px] text-slate-500">
                Loading zone coverage…
              </span>
            ) : coverage ? (
              <CoverageBadge coverage={coverage} />
            ) : (
              <span className="rounded-full border border-slate-600/50 bg-slate-700/20 px-1.5 py-0.5 text-[10px] text-slate-400">
                Coverage not loaded
              </span>
            )}
            {summary?.preferredTimeframe && (
              <Badge variant="neutral">
                Preferred {summary.preferredTimeframe}
              </Badge>
            )}
          </div>
          {coverageMeta ? (
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              {coverageMeta.description}
            </p>
          ) : coverageError ? (
            <p className="mt-1 text-[11px] leading-relaxed text-amber-400/80">
              Zone coverage could not be loaded. Saved zones below are still
              shown.
            </p>
          ) : null}
          {summary?.zoneFreshness.latestCoveringScanAt && (
            <p className="mt-0.5 text-[10px] text-slate-600">
              Latest covering scan{" "}
              {formatDateOnly(summary.zoneFreshness.latestCoveringScanAt)} ·{" "}
              {summary.zoneFreshness.freshnessThresholdDays}-day freshness
              window · each zone keeps its own formation date.
            </p>
          )}
        </div>

        {loading && zones.length === 0 && (
          <div className="space-y-1.5" aria-label="Loading structural zones">
            {[0, 1, 2, 3].map((row) => (
              <div
                key={row}
                className="h-16 animate-pulse rounded-lg bg-slate-700/30"
              />
            ))}
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2">
            <p className="text-xs text-rose-300">{liveTradeErrorMessage(error)}</p>
            <Button type="button" variant="ghost" size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        )}

        {!loading && !error && zones.length === 0 && (
          <p className="rounded-lg border border-slate-700/40 bg-slate-800/30 px-3 py-6 text-center text-xs text-slate-500">
            {coverage === "NO_SCAN_HISTORY"
              ? "No completed scan covering this instrument was found."
              : coverage === "NO_ZONES"
                ? "The latest completed scan found no qualifying zones."
                : "No structural zones are saved for this instrument."}
          </p>
        )}

        {zones.length > 0 && (
          <ul className="divide-y divide-slate-700/40 rounded-lg border border-slate-700/40">
            {zones.map((zone) => (
              <ZoneRow key={zone.zoneId} zone={zone} />
            ))}
          </ul>
        )}

        {pagination && !pagination.hasMore && zones.length > 0 && (
          <p className="text-center text-[10px] text-slate-600">
            All available zones for this batch are shown. The retrieval limit is{" "}
            {formatCount(pagination.batchLimit)} zones.
          </p>
        )}
      </div>
    </Modal>
  );
}
