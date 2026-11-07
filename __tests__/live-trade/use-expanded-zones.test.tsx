/**
 * @jest-environment jsdom
 *
 * Paginated expanded zones and board retention:
 *  - the first page is requested on its own and further pages only on demand;
 *  - a failed zone read surfaces an error without discarding loaded pages;
 *  - changing instrument hides the previous instrument's pages immediately;
 *  - a failed board refresh keeps the last successful board in memory.
 */

import { act, renderHook } from "@testing-library/react";
import { useExpandedZones } from "@/hooks/use-expanded-zones";
import { useLiveTradeBoard } from "@/hooks/use-live-trade-board";

function zone(zoneId: string) {
  return {
    zoneId,
    instrumentId: 7,
    symbol: "INFY",
    side: "DEMAND",
    timeframe: "1D",
    pattern: "DBR",
    zoneLow: 1480.5,
    zoneHigh: 1502,
    proximal: 1502,
    distal: 1480.5,
    formationScore: 35,
    lifecycleState: "BROKEN",
    formationTs: "2026-11-04T00:00:00.000Z",
    createdAt: "2026-11-04T00:00:00.000Z",
    touchCount: 2,
    lastTouchTs: "2026-11-05T00:00:00.000Z",
  };
}

function zonesEnvelope(
  instrumentId: number,
  zones: ReturnType<typeof zone>[],
  offset: number,
  hasMore: boolean
) {
  return {
    success: true,
    data: {
      summaries: [],
      expanded: {
        instrumentId,
        symbol: "INFY",
        zones,
        pagination: {
          limit: 2,
          offset,
          page: Math.floor(offset / 2) + 1,
          returned: zones.length,
          hasMore,
          batchLimit: 5000,
        },
      },
      timeframeContext: { hasOverride: false, value: null },
      freshnessThresholdDays: 7,
      generatedAt: "2026-11-06T09:29:00.000Z",
    },
  };
}

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

