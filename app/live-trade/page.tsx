"use client";

import { Header } from "@/components/header";
import { Button } from "@/components/ui/button";
import { LiveTradeWorkspace } from "@/components/live-trade/workspace";
import { useAuth } from "@/hooks/use-auth";

export default function LiveTradePage() {
  const { status, loading, error, refetch } = useAuth();
  const authenticated = status?.authenticated ?? false;

  const market = status?.market
    ? {
        isOpen: status.market.isOpen,
        exchange: status.market.exchange,
      }
    : null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header lastRefreshed={null} />

      <main className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6">
        {loading && status === null ? (
          <div
            className="space-y-3"
            aria-label="Checking your Kite session"
          >
            <div className="h-36 animate-pulse rounded-2xl bg-slate-800/40" />
            <div className="h-10 animate-pulse rounded-lg bg-slate-800/30" />
            <div className="h-44 animate-pulse rounded-xl bg-slate-800/30" />
          </div>
        ) : error && status === null ? (
          <div
            role="alert"
            className="rounded-xl border border-rose-500/25 bg-rose-500/5 px-4 py-8 text-center"
          >
            <h1 className="text-sm font-semibold text-rose-300">
              Could not check your Kite session
            </h1>
            <p className="mx-auto mt-1 max-w-sm text-xs text-rose-300/80">
              {error}
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={refetch}
            >
              Try again
            </Button>
          </div>
        ) : !authenticated ? (
          <div className="mx-auto max-w-lg rounded-2xl border border-indigo-500/30 bg-indigo-500/5 px-6 py-10 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-indigo-500/15">
              <svg
                className="h-7 w-7 text-indigo-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="M3 3v18h18" />
                <path d="M7 14l4-4 3 3 5-6" />
              </svg>
            </div>
            <h1 className="mt-4 text-base font-semibold text-slate-100">
              Connect to use Live Trade
            </h1>
            <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-slate-500">
              Live Trade is your personal watchlist and trade planning
              workspace. Sign in with Kite Connect to load your board and
              market quotes. Your credentials are handled server-side and never
              exposed to the browser.
            </p>
            <Button
              type="button"
              variant="primary"
              size="lg"
              className="mt-5"
              onClick={() => {
                window.location.href = "/api/kite/login";
              }}
            >
              Connect with Zerodha
            </Button>
          </div>
        ) : (
          <LiveTradeWorkspace authMarket={market} />
        )}
      </main>
    </div>
  );
}
