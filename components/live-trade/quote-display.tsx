"use client";

import { Badge } from "@/components/ui/badge";
import type { LiveTradeQuoteDto } from "@/lib/live-trade/client";
import type { LiveTradeQuoteErrorCode } from "@/lib/live-trade/constants";
import {
  QUOTE_ERROR_TEXT,
  QUOTE_FRESHNESS_META,
  formatDateTimeIst,
  formatPrice,
} from "@/lib/live-trade/ui";
import type { QuoteDisplayState } from "@/hooks/use-live-trade-quotes";
import { cn, formatPercent } from "@/lib/utils";

interface QuoteDisplayProps {
  quote: LiveTradeQuoteDto | null | undefined;
  displayState: QuoteDisplayState;
  loading?: boolean;
  compact?: boolean;
}

function changeClass(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value === 0) {
    return "text-slate-400";
  }
  return value > 0 ? "text-emerald-400" : "text-rose-400";
}

/**
 * Quote cell. An unavailable or stale quote is never replaced by another price
 * source and never labelled live; retained snapshots say exactly when they were
 * fetched.
 */
export function QuoteDisplay({
  quote,
  displayState,
  loading = false,
  compact = false,
}: QuoteDisplayProps) {
  if (!quote) {
    if (loading) {
      return (
        <div className="space-y-2" aria-label="Loading quote">
          <div className="h-5 w-24 animate-pulse rounded bg-slate-700/60" />
          <div className="h-3 w-32 animate-pulse rounded bg-slate-700/40" />
        </div>
      );
    }
    return (
      <p className="text-xs text-slate-500">
        No quote loaded for this instrument yet.
      </p>
    );
  }

  const effectiveFreshness =
    displayState === "stale"
      ? "STALE"
      : displayState === "sign-in"
        ? "SIGN_IN_REQUIRED"
        : quote.freshness;
  const meta = QUOTE_FRESHNESS_META[effectiveFreshness] ?? {
    label: effectiveFreshness,
    tone: "neutral" as const,
  };

  const unavailable =
    quote.freshness === "UNAVAILABLE" ||
    quote.lastPrice === null ||
    !Number.isFinite(quote.lastPrice);

  if (unavailable) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-400">—</span>
          <Badge variant="neutral">Unavailable</Badge>
        </div>
        {quote.errorCode && (
          <p className="text-[11px] leading-relaxed text-slate-500">
            {QUOTE_ERROR_TEXT[quote.errorCode as LiveTradeQuoteErrorCode]}
          </p>
        )}
        <p className="text-[11px] text-slate-600">
          Fetched {formatDateTimeIst(quote.fetchedAt)} IST
        </p>
      </div>
    );
  }

  const showChange =
    quote.change !== null && quote.changePercent !== null;

  return (
    <div className={cn("space-y-1.5", compact && "space-y-1")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          LTP
        </span>
        <span className="text-base font-semibold tabular-nums text-slate-100">
          {formatPrice(quote.lastPrice)}
        </span>
        <Badge
          variant={meta.tone}
          dot={effectiveFreshness === "LIVE"}
        >
          {meta.label}
        </Badge>
      </div>

      {showChange ? (
        <p className={cn("text-xs tabular-nums", changeClass(quote.change))}>
          {quote.change !== null && quote.change > 0 ? "+" : ""}
          {quote.change?.toFixed(2)} ({formatPercent(quote.changePercent ?? 0)})
        </p>
      ) : (
        <p className="text-[11px] text-slate-500">Change unavailable</p>
      )}

      <dl className="space-y-0.5 text-[11px] text-slate-500">
        <div className="flex flex-wrap gap-x-1.5">
          <dt>Last traded</dt>
          <dd className="tabular-nums">
            {quote.lastTradedAt
              ? `${formatDateTimeIst(quote.lastTradedAt)} IST`
              : "Not provided"}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-1.5">
          <dt>Quote fetched</dt>
          <dd className="tabular-nums">
            {formatDateTimeIst(quote.fetchedAt)} IST
          </dd>
        </div>
      </dl>

      {displayState === "stale" && (
        <p className="rounded border border-amber-500/20 bg-amber-500/5 px-1.5 py-1 text-[11px] text-amber-400">
          Retained snapshot. The latest refresh failed, so this is not a live
          price.
        </p>
      )}
      {displayState === "sign-in" && (
        <p className="rounded border border-amber-500/20 bg-amber-500/5 px-1.5 py-1 text-[11px] text-amber-400">
          Session expired. Reconnect to refresh this quote.
        </p>
      )}
      {displayState === "current" && effectiveFreshness === "DELAYED" && (
        <p className="text-[11px] text-amber-400/80">
          The provider timestamp is older than five minutes.
        </p>
      )}
    </div>
  );
}
