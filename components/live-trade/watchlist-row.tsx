"use client";

import { memo } from "react";
import type {
  LiveTradeGroupDto,
  LiveTradeItemDto,
  LiveTradeQuoteDto,
  LiveTradeZoneSummaryDto,
} from "@/lib/live-trade/client";
import type { QuoteDisplayState } from "@/hooks/use-live-trade-quotes";
import {
  PRIORITY_META,
  STATUS_LABEL,
  directionLabel,
  formatPrice,
} from "@/lib/live-trade/ui";
import { cn } from "@/lib/utils";
import { QuoteDisplay } from "./quote-display";
import { ZoneSummary } from "./zone-summary";

interface WatchlistRowProps {
  item: LiveTradeItemDto;
  groupName: string | null;
  summary: LiveTradeZoneSummaryDto | undefined;
  quote: LiveTradeQuoteDto | undefined;
  quoteDisplayState: QuoteDisplayState;
  zonesAvailable: boolean;
  zonesLoading: boolean;
  zonesError: boolean;
  quoteLoading: boolean;
  groups: LiveTradeGroupDto[];
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onExpandZones: () => void;
  onMoveGroup: (groupId: string | null) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
  tone = "neutral",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  tone?: "neutral" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md border border-slate-700/50 bg-slate-800/40 p-1.5 transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-30",
        tone === "danger"
          ? "text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
          : "text-slate-400 hover:bg-slate-700/50 hover:text-slate-200"
      )}
    >
      {children}
    </button>
  );
}

function PlanValue({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-slate-600">
        {label}
      </p>
      <p
        className={cn(
          "tabular-nums",
          value === null ? "text-xs text-slate-600" : "text-sm text-slate-200"
        )}
      >
        {value === null ? "Not set" : formatPrice(value)}
      </p>
    </div>
  );
}

function WatchlistRowComponent({
  item,
  groupName,
  summary,
  quote,
  quoteDisplayState,
  zonesAvailable,
  zonesLoading,
  zonesError,
  quoteLoading,
  groups,
  busy,
  canMoveUp,
  canMoveDown,
  onEdit,
  onDelete,
  onExpandZones,
  onMoveGroup,
  onMoveUp,
  onMoveDown,
}: WatchlistRowProps) {
  const priority = PRIORITY_META[item.priority];

  return (
    <article
      aria-label={`${item.symbol} watchlist item`}
      aria-busy={busy}
      data-testid={`watchlist-item-${item.symbol}`}
      className="rounded-xl border border-slate-700/50 bg-slate-800/30 transition-colors hover:border-slate-600/60"
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-bold text-slate-100">
                {item.symbol}
              </span>
              <span
                className={cn(
                  "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                  priority.className
                )}
              >
                {priority.label}
              </span>
              {item.direction && (
                <span
                  className={cn(
                    "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                    item.direction === "BUY"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : "border-rose-500/30 bg-rose-500/10 text-rose-400"
                  )}
                >
                  {directionLabel(item.direction)}
                </span>
              )}
              <span className="rounded border border-slate-700/50 bg-slate-900/50 px-1.5 py-0.5 text-[10px] text-slate-400">
                {item.timeframe ?? "Any TF"}
              </span>
              <span className="text-[10px] text-slate-500">
                {STATUS_LABEL[item.tradeStatus]}
              </span>
              {busy && <span className="scanner-spinner text-slate-400" />}
            </div>

            <p className="truncate text-xs text-slate-500" title={item.companyName ?? undefined}>
              {item.companyName ?? "Company name unavailable"}
            </p>

            <label className="flex items-center gap-1.5 text-[10px] text-slate-500">
              Group
              <select
                value={item.groupId ?? ""}
                disabled={busy}
                onChange={(event) =>
                  onMoveGroup(event.target.value === "" ? null : event.target.value)
                }
                aria-label={`Move ${item.symbol} to another group`}
                className="rounded-md border border-slate-700/60 bg-slate-900/70 px-1.5 py-0.5 text-[10px] text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500/60 disabled:opacity-50"
              >
                <option value="">Ungrouped</option>
                {groups.map((group) => (
                  <option key={group.groupId} value={group.groupId}>
                    {group.name}
                  </option>
                ))}
              </select>
              {groupName && (
                <span className="text-slate-600">· {groupName}</span>
              )}
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-1">
            <IconButton
              label={`Move ${item.symbol} up`}
              onClick={onMoveUp}
              disabled={busy || !canMoveUp}
            >
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <polyline points="18 15 12 9 6 15" />
              </svg>
            </IconButton>
            <IconButton
              label={`Move ${item.symbol} down`}
              onClick={onMoveDown}
              disabled={busy || !canMoveDown}
            >
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </IconButton>
            <button
              type="button"
              onClick={onExpandZones}
              className="rounded-md border border-slate-700/50 bg-slate-800/40 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700/50"
            >
              Zones
            </button>
            <button
              type="button"
              onClick={onEdit}
              className="rounded-md border border-slate-700/50 bg-slate-800/40 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700/50"
            >
              Edit
            </button>
            <IconButton
              label={`Remove ${item.symbol} from watchlist`}
              onClick={onDelete}
              tone="danger"
            >
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
              </svg>
            </IconButton>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,0.95fr)_minmax(0,1.6fr)]">
          <section aria-label="Trade plan" className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-600">
              Trade plan
            </p>
            <div className="grid grid-cols-3 gap-2">
              <PlanValue label="Entry" value={item.entryPrice} />
              <PlanValue label="Target" value={item.targetPrice} />
              <PlanValue label="Stop" value={item.stopLoss} />
            </div>
            <p className="text-[10px] text-slate-600">
              Planned levels only — not an order or a recommendation.
            </p>
          </section>

          <section aria-label="Latest quote" className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-600">
              Latest quote
            </p>
            <QuoteDisplay
              quote={quote}
              displayState={quoteDisplayState}
              loading={quoteLoading}
              compact
            />
          </section>

          <section aria-label="Demand and supply zones">
            <ZoneSummary
              summary={summary}
              quote={quote}
              zonesAvailable={zonesAvailable}
              displayState={quoteDisplayState}
              zonesLoading={zonesLoading}
              zonesError={zonesError}
            />
          </section>
        </div>

        {item.notes.trim() !== "" && (
          <details className="border-t border-slate-700/40 pt-2">
            <summary className="cursor-pointer select-none text-[11px] text-slate-500 hover:text-slate-300">
              Notes
            </summary>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
              {item.notes}
            </p>
          </details>
        )}
      </div>
    </article>
  );
}

/**
 * A row re-renders only when its own data changes. Callback identities are
 * ignored because Watchlist recreates them per render: the reorder handlers
 * go through a latest-handler ref, and every other handler acts on the item
 * id against the board state at execution time, so a memoised row can never
 * invoke an obsolete handler.
 */
function sameRowProps(
  previous: WatchlistRowProps,
  next: WatchlistRowProps
): boolean {
  return (
    previous.item === next.item &&
    previous.groupName === next.groupName &&
    previous.summary === next.summary &&
    previous.quote === next.quote &&
    previous.quoteDisplayState === next.quoteDisplayState &&
    previous.zonesAvailable === next.zonesAvailable &&
    previous.zonesLoading === next.zonesLoading &&
    previous.zonesError === next.zonesError &&
    previous.quoteLoading === next.quoteLoading &&
    previous.groups === next.groups &&
    previous.busy === next.busy &&
    previous.canMoveUp === next.canMoveUp &&
    previous.canMoveDown === next.canMoveDown
  );
}

export const WatchlistRow = memo(WatchlistRowComponent, sameRowProps);
