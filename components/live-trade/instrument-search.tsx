"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { LiveTradeItemDto } from "@/lib/live-trade/client";
import { liveTradeErrorMessage } from "@/lib/live-trade/client";
import {
  useInstrumentSearch,
  type InstrumentSearchResult,
} from "@/hooks/use-instrument-search";
import { formatDateOnly } from "@/lib/live-trade/ui";

interface InstrumentSearchProps {
  items: LiveTradeItemDto[];
  enabled: boolean;
  atLimit: boolean;
  activeGroupId: string | null;
  onAdd: (
    instrument: InstrumentSearchResult,
    groupId: string | null
  ) => Promise<void>;
}

export function InstrumentSearch({
  items,
  enabled,
  atLimit,
  activeGroupId,
  onAdd,
}: InstrumentSearchProps) {
  const [query, setQuery] = useState("");
  const [addingId, setAddingId] = useState<number | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const { results, master, resultQuery, loading, error } = useInstrumentSearch(
    query,
    enabled
  );

  const entryCounts = new Map<number, number>();
  for (const item of items) {
    entryCounts.set(
      item.instrumentId,
      (entryCounts.get(item.instrumentId) ?? 0) + 1
    );
  }
  const trimmed = query.trim();
  const showEmpty =
    trimmed !== "" &&
    resultQuery === trimmed &&
    !loading &&
    error === null &&
    results.length === 0;

  async function handleAdd(instrument: InstrumentSearchResult) {
    setAddingId(instrument.instrumentId);
    setAddError(null);
    try {
      await onAdd(instrument, activeGroupId);
    } catch (cause) {
      setAddError(liveTradeErrorMessage(cause));
    } finally {
      setAddingId(null);
    }
  }

  return (
    <section
      aria-labelledby="instrument-search-heading"
      className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2
            id="instrument-search-heading"
            className="text-sm font-semibold text-slate-200"
          >
            Add instruments
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Search active NSE symbols or company names. Selecting a symbol again
            adds a separate trade entry.
          </p>
        </div>
        <span className="text-xs text-slate-500">
          {items.length} / 200 trade entries
        </span>
      </div>

      <div className="relative mt-3">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </span>
        <input
          id="live-trade-instrument-search"
          type="search"
          value={query}
          maxLength={50}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. INFY or Infosys"
          aria-label="Search NSE instruments to add"
          onChange={(event) => {
            setQuery(event.target.value);
            setAddError(null);
          }}
          className="w-full rounded-lg border border-slate-700/60 bg-slate-900/70 py-2 pl-9 pr-9 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/60"
        />
        {query !== "" && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear instrument search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:bg-slate-700/50 hover:text-slate-300"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {atLimit && (
        <p className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-400">
          Your board has reached the 200 trade-entry limit. Remove a trade
          entry before adding another.
        </p>
      )}

      {addError && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 text-xs text-rose-300"
        >
          {addError}
        </p>
      )}

      {loading && (
        <div className="mt-3 space-y-1.5" aria-label="Searching instruments">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="h-11 animate-pulse rounded-lg bg-slate-700/30"
            />
          ))}
        </div>
      )}

      {!loading && error && (
        <p className="mt-3 text-xs text-rose-300">
          {liveTradeErrorMessage(error)}
        </p>
      )}

      {!loading && !error && results.length > 0 && (
        <ul
          className="mt-3 max-h-72 divide-y divide-slate-700/40 overflow-y-auto rounded-lg border border-slate-700/40"
          aria-label="Instrument search results"
        >
          {results.map((instrument) => {
            const entryCount =
              entryCounts.get(instrument.instrumentId) ?? 0;
            const adding = addingId === instrument.instrumentId;
            return (
              <li
                key={instrument.instrumentId}
                className="flex items-center justify-between gap-3 bg-slate-900/40 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-slate-200">
                      {instrument.symbol}
                    </span>
                    <Badge variant="neutral">{instrument.exchange}</Badge>
                    {entryCount > 0 && (
                      <Badge variant="neutral">
                        {entryCount === 1
                          ? "1 entry on board"
                          : `${entryCount} entries on board`}
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-slate-500">
                    {instrument.name ?? "Company name unavailable"}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  loading={adding}
                  disabled={atLimit || addingId !== null}
                  onClick={() => void handleAdd(instrument)}
                  aria-label={
                    entryCount > 0
                      ? `Add another ${instrument.symbol} trade entry`
                      : `Add ${instrument.symbol} to watchlist`
                  }
                >
                  {entryCount > 0 ? "Add trade" : "Add"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {showEmpty && (
        <p className="mt-3 text-xs text-slate-500">
          No active NSE instruments match “{trimmed}”.
        </p>
      )}

      {master && (
        <p className="mt-2 text-[10px] text-slate-600">
          Instrument list last updated{" "}
          {formatDateOnly(master.latestInstrumentUpdateAt)} ·{" "}
          {master.activeInstrumentCount.toLocaleString("en-IN")} active
          instruments · freshness unknown
        </p>
      )}
    </section>
  );
}
