"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  createGroup,
  createItem,
  deleteGroup,
  deleteItem,
  isLiveTradeClientError,
  liveTradeErrorMessage,
  reorderGroups,
  reorderItems,
  updateGroup,
  updateItem,
  type LiveTradeItemDto,
  type UpdateItemPayload,
} from "@/lib/live-trade/client";
import { LIVE_TRADE_ITEM_LIMIT } from "@/lib/live-trade/constants";
import { formatCount } from "@/lib/live-trade/ui";
import { useLiveTradeBoard } from "@/hooks/use-live-trade-board";
import { useLiveTradeQuotes } from "@/hooks/use-live-trade-quotes";
import type { InstrumentSearchResult } from "@/hooks/use-instrument-search";
import { InstrumentSearch } from "./instrument-search";
import { ItemEditor } from "./item-editor";
import { GroupManager } from "./group-manager";
import { ExpandedZones } from "./expanded-zones";
import { ConfirmDialog } from "./confirm-dialog";
import { CoverageGuide } from "./coverage-guide";
import { ToastViewport, useToasts } from "./toast";
import {
  WatchlistToolbar,
  type GroupFilter,
  type PriorityFilter,
} from "./watchlist-toolbar";
import { Watchlist } from "./watchlist";
import {
  WorkspaceHeader,
  type MarketStatusView,
  type QuoteSummaryView,
} from "./workspace-header";

interface LiveTradeWorkspaceProps {
  authMarket: MarketStatusView | null;
}

function WorkspaceSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading Live Trade workspace">
      <div className="h-36 animate-pulse rounded-2xl bg-slate-800/40" />
      <div className="h-10 animate-pulse rounded-lg bg-slate-800/30" />
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="h-44 animate-pulse rounded-xl bg-slate-800/30"
        />
      ))}
    </div>
  );
}

function ReconnectLink() {
  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      onClick={() => {
        window.location.href = "/api/kite/login";
      }}
    >
      Reconnect Zerodha
    </Button>
  );
}

