"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { QuoteDisplayState } from "@/hooks/use-live-trade-quotes";
import { formatDateTimeIst, formatCount } from "@/lib/live-trade/ui";

export interface MarketStatusView {
  isOpen: boolean;
  exchange: string;
  approximation?: string;
}

export interface QuoteSummaryView {
  total: number;
  live: number;
  delayed: number;
  lastClose: number;
  unavailable: number;
}

interface WorkspaceHeaderProps {
  instrumentCount: number;
  groupCount: number;
  market: MarketStatusView | null;
  fetchedAt: string | null;
  quoteSummary: QuoteSummaryView;
  quotesLoading: boolean;
  quotesRefreshing: boolean;
  quoteError: string | null;
  displayState: QuoteDisplayState;
  cooldownSecondsLeft: number;
  onRefreshQuotes: () => void;
}

export function WorkspaceHeader({
  instrumentCount,
  groupCount,
  market,
  fetchedAt,
  quoteSummary,
  quotesLoading,
  quotesRefreshing,
  quoteError,
  displayState,
  cooldownSecondsLeft,
  onRefreshQuotes,
}: WorkspaceHeaderProps) {
  const refreshDisabled =
    quotesRefreshing ||
    quotesLoading ||
    cooldownSecondsLeft > 0 ||
    displayState === "sign-in";

  const refreshLabel = quotesRefreshing || quotesLoading
    ? "Refreshing…"
    : cooldownSecondsLeft > 0
      ? `Retry in ${cooldownSecondsLeft}s`
      : displayState === "sign-in"
        ? "Reconnect to refresh"
        : "Refresh quotes";

  return (
    <section
      aria-labelledby="live-trade-heading"
      className="rounded-2xl border border-slate-700/50 bg-slate-800/30 p-4 sm:p-5"
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1
            id="live-trade-heading"
            className="flex items-center gap-2 text-lg font-bold text-slate-100"
          >
            <span className="text-indigo-400" aria-hidden="true">
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 3v18h18" />
                <path d="M7 14l4-4 3 3 5-6" />
              </svg>
            </span>
            Live Trade
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            Your personal market watchlist and trade planning workspace.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="neutral">
              {formatCount(instrumentCount)} tracked instruments
            </Badge>
            <Badge variant="neutral">
              {formatCount(groupCount)} {groupCount === 1 ? "group" : "groups"}
            </Badge>
          </div>
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onRefreshQuotes}
          disabled={refreshDisabled || instrumentCount === 0}
          loading={quotesRefreshing || quotesLoading}
          id="refresh-quotes-btn"
        >
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
          {refreshLabel}
        </Button>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-700/40 bg-slate-900/40 px-3.5 py-3">
          <p className="text-[10px] uppercase tracking-wider text-slate-600">
            Market session
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {market ? (
              <Badge
                variant={market.isOpen ? "success" : "neutral"}
                dot={market.isOpen}
              >
                {market.exchange} {market.isOpen ? "Open" : "Closed"}
              </Badge>
            ) : (
              <Badge variant="neutral">Status unavailable</Badge>
            )}
            <span
              className="text-[10px] text-slate-500"
              title={
                market?.approximation ??
                "Approximate regular NSE session; exchange holidays are not modelled."
              }
            >
              Approximate session
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-700/40 bg-slate-900/40 px-3.5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-600">
              Quote freshness
            </p>
            {displayState === "stale" && (
              <Badge variant="warning">Stale snapshot</Badge>
            )}
            {displayState === "sign-in" && (
              <Badge variant="warning">Sign in required</Badge>
            )}
          </div>

          {quoteSummary.total === 0 ? (
            <p className="mt-1 text-xs text-slate-500">
              Add an instrument to load quotes.
            </p>
          ) : fetchedAt === null ? (
            <p className="mt-1 text-xs text-slate-500">
              {quotesLoading ? "Loading quotes…" : "Quotes not loaded yet."}
            </p>
          ) : (
            <>
              <p className="mt-1 text-xs tabular-nums text-slate-300">
                {displayState === "stale" ? "Last successful refresh " : "Updated "}
                {formatDateTimeIst(fetchedAt)} IST
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
                {quoteSummary.live > 0 && (
                  <span className="text-emerald-400">
                    {quoteSummary.live} live
                  </span>
                )}
                {quoteSummary.delayed > 0 && (
                  <span className="text-amber-400">
                    {quoteSummary.delayed} delayed
                  </span>
                )}
                {quoteSummary.lastClose > 0 && (
                  <span className="text-blue-400">
                    {quoteSummary.lastClose} last close
                  </span>
                )}
                {quoteSummary.unavailable > 0 && (
                  <span className="text-slate-500">
                    {quoteSummary.unavailable} unavailable
                  </span>
                )}
              </div>
            </>
          )}

          {quoteError && (
            <p
              role="status"
              className="mt-1.5 text-[11px] leading-relaxed text-amber-400"
            >
              {quoteError}
              {cooldownSecondsLeft > 0
                ? ` Retry in ${cooldownSecondsLeft}s.`
                : ""}{" "}
              Your board data is unaffected.
            </p>
          )}
        </div>
      </div>

      <p className="mt-2 text-[10px] text-slate-600">
        Market session, quote freshness and scanner coverage freshness are
        separate signals. Quotes refresh automatically every 30 seconds while
        this page is active.
      </p>
    </section>
  );
}
