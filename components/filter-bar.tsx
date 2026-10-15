"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

interface FilterBarProps {
  search: string;
  onSearchChange: (v: string) => void;
  filter: "all" | "positive" | "negative";
  onFilterChange: (v: "all" | "positive" | "negative") => void;
  minChange: number;
  onMinChangeChange: (v: number) => void;
  refreshInterval: number;
  onRefreshIntervalChange: (v: number) => void;
  onRefresh: () => void;
  loading: boolean;
}

const REFRESH_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "30s", value: 30_000 },
  { label: "1m", value: 60_000 },
  { label: "5m", value: 300_000 },
];

export function FilterBar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  minChange,
  onMinChangeChange,
  refreshInterval,
  onRefreshIntervalChange,
  onRefresh,
  loading,
}: FilterBarProps) {
  const [minChangeInput, setMinChangeInput] = useState(minChange > 0 ? String(minChange) : "");

  const handleMinChangeBlur = () => {
    const n = parseFloat(minChangeInput);
    onMinChangeChange(isNaN(n) || n < 0 ? 0 : n);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <svg
            className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            id="search-input"
            type="text"
            placeholder="Search symbol or name…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value.toUpperCase())}
            className="w-full rounded-lg border border-slate-700 bg-slate-800/60 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-colors"
          />
          {search && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              id="clear-search-button"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Direction filter */}
        <div className="flex rounded-lg border border-slate-700 overflow-hidden text-sm">
          {(["all", "positive", "negative"] as const).map((f) => (
            <button
              key={f}
              id={`filter-${f}`}
              onClick={() => onFilterChange(f)}
              className={`px-3 py-2 capitalize transition-colors ${
                filter === f
                  ? f === "positive"
                    ? "bg-emerald-600/30 text-emerald-400"
                    : f === "negative"
                    ? "bg-rose-600/30 text-rose-400"
                    : "bg-slate-700 text-slate-100"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-700/50"
              }`}
            >
              {f === "all" ? "All" : f === "positive" ? "↑ Gainers" : "↓ Losers"}
            </button>
          ))}
        </div>

        {/* Min % change */}
        <div className="flex items-center gap-2">
          <label htmlFor="min-change-input" className="text-xs text-slate-500 shrink-0">
            Min %
          </label>
          <input
            id="min-change-input"
            type="number"
            min="0"
            step="0.5"
            placeholder="0"
            value={minChangeInput}
            onChange={(e) => setMinChangeInput(e.target.value)}
            onBlur={handleMinChangeBlur}
            className="w-20 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-colors"
          />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Auto-refresh */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 hidden sm:inline">Auto-refresh</span>
          <div className="flex rounded-lg border border-slate-700 overflow-hidden text-xs">
            {REFRESH_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                id={`refresh-${opt.label.toLowerCase()}`}
                onClick={() => onRefreshIntervalChange(opt.value)}
                className={`px-2.5 py-2 transition-colors ${
                  refreshInterval === opt.value
                    ? "bg-indigo-600/30 text-indigo-400"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-700/50"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Manual refresh */}
        <Button
          variant="secondary"
          size="sm"
          onClick={onRefresh}
          loading={loading}
          id="manual-refresh-button"
        >
          {!loading && (
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          )}
          Refresh
        </Button>
      </div>
    </div>
  );
}