export function LiveTradeWorkspace({ authMarket }: LiveTradeWorkspaceProps) {
  const { board, loading, refreshing, error, refetch } =
    useLiveTradeBoard(true);
  const { toasts, push, dismiss } = useToasts();

  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("ALL");
  const [priorityFilter, setPriorityFilter] =
    useState<PriorityFilter>("ALL");
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);

  const items = useMemo(() => board?.items ?? [], [board]);
  const groups = board?.groups ?? [];

  const instrumentIds = useMemo(
    () => items.map((item) => item.instrumentId),
    [items]
  );

  const {
    quotes,
    market: quoteMarket,
    fetchedAt,
    zonesAvailable,
    loading: quotesLoading,
    refreshing: quotesRefreshing,
    error: quoteError,
    displayState,
    cooldownSecondsLeft,
    refresh: refreshQuotes,
  } = useLiveTradeQuotes(instrumentIds, instrumentIds.length > 0);

  const summaries = useMemo(
    () =>
      new Map(
        (board?.zones.summaries ?? []).map((summary) => [
          summary.instrumentId,
          summary,
        ])
      ),
    [board]
  );

  const filteredItems = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((item) => {
      if (groupFilter === "UNGROUPED" && item.groupId !== null) return false;
      if (
        groupFilter !== "ALL" &&
        groupFilter !== "UNGROUPED" &&
        item.groupId !== groupFilter
      ) {
        return false;
      }
      if (priorityFilter !== "ALL" && item.priority !== priorityFilter) {
        return false;
      }
      if (needle === "") return true;
      return (
        item.symbol.toLowerCase().includes(needle) ||
        (item.companyName ?? "").toLowerCase().includes(needle) ||
        item.notes.toLowerCase().includes(needle)
      );
    });
  }, [items, search, groupFilter, priorityFilter]);

  const quoteSummary = useMemo<QuoteSummaryView>(() => {
    let live = 0;
    let delayed = 0;
    let lastClose = 0;
    let unavailable = 0;
    for (const quote of Object.values(quotes)) {
      if (quote.freshness === "LIVE") live += 1;
      else if (quote.freshness === "DELAYED") delayed += 1;
      else if (quote.freshness === "LAST_CLOSE") lastClose += 1;
      else unavailable += 1;
    }
    return {
      total: items.length,
      live,
      delayed,
      lastClose,
      unavailable,
    };
  }, [quotes, items.length]);

  const editingItem = items.find((item) => item.itemId === editingItemId) ?? null;
  const deleteTarget = items.find((item) => item.itemId === deleteItemId) ?? null;
  const expandedItem =
    items.find((item) => item.itemId === expandedItemId) ?? null;

  const activeGroupId =
    groupFilter !== "ALL" && groupFilter !== "UNGROUPED" ? groupFilter : null;

  const hasFilters =
    search.trim() !== "" || groupFilter !== "ALL" || priorityFilter !== "ALL";

  async function handleAdd(
    instrument: InstrumentSearchResult,
    groupId: string | null
  ) {
    await createItem({ instrumentId: instrument.instrumentId, groupId });
    await refetch();
    push("success", `${instrument.symbol} added to your board.`);
  }

  async function handleSave(
    item: LiveTradeItemDto,
    payload: UpdateItemPayload
  ) {
    await updateItem(item.itemId, payload);
    await refetch();
    setEditingItemId(null);
    push("success", `${item.symbol} updated.`);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeletePending(true);
    setBusyItemId(deleteTarget.itemId);
    try {
      await deleteItem(deleteTarget.itemId, deleteTarget.version);
      await refetch();
      setDeleteItemId(null);
      push("success", `${deleteTarget.symbol} removed from your board.`);
    } catch (cause) {
      push("error", liveTradeErrorMessage(cause));
    } finally {
      setDeletePending(false);
      setBusyItemId(null);
    }
  }

  function handleReorder(item: LiveTradeItemDto, direction: "up" | "down") {
    const visibleIndex = filteredItems.findIndex(
      (candidate) => candidate.itemId === item.itemId
    );
    const neighbour = filteredItems[visibleIndex + (direction === "up" ? -1 : 1)];
    if (!neighbour) return;

    const orderedIds = items.map((candidate) => candidate.itemId);
    const from = orderedIds.indexOf(item.itemId);
    const to = orderedIds.indexOf(neighbour.itemId);
    if (from < 0 || to < 0) return;
    orderedIds.splice(from, 1);
    orderedIds.splice(to, 0, item.itemId);

    setBusyItemId(item.itemId);
    reorderItems(orderedIds)
      .then(async () => {
        await refetch();
      })
      .catch(async (cause: unknown) => {
        push("error", liveTradeErrorMessage(cause));
        if (
          isLiveTradeClientError(cause) &&
          (cause.code === "REORDER_STALE" || cause.code === "EDIT_CONFLICT")
        ) {
          await refetch();
        }
      })
      .finally(() => {
        setBusyItemId(null);
      });
  }

  async function handleMoveGroup(
    item: LiveTradeItemDto,
    groupId: string | null
  ) {
    setBusyItemId(item.itemId);
    try {
      await updateItem(item.itemId, { version: item.version, groupId });
      await refetch();
      push("success", `${item.symbol} moved.`);
    } catch (cause) {
      push("error", liveTradeErrorMessage(cause));
      if (isLiveTradeClientError(cause) && cause.code === "EDIT_CONFLICT") {
        await refetch();
      }
    } finally {
      setBusyItemId(null);
    }
  }

  async function handleCreateGroup(name: string) {
    await createGroup(name);
    await refetch();
    push("success", `Group “${name}” created.`);
  }

  async function handleRenameGroup(
    group: { groupId: string; name: string; version: number },
    name: string
  ) {
    await updateGroup(group.groupId, name, group.version);
    await refetch();
    push("success", "Group renamed.");
  }

  async function handleDeleteGroup(group: { groupId: string; version: number }) {
    await deleteGroup(group.groupId, group.version);
    if (groupFilter === group.groupId) setGroupFilter("ALL");
    await refetch();
    push("success", "Group deleted. Its instruments are now ungrouped.");
  }

  async function handleReorderGroups(orderedGroupIds: string[]) {
    await reorderGroups(orderedGroupIds);
    await refetch();
  }

  const sessionExpired =
    error?.status === 401 || displayState === "sign-in";

  return (
    <div className="space-y-4">
      <WorkspaceHeader
        instrumentCount={items.length}
        groupCount={groups.length}
        market={quoteMarket ?? authMarket}
        fetchedAt={fetchedAt}
        quoteSummary={quoteSummary}
        quotesLoading={quotesLoading}
        quotesRefreshing={quotesRefreshing}
        quoteError={quoteError ? liveTradeErrorMessage(quoteError) : null}
        displayState={displayState}
        cooldownSecondsLeft={cooldownSecondsLeft}
        onRefreshQuotes={refreshQuotes}
      />

      {sessionExpired && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="text-sm font-medium text-amber-300">
              Your Kite session needs attention
            </p>
            <p className="mt-0.5 text-xs text-amber-400/80">
              Board changes and quotes require a connected session. Existing
              data stays visible but may be out of date.
            </p>
          </div>
          <ReconnectLink />
        </div>
      )}

      {error && !sessionExpired && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border border-rose-500/25 bg-rose-500/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="text-sm font-medium text-rose-300">
              {board ? "The workspace could not be refreshed" : "The workspace could not be loaded"}
            </p>
            <p className="mt-0.5 text-xs text-rose-300/80">
              {liveTradeErrorMessage(error)}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={refreshing || loading}
            onClick={() => void refetch()}
          >
            Try again
          </Button>
        </div>
      )}

      {loading && !board ? (
        <WorkspaceSkeleton />
      ) : !board ? (
        <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 px-4 py-10 text-center">
          <p className="text-sm text-slate-400">
            The workspace is unavailable right now.
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="rounded-xl border border-dashed border-slate-700/60 bg-slate-800/20 px-5 py-10 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/10">
              <svg
                className="h-6 w-6 text-indigo-400"
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
            <h2 className="mt-3 text-sm font-semibold text-slate-200">
              Your board is empty
            </h2>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
              Search for an active NSE stock to start planning. Adding an
              instrument only saves it to your personal board — it never places
              an order.
            </p>
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setGroupManagerOpen(true)}
              >
                Create groups
              </Button>
            </div>
          </section>

          <div className="space-y-4">
            <InstrumentSearch
              items={items}
              enabled
              atLimit={items.length >= LIVE_TRADE_ITEM_LIMIT}
              activeGroupId={activeGroupId}
              onAdd={handleAdd}
            />
            <CoverageGuide />
          </div>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-3">
            <WatchlistToolbar
              search={search}
              onSearchChange={setSearch}
              groupFilter={groupFilter}
              onGroupFilterChange={setGroupFilter}
              priorityFilter={priorityFilter}
              onPriorityFilterChange={setPriorityFilter}
              groups={groups}
              total={items.length}
              shown={filteredItems.length}
              onManageGroups={() => setGroupManagerOpen(true)}
              onClearFilters={() => {
                setSearch("");
                setGroupFilter("ALL");
                setPriorityFilter("ALL");
              }}
            />

            {refreshing && (
              <p
                role="status"
                className="text-[11px] text-slate-500"
              >
                Refreshing board…
              </p>
            )}

            {filteredItems.length === 0 ? (
              <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 px-4 py-10 text-center">
                <p className="text-sm text-slate-400">
                  No instruments match these filters.
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {formatCount(items.length)} instruments are tracked in total.
                </p>
                {hasFilters && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      setSearch("");
                      setGroupFilter("ALL");
                      setPriorityFilter("ALL");
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            ) : (
              <Watchlist
                items={filteredItems}
                groups={groups}
                summaries={summaries}
                quotes={quotes}
                quoteDisplayState={displayState}
                zonesAvailable={zonesAvailable}
                quoteLoading={quotesLoading}
                busyItemId={busyItemId}
                onEdit={(item) => setEditingItemId(item.itemId)}
                onDelete={(item) => setDeleteItemId(item.itemId)}
                onExpandZones={(item) => setExpandedItemId(item.itemId)}
                onMoveGroup={(item, groupId) =>
                  void handleMoveGroup(item, groupId)
                }
                onReorder={handleReorder}
              />
            )}

            <CoverageGuide />
          </div>

          <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
            <InstrumentSearch
              items={items}
              enabled
              atLimit={items.length >= LIVE_TRADE_ITEM_LIMIT}
              activeGroupId={activeGroupId}
              onAdd={handleAdd}
            />
            {groups.length === 0 && (
              <p className="rounded-xl border border-slate-700/40 bg-slate-800/20 px-4 py-3 text-[11px] leading-relaxed text-slate-500">
                No groups yet. Use “Manage groups” to organise the watchlist;
                instruments stay on the board when groups change.
              </p>
            )}
          </aside>
        </div>
      )}

      {editingItem && (
        <ItemEditor
          key={editingItem.itemId}
          item={editingItem}
          groups={groups}
          onClose={() => setEditingItemId(null)}
          onSave={handleSave}
          onConflictReload={refetch}
        />
      )}

      {expandedItem && (
        <ExpandedZones
          item={expandedItem}
          summary={summaries.get(expandedItem.instrumentId)}
          onClose={() => setExpandedItemId(null)}
        />
      )}

      {groupManagerOpen && (
        <GroupManager
          groups={groups}
          onClose={() => setGroupManagerOpen(false)}
          onCreate={handleCreateGroup}
          onRename={handleRenameGroup}
          onDelete={handleDeleteGroup}
          onReorder={handleReorderGroups}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title={
          deleteTarget
            ? `Remove ${deleteTarget.symbol} from your board?`
            : "Remove instrument"
        }
        description={
          deleteTarget
            ? `${deleteTarget.symbol} will be removed from your Live Trade board along with its saved plan. Scanner zones and market data are not affected.`
            : ""
        }
        confirmLabel="Remove"
        destructive
        pending={deletePending}
        onConfirm={() => void handleDelete()}
        onCancel={() => {
          if (!deletePending) setDeleteItemId(null);
        }}
      />

      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