function failure(status: number, code: string, message: string) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ success: false, code, error: message }),
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("useExpandedZones", () => {
  test("loads the first page, then appends the next page on demand", async () => {
    fetchMock
      .mockResolvedValueOnce(
        ok(zonesEnvelope(7, [zone("z1"), zone("z2")], 0, true))
      )
      .mockResolvedValueOnce(ok(zonesEnvelope(7, [zone("z3")], 2, false)));

    const { result } = renderHook(() => useExpandedZones(7, true, 2));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("includeExpanded=true");
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=2");
    expect(String(fetchMock.mock.calls[0][0])).toContain("offset=0");
    expect(result.current.zones).toHaveLength(2);
    expect(result.current.pagination?.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("offset=2");
    expect(result.current.zones.map((z) => z.zoneId)).toEqual([
      "z1",
      "z2",
      "z3",
    ]);
    expect(result.current.pagination?.hasMore).toBe(false);
  });

  test("keeps loaded zones and exposes an error when a page fails", async () => {
    fetchMock
      .mockResolvedValueOnce(ok(zonesEnvelope(7, [zone("z1")], 0, true)))
      .mockResolvedValueOnce(failure(500, "INTERNAL", "Server failed."))
      .mockResolvedValueOnce(
        ok(zonesEnvelope(7, [zone("z1"), zone("z2")], 0, false))
      );

    const { result } = renderHook(() => useExpandedZones(7, true, 2));
    await flush();

    act(() => result.current.loadMore());
    await flush();

    expect(result.current.error?.code).toBe("INTERNAL");
    expect(result.current.zones).toHaveLength(1);

    act(() => result.current.retry());
    await flush();

    expect(result.current.error).toBeNull();
    expect(result.current.zones).toHaveLength(2);
  });

  test("hides the previous instrument's zones when the selection changes", async () => {
    fetchMock
      .mockResolvedValueOnce(ok(zonesEnvelope(7, [zone("z1")], 0, false)))
      .mockResolvedValueOnce(ok(zonesEnvelope(8, [zone("z9")], 0, false)));

    const { result, rerender } = renderHook(
      (props: { id: number }) => useExpandedZones(props.id, true, 2),
      { initialProps: { id: 7 } }
    );
    await flush();
    expect(result.current.zones).toHaveLength(1);

    rerender({ id: 8 });
    expect(result.current.zones).toHaveLength(0);
    expect(result.current.loading).toBe(true);

    await flush();
    expect(result.current.zones.map((z) => z.zoneId)).toEqual(["z9"]);
  });
});

describe("useLiveTradeBoard", () => {
  const board = {
    groups: [],
    items: [
      {
        itemId: "item-1",
        instrumentId: 7,
        symbol: "INFY",
        companyName: "Infosys",
        groupId: null,
        priority: "MEDIUM",
        direction: null,
        timeframe: "1D",
        entryPrice: null,
        targetPrice: null,
        stopLoss: null,
        notes: "",
        tradeStatus: "WATCHING",
        sortOrder: 1,
        version: 1,
        createdAt: "2026-11-05T00:00:00.000Z",
        updatedAt: "2026-11-05T00:00:00.000Z",
      },
    ],
    instrumentMaster: {
      latestInstrumentUpdateAt: null,
      activeInstrumentCount: 0,
      freshness: "unknown",
      stale: null,
    },
    zones: {
      available: true,
      status: "available",
      freshnessThresholdDays: 7,
      summaries: [],
    },
    generatedAt: "2026-11-06T09:29:00.000Z",
  };

  test("keeps the last successful board when a refresh fails", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ success: true, data: board }))
      .mockResolvedValueOnce(failure(500, "INTERNAL", "Server failed."));

    const { result } = renderHook(() => useLiveTradeBoard(true));
    await flush();

    expect(result.current.board?.items).toHaveLength(1);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await result.current.refetch();
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(result.current.board?.items).toHaveLength(1);
    expect(result.current.error?.code).toBe("INTERNAL");
  });

  test("requests the board shell without zone summaries", async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: true, data: board }));

    const { result } = renderHook(() => useLiveTradeBoard(true));
    await flush();

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/live-trade/board?includeZones=false"
    );
    expect(result.current.board?.zones.summaries).toEqual([]);
  });

  test("applies a server-confirmed change without a refetch", async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: true, data: board }));

    const { result } = renderHook(() => useLiveTradeBoard(true));
    await flush();

    await act(async () => {
      await result.current.runBoardTask(async ({ apply }) => {
        apply((previous) => ({
          ...previous,
          items: previous.items.map((item) => ({ ...item, notes: "edited" })),
        }));
      });
    });

    expect(result.current.board?.items[0].notes).toBe("edited");
    expect(result.current.loading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a queued mutation runs after an in-flight read and survives it", async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: true, data: board }));

    const { result } = renderHook(() => useLiveTradeBoard(true));
    await flush();

    const pending = deferred<unknown>();
    fetchMock.mockReturnValueOnce(pending.promise);
    let refresh: Promise<void> = Promise.resolve();
    act(() => {
      refresh = result.current.refetch();
    });

    let task: Promise<void> = Promise.resolve();
    act(() => {
      task = result.current.runBoardTask(async ({ apply }) => {
        apply((previous) => ({ ...previous, items: [] }));
      });
    });

    // The mutation waits for the older read instead of interleaving with it.
    expect(result.current.board?.items).toHaveLength(1);

    await act(async () => {
      pending.resolve(ok({ success: true, data: board }));
      await refresh;
      await task;
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(result.current.board?.items).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a read that was already in flight cannot repopulate a disabled board", async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: true, data: board }));

    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) => useLiveTradeBoard(props.enabled),
      { initialProps: { enabled: true } }
    );
    await flush();
    expect(result.current.board).not.toBeNull();

    const pending = deferred<unknown>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await act(async () => {
      void result.current.refetch();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    rerender({ enabled: false });
    expect(result.current.board).toBeNull();

    await act(async () => {
      pending.resolve(ok({ success: true, data: board }));
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(result.current.board).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
