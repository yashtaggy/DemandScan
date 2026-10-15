"use client";

import { cn, formatINR, formatVolume, formatPercent, formatDateTime, changeColor } from "@/lib/utils";
import { StockTableSkeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { StockRow } from "@/lib/types";

// ─── Column definitions ───────────────────────────────────────────────────────

type SortField = "symbol" | "price" | "change" | "changePercent" | "volume";

interface Column {
  key: SortField | "name" | "lastUpdated";
  label: string;
  sortable: boolean;
  className: string;
  headerClassName?: string;
}

const COLUMNS: Column[] = [
  { key: "symbol", label: "Symbol", sortable: true, className: "w-28", headerClassName: "text-left" },
  { key: "name", label: "Company", sortable: false, className: "min-w-0 flex-1", headerClassName: "text-left" },
  { key: "price", label: "LTP", sortable: true, className: "w-28 text-right", headerClassName: "text-right" },
  { key: "change", label: "Change", sortable: true, className: "w-28 text-right", headerClassName: "text-right" },
  { key: "changePercent", label: "% Change", sortable: true, className: "w-28 text-right", headerClassName: "text-right" },
  { key: "volume", label: "Volume", sortable: true, className: "w-28 text-right hidden lg:table-cell", headerClassName: "text-right hidden lg:table-cell" },
  { key: "lastUpdated", label: "Updated", sortable: false, className: "w-28 text-right hidden xl:table-cell", headerClassName: "text-right hidden xl:table-cell" },
];

// ─── Sort icon ────────────────────────────────────────────────────────────────

function SortIcon({ field, currentSort, currentOrder }: {
  field: string;
  currentSort: string;
  currentOrder: string;
}) {
  if (field !== currentSort) {
    return (
      <svg className="h-3 w-3 text-slate-600" viewBox="0 0 16 16" fill="currentColor">
        <path d="M5 8l3-5 3 5H5zm0 0l3 5 3-5H5z" />
      </svg>
    );
  }
  return currentOrder === "asc" ? (
    <svg className="h-3 w-3 text-indigo-400" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 4l-4 6h8L8 4z" />
    </svg>
  ) : (
    <svg className="h-3 w-3 text-indigo-400" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 12l4-6H4l4 6z" />
    </svg>
  );
}

// ─── Stock table props ────────────────────────────────────────────────────────

interface StockTableProps {
  stocks: StockRow[];
  loading: boolean;
  error: string | null;
  sort: SortField;
  order: "asc" | "desc";
  onSort: (field: SortField) => void;
  onRowClick?: (stock: StockRow) => void;
  onRetry?: () => void;
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
}

// ─── Main table ───────────────────────────────────────────────────────────────

export function StockTable({
  stocks,
  loading,
  error,
  sort,
  order,
  onSort,
  onRowClick,
  onRetry,
  page,
  totalPages,
  total,
  onPageChange,
}: StockTableProps) {
  if (loading && stocks.length === 0) {
    return (
      <div className="space-y-2">
        <StockTableSkeleton rows={12} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/15">
          <svg className="h-6 w-6 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-slate-200">Failed to load stocks</p>
          <p className="text-xs text-slate-500 mt-1">{error}</p>
        </div>
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry} id="retry-button">
            Try again
          </Button>
        )}
      </div>
    );
  }

  if (!loading && stocks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-700/50">
          <svg className="h-6 w-6 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 0z" />
          </svg>
        </div>
        <p className="text-sm text-slate-500">No stocks match the current filters.</p>
      </div>
    );
  }

  const handleColumnClick = (col: Column) => {
    if (!col.sortable || col.key === "name" || col.key === "lastUpdated") return;
    onSort(col.key as SortField);
  };

  return (
    <div className="space-y-3">
      {/* Loading overlay when refreshing with existing data */}
      {loading && stocks.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <svg className="h-3 w-3 animate-spin text-indigo-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Refreshing…
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-slate-700/50">
        <table className="w-full text-sm" id="stock-table">
          <thead>
            <tr className="border-b border-slate-700/50 bg-slate-800/80">
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "px-4 py-3 font-medium text-slate-400 text-xs uppercase tracking-wider select-none",
                    col.headerClassName,
                    col.sortable && "cursor-pointer hover:text-slate-200 transition-colors"
                  )}
                  onClick={() => handleColumnClick(col)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.sortable && col.key !== "name" && col.key !== "lastUpdated" && (
                      <SortIcon field={col.key} currentSort={sort} currentOrder={order} />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/30">
            {stocks.map((stock, i) => (
              <StockRow
                key={stock.fullSymbol}
                stock={stock}
                index={i}
                onClick={onRowClick ? () => onRowClick(stock) : undefined}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500 text-xs">
            {total} stocks · Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              id="prev-page-button"
            >
              ‹ Prev
            </Button>
            {/* Show nearby page numbers */}
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              const pageNum = Math.max(1, Math.min(page - 2 + i, totalPages - 4 + i));
              return (
                <Button
                  key={pageNum}
                  variant={pageNum === page ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => onPageChange(pageNum)}
                  id={`page-${pageNum}-button`}
                >
                  {pageNum}
                </Button>
              );
            })}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
              id="next-page-button"
            >
              Next ›
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Individual row ───────────────────────────────────────────────────────────

function StockRow({
  stock,
  index,
  onClick,
}: {
  stock: StockRow;
  index: number;
  onClick?: () => void;
}) {
  const isPositive = stock.changePercent > 0;
  const isNegative = stock.changePercent < 0;

  return (
    <tr
      className={cn(
        "transition-colors duration-100",
        "hover:bg-slate-700/30",
        onClick && "cursor-pointer",
        !stock.hasQuote && "opacity-60"
      )}
      onClick={onClick}
      id={`stock-row-${stock.symbol}`}
    >
      {/* Symbol */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "h-1.5 w-1.5 rounded-full shrink-0",
              stock.hasQuote
                ? isPositive ? "bg-emerald-400" : isNegative ? "bg-rose-400" : "bg-slate-400"
                : "bg-slate-600"
            )}
          />
          <span className="font-mono font-semibold text-slate-100 text-xs tracking-wide">
            {stock.symbol}
          </span>
        </div>
      </td>

      {/* Company name */}
      <td className="px-4 py-3">
        <span className="text-slate-400 text-xs truncate max-w-[200px] block">
          {stock.name || "—"}
        </span>
      </td>

      {/* LTP */}
      <td className="px-4 py-3 text-right">
        <span className="font-mono text-slate-100 font-medium tabular-nums">
          {stock.hasQuote ? formatINR(stock.lastPrice) : "—"}
        </span>
      </td>

      {/* Change */}
      <td className="px-4 py-3 text-right">
        <span className={cn("font-mono tabular-nums text-sm", changeColor(stock.change))}>
          {stock.hasQuote
            ? `${stock.change >= 0 ? "+" : ""}${formatINR(stock.change)}`
            : "—"}
        </span>
      </td>

      {/* % Change */}
      <td className="px-4 py-3 text-right">
        <span
          className={cn(
            "inline-flex items-center justify-end gap-1 font-mono tabular-nums text-sm font-medium",
            changeColor(stock.changePercent)
          )}
        >
          {stock.hasQuote ? formatPercent(stock.changePercent) : "—"}
        </span>
      </td>

      {/* Volume */}
      <td className="px-4 py-3 text-right hidden lg:table-cell">
        <span className="font-mono text-slate-400 text-xs tabular-nums">
          {stock.hasQuote ? formatVolume(stock.volume) : "—"}
        </span>
      </td>

      {/* Last updated */}
      <td className="px-4 py-3 text-right hidden xl:table-cell">
        <span className="text-slate-600 text-xs">
          {formatDateTime(stock.lastUpdated || undefined)}
        </span>
      </td>
    </tr>
  );
}
