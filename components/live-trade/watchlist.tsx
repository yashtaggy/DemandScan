"use client";

import { useEffect, useRef } from "react";
import type {
  LiveTradeGroupDto,
  LiveTradeItemDto,
  LiveTradeQuoteDto,
  LiveTradeZoneSummaryDto,
} from "@/lib/live-trade/client";
import type { QuoteDisplayState } from "@/hooks/use-live-trade-quotes";
import { WatchlistRow } from "./watchlist-row";

interface WatchlistProps {
  items: LiveTradeItemDto[];
  groups: LiveTradeGroupDto[];
  summaries: Map<number, LiveTradeZoneSummaryDto>;
  quotes: Record<number, LiveTradeQuoteDto>;
  quoteDisplayState: QuoteDisplayState;
  zonesAvailable: boolean;
  zonesLoading: boolean;
  zonesError: boolean;
  quoteLoading: boolean;
  busyItemIds: ReadonlySet<string>;
  onEdit: (item: LiveTradeItemDto) => void;
  onDelete: (item: LiveTradeItemDto) => void;
  onExpandZones: (item: LiveTradeItemDto) => void;
  onMoveGroup: (item: LiveTradeItemDto, groupId: string | null) => void;
  onReorder: (item: LiveTradeItemDto, direction: "up" | "down") => void;
}

export function Watchlist({
  items,
  groups,
  summaries,
  quotes,
  quoteDisplayState,
  zonesAvailable,
  zonesLoading,
  zonesError,
  quoteLoading,
  busyItemIds,
  onEdit,
  onDelete,
  onExpandZones,
  onMoveGroup,
  onReorder,
}: WatchlistProps) {
  const groupNames = new Map(groups.map((group) => [group.groupId, group.name]));

  // Rows are memoised on data only, so a row can keep the reorder handlers
  // from an earlier render. Routing them through the latest handler means a
  // retained row still moves relative to the current list.
  const reorderRef = useRef(onReorder);
  useEffect(() => {
    reorderRef.current = onReorder;
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">Watchlist</h2>
        <p className="text-[10px] text-slate-600">
          Order is saved on the server. Arrows reorder within the visible list.
        </p>
      </div>

      <div className="space-y-2">
        {items.map((item, index) => (
          <WatchlistRow
            key={item.itemId}
            item={item}
            groupName={
              item.groupId ? groupNames.get(item.groupId) ?? null : null
            }
            summary={summaries.get(item.instrumentId)}
            quote={quotes[item.instrumentId]}
            quoteDisplayState={quoteDisplayState}
            zonesAvailable={zonesAvailable}
            zonesLoading={zonesLoading}
            zonesError={zonesError}
            quoteLoading={quoteLoading}
            groups={groups}
            busy={busyItemIds.has(item.itemId)}
            canMoveUp={index > 0}
            canMoveDown={index < items.length - 1}
            onEdit={() => onEdit(item)}
            onDelete={() => onDelete(item)}
            onExpandZones={() => onExpandZones(item)}
            onMoveGroup={(groupId) => onMoveGroup(item, groupId)}
            onMoveUp={() => reorderRef.current(item, "up")}
            onMoveDown={() => reorderRef.current(item, "down")}
          />
        ))}
      </div>
    </div>
  );
}
