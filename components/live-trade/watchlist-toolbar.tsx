"use client";

import type { LiveTradeGroupDto } from "@/lib/live-trade/client";
import type { LiveTradePriority } from "@/lib/live-trade/constants";
import { PRIORITY_META } from "@/lib/live-trade/ui";

export type GroupFilter = "ALL" | "UNGROUPED" | string;
export type PriorityFilter = "ALL" | LiveTradePriority;

interface WatchlistToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  groupFilter: GroupFilter;
  onGroupFilterChange: (value: GroupFilter) => void;
  priorityFilter: PriorityFilter;
  onPriorityFilterChange: (value: PriorityFilter) => void;
  groups: LiveTradeGroupDto[];
  total: number;
  shown: number;
  onManageGroups: () => void;
  onClearFilters: () => void;
}

const selectClass =
  "rounded-lg border border-slate-700/60 bg-slate-900/70 px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500/60";

export function WatchlistToolbar({
  search,
  onSearchChange,
  groupFilter,
  onGroupFilterChange,
  priorityFilter,
  onPriorityFilterChange,
  groups,
  total,
  shown,
  onManageGroups,
  onClearFilters,
}: WatchlistToolbarProps) {
  const hasFilters =
    search.trim() !== "" || groupFilter !== "ALL" || priorityFilter !== "ALL";

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500">
              <svg
                className="h-3.5 w-3.5"
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
              id="live-trade-watchlist-search"
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search watchlist"
              aria-label="Search watchlist by symbol, company or notes"
              className="w-full rounded-lg border border-slate-700/60 bg-slate-900/70 py-1.5 pl-8 pr-3 text-xs text-slate-300 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/60"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-[10px] text-slate-500">
              Group
              <select
                value={groupFilter}
                onChange={(event) =>
                  onGroupFilterChange(event.target.value as GroupFilter)
                }
                aria-label="Filter watchlist by group"
                className={selectClass}
              >
                <option value="ALL">All groups</option>
                <option value="UNGROUPED">Ungrouped</option>
                {groups.map((group) => (
                  <option key={group.groupId} value={group.groupId}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1.5 text-[10px] text-slate-500">
              Priority
              <select
                value={priorityFilter}
                onChange={(event) =>
                  onPriorityFilterChange(event.target.value as PriorityFilter)
                }
                aria-label="Filter watchlist by priority"
                className={selectClass}
              >
                <option value="ALL">All priorities</option>
                {(["HIGH", "MEDIUM", "LOW"] as const).map((priority) => (
                  <option key={priority} value={priority}>
                    {PRIORITY_META[priority].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500">
            Showing {shown} of {total}
          </span>
          {hasFilters && (
            <button
              type="button"
              onClick={onClearFilters}
              className="rounded-md border border-slate-700/50 bg-slate-800/40 px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-700/50 hover:text-slate-200"
            >
              Clear filters
            </button>
          )}
          <button
            type="button"
            onClick={onManageGroups}
            className="rounded-md border border-slate-700/50 bg-slate-800/40 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700/50"
          >
            Manage groups
          </button>
        </div>
      </div>
    </div>
  );
}
