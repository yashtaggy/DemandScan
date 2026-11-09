/**
 * @jest-environment jsdom
 *
 * Workspace integration with mocked Live Trade APIs:
 *  - empty, filtered and populated boards;
 *  - add and duplicate prevention;
 *  - priority/group filters;
 *  - server-side reorder payload;
 *  - quote failure never removes board rows;
 *  - expired session banner;
 *  - delete confirmation uses the item version.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { LiveTradeItemDto } from "@/lib/live-trade/client";

const mockBoardHook = jest.fn();
const mockQuotesHook = jest.fn();
const mockSearchHook = jest.fn();
const mockRefetch = jest.fn().mockResolvedValue(undefined);
const mockApplyBoard = jest.fn();
const mockRunBoardTask = jest.fn();
const mockZonesHook = jest.fn();
const mockReloadZones = jest.fn();
const mockRefreshQuotes = jest.fn();
const mockCreateItem = jest.fn().mockResolvedValue({});
const mockUpdateItem = jest.fn().mockResolvedValue({});
const mockDeleteItem = jest.fn().mockResolvedValue(undefined);
const mockReorderItems = jest.fn().mockResolvedValue([]);

jest.mock("@/hooks/use-live-trade-board", () => ({
  useLiveTradeBoard: () => mockBoardHook(),
}));

jest.mock("@/hooks/use-live-trade-zone-summaries", () => ({
  useLiveTradeZoneSummaries: () => mockZonesHook(),
}));

jest.mock("@/hooks/use-live-trade-quotes", () => ({
  useLiveTradeQuotes: (instrumentIds: number[], enabled: boolean) =>
    mockQuotesHook(instrumentIds, enabled),
}));

jest.mock("@/hooks/use-instrument-search", () => ({
  useInstrumentSearch: (query: string, enabled: boolean) =>
    mockSearchHook(query, enabled),
}));

jest.mock("@/lib/live-trade/client", () => {
  const actual = jest.requireActual("@/lib/live-trade/client");
  return {
    ...actual,
    createItem: (...args: unknown[]) => mockCreateItem(...args),
    updateItem: (...args: unknown[]) => mockUpdateItem(...args),
    deleteItem: (...args: unknown[]) => mockDeleteItem(...args),
    reorderItems: (...args: unknown[]) => mockReorderItems(...args),
  };
});

import { LiveTradeWorkspace } from "@/components/live-trade/workspace";

function makeItem(
  overrides: Partial<LiveTradeItemDto> & {
    itemId: string;
    instrumentId: number;
    symbol: string;
  }
): LiveTradeItemDto {
  return {
    companyName: `${overrides.symbol} Limited`,
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
    ...overrides,
  };
}

function makeBoard(items: LiveTradeItemDto[], groups: unknown[] = []) {
  return {
    groups,
    items,
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
}

function boardState(board: unknown, error: unknown = null) {
  return {
    board,
    loading: false,
    refreshing: false,
    error,
    refetch: mockRefetch,
    runBoardTask: mockRunBoardTask,
  };
}

function quoteState(overrides: Record<string, unknown> = {}) {
  return {
    quotes: {},
    market: {
      isOpen: true,
      exchange: "NSE",
      approximation: "Approximate NSE session.",
    },
    fetchedAt: null,
    zonesAvailable: true,
    loading: false,
    refreshing: false,
    error: null,
    displayState: "current",
    cooldownSecondsLeft: 0,
    refresh: mockRefreshQuotes,
    ...overrides,
  };
}

function emptySearch() {
  return {
    results: [],
    master: null,
    resultQuery: null,
    loading: false,
    error: null,
  };
}

beforeEach(() => {
  mockBoardHook.mockReset();
  mockQuotesHook.mockReset();
  mockSearchHook.mockReset();
  mockZonesHook.mockReset();
  mockRefetch.mockClear();
  mockApplyBoard.mockClear();
  mockRunBoardTask.mockClear();
  mockReloadZones.mockClear();
  mockRefreshQuotes.mockClear();
  mockCreateItem.mockClear();
  mockUpdateItem.mockClear();
  mockDeleteItem.mockClear();
  mockReorderItems.mockClear();

  mockBoardHook.mockReturnValue(boardState(makeBoard([])));
  mockQuotesHook.mockReturnValue(quoteState());
  mockZonesHook.mockReturnValue({
    summaries: new Map(),
    loading: false,
    error: null,
    reload: mockReloadZones,
  });
  mockSearchHook.mockImplementation((query: string) =>
    query.trim() === "" ? emptySearch() : emptySearch()
  );
  mockRunBoardTask.mockImplementation(
    async (
      task: (context: {
        board: unknown;
        apply: typeof mockApplyBoard;
        refresh: typeof mockRefetch;
      }) => Promise<unknown>
    ) => {
      const board = mockBoardHook().board;
      return task({
        board,
        apply: mockApplyBoard,
        refresh: mockRefetch,
      });
    }
  );
});

describe("LiveTradeWorkspace", () => {
  test("renders the empty workspace with instrument search", () => {
    render(<LiveTradeWorkspace authMarket={null} />);

    expect(screen.getByText("Your board is empty")).toBeTruthy();
    expect(screen.getByText("Add instruments")).toBeTruthy();
    expect(screen.getByLabelText("Search NSE instruments to add")).toBeTruthy();
    expect(screen.getByText(/0 tracked trade entries/)).toBeTruthy();
  });

  test("adds a searched instrument without reloading the whole board", async () => {
    mockSearchHook.mockImplementation((query: string) =>
      query.trim() === ""
        ? emptySearch()
        : {
            results: [
              {
                instrumentId: 408065,
                symbol: "INFY",
                tradingSymbol: "INFY",
                name: "Infosys Limited",
                exchange: "NSE",
                active: true,
                updatedAt: null,
              },
            ],
            master: null,
            resultQuery: "infy",
            loading: false,
            error: null,
          }
    );
    mockCreateItem.mockResolvedValueOnce(
      makeItem({ itemId: "new", instrumentId: 408065, symbol: "INFY" })
    );

    render(<LiveTradeWorkspace authMarket={null} />);
    fireEvent.change(screen.getByLabelText("Search NSE instruments to add"), {
      target: { value: "infy" },
    });

    const add = screen.getByRole("button", { name: "Add INFY to watchlist" });
    await act(async () => {
      fireEvent.click(add);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(mockCreateItem).toHaveBeenCalledWith({
      instrumentId: 408065,
      groupId: null,
    });
    expect(mockApplyBoard).toHaveBeenCalledTimes(1);
    // Zone evidence for the new instrument is fetched separately.
    expect(mockReloadZones).toHaveBeenCalledTimes(1);
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  test("offers a fresh entry for an instrument already on the board", async () => {
    mockBoardHook.mockReturnValue(
      boardState(
        makeBoard([
          makeItem({ itemId: "i1", instrumentId: 408065, symbol: "INFY" }),
        ])
      )
    );
    mockSearchHook.mockImplementation(() => ({
      results: [
        {
          instrumentId: 408065,
          symbol: "INFY",
          tradingSymbol: "INFY",
          name: "Infosys Limited",
          exchange: "NSE",
          active: true,
          updatedAt: null,
        },
      ],
      master: null,
      resultQuery: "infy",
      loading: false,
      error: null,
    }));
    mockCreateItem.mockResolvedValueOnce(
      makeItem({ itemId: "i2", instrumentId: 408065, symbol: "INFY" })
    );

    render(<LiveTradeWorkspace authMarket={null} />);
    fireEvent.change(screen.getByLabelText("Search NSE instruments to add"), {
      target: { value: "infy" },
    });

    expect(screen.getByText("1 entry on board")).toBeTruthy();
    const add = screen.getByRole("button", {
      name: "Add another INFY trade entry",
    });

    await act(async () => {
      fireEvent.click(add);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    // The repeat add is a normal create: no instrument is edited and the
    // returned row is appended like any other entry.
    expect(mockUpdateItem).not.toHaveBeenCalled();
    expect(mockCreateItem).toHaveBeenCalledWith({
      instrumentId: 408065,
      groupId: null,
    });
    expect(mockApplyBoard).toHaveBeenCalledTimes(1);
  });

  test("renders repeated entries as independent rows sharing one quote", () => {
    const first = makeItem({
      itemId: "gold-1",
      instrumentId: 1001,
      symbol: "GOLD",
      createdAt: "2026-11-09T04:00:00.000Z",
      priority: "HIGH",
      direction: "BUY",
      entryPrice: 72000,
      targetPrice: 74000,
      stopLoss: 71000,
      notes: "first plan",
    });
    const second = makeItem({
      itemId: "gold-2",
      instrumentId: 1001,
      symbol: "GOLD",
      createdAt: "2026-11-09T06:00:00.000Z",
      priority: "LOW",
      direction: "SELL",
      entryPrice: 73000,
      targetPrice: 71000,
      stopLoss: 74000,
      notes: "second plan",
    });
    const infy = makeItem({
      itemId: "infy-1",
      instrumentId: 3,
      symbol: "INFY",
    });

    mockBoardHook.mockReturnValue(
      boardState(makeBoard([first, second, infy]))
    );
    mockQuotesHook.mockReturnValue(
      quoteState({
        quotes: {
          1001: {
            instrumentId: 1001,
            symbol: "GOLD",
            lastPrice: 72500.5,
            change: 100,
            changePercent: 0.14,
            lastTradedAt: null,
            fetchedAt: "2026-11-09T06:30:00.000Z",
            freshness: "LIVE",
            errorCode: null,
            nearestDemand: null,
            nearestSupply: null,
          },
        },
      })
    );

    render(<LiveTradeWorkspace authMarket={null} />);

    // Rows are keyed and addressable by item id, never by instrument or symbol.
    expect(screen.getByTestId("watchlist-item-gold-1")).toBeTruthy();
    expect(screen.getByTestId("watchlist-item-gold-2")).toBeTruthy();
    expect(screen.getByTestId("watchlist-item-infy-1")).toBeTruthy();
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    expect(screen.getByText("3 tracked trade entries")).toBeTruthy();
    expect(screen.getByText("first plan")).toBeTruthy();
    expect(screen.getByText("second plan")).toBeTruthy();

    // One quote request for the shared instrument, not one per entry.
    expect(mockQuotesHook).toHaveBeenLastCalledWith([1001, 3], true);
    expect(screen.getAllByText("₹72,500.50")).toHaveLength(2);
  });

  test("filters by group and priority without hiding the total", () => {
    mockBoardHook.mockReturnValue(
      boardState(
        makeBoard(
          [
            makeItem({
              itemId: "i1",
              instrumentId: 1,
              symbol: "INFY",
              priority: "HIGH",
              groupId: "g1",
            }),
            makeItem({
              itemId: "i2",
              instrumentId: 2,
              symbol: "TCS",
              priority: "LOW",
            }),
          ],
          [
            {
              groupId: "g1",
              name: "Momentum",
              sortOrder: 1,
              version: 1,
              createdAt: "2026-11-05T00:00:00.000Z",
              updatedAt: "2026-11-05T00:00:00.000Z",
            },
          ]
        )
      )
    );

    render(<LiveTradeWorkspace authMarket={null} />);
    expect(screen.getByTestId("watchlist-item-i1")).toBeTruthy();
    expect(screen.getByTestId("watchlist-item-i2")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter watchlist by group"), {
      target: { value: "g1" },
    });
    expect(screen.getByTestId("watchlist-item-i1")).toBeTruthy();
    expect(screen.queryByTestId("watchlist-item-i2")).toBeNull();
    expect(screen.getByText("Showing 1 of 2")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter watchlist by group"), {
      target: { value: "ALL" },
    });
    fireEvent.change(screen.getByLabelText("Filter watchlist by priority"), {
      target: { value: "LOW" },
    });
    expect(screen.queryByTestId("watchlist-item-i1")).toBeNull();
    expect(screen.getByTestId("watchlist-item-i2")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter watchlist by priority"), {
      target: { value: "HIGH" },
    });
    expect(screen.getByTestId("watchlist-item-i1")).toBeTruthy();
  });

  test("sends the full item order when moving within a filtered list", async () => {
    mockBoardHook.mockReturnValue(
      boardState(
        makeBoard([
          makeItem({ itemId: "a", instrumentId: 1, symbol: "AAA" }),
          makeItem({ itemId: "b", instrumentId: 2, symbol: "BBB" }),
          makeItem({ itemId: "c", instrumentId: 3, symbol: "CCC" }),
        ])
      )
    );
    mockReorderItems.mockResolvedValueOnce([
      makeItem({ itemId: "b", instrumentId: 2, symbol: "BBB", sortOrder: 0 }),
      makeItem({ itemId: "a", instrumentId: 1, symbol: "AAA", sortOrder: 1 }),
      makeItem({ itemId: "c", instrumentId: 3, symbol: "CCC", sortOrder: 2 }),
    ]);

    render(<LiveTradeWorkspace authMarket={null} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move BBB up" }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(mockReorderItems).toHaveBeenCalledWith(["b", "a", "c"]);
    expect(mockApplyBoard).toHaveBeenCalledTimes(1);
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  test("a quote failure leaves the board rendered and labels retained data stale", () => {
    mockBoardHook.mockReturnValue(
      boardState(
        makeBoard([
          makeItem({ itemId: "i1", instrumentId: 1, symbol: "INFY" }),
        ])
      )
    );
    mockQuotesHook.mockReturnValue(
      quoteState({
        quotes: {
          1: {
            instrumentId: 1,
            symbol: "INFY",
            lastPrice: 1505.25,
            change: 12.5,
            changePercent: 0.8375,
            lastTradedAt: "2026-11-06T09:28:41.000Z",
            fetchedAt: "2026-11-06T09:29:00.000Z",
            freshness: "LIVE",
            errorCode: null,
            nearestDemand: null,
            nearestSupply: null,
          },
        },
        fetchedAt: "2026-11-06T09:29:00.000Z",
        displayState: "stale",
        error: Object.assign(new Error("Provider unavailable."), {
          status: 502,
          code: "QUOTE_FETCH_FAILED",
        }),
      })
    );

    render(<LiveTradeWorkspace authMarket={null} />);

    expect(screen.getByTestId("watchlist-item-i1")).toBeTruthy();
    expect(screen.getByText(/Your board data is unaffected/)).toBeTruthy();
    expect(screen.getByText(/Retained snapshot/)).toBeTruthy();
  });

  test("shows a reconnect banner for an expired session", () => {
    mockBoardHook.mockReturnValue(
      boardState(
        makeBoard([
          makeItem({ itemId: "i1", instrumentId: 1, symbol: "INFY" }),
        ]),
        Object.assign(new Error("Your Kite session has expired."), {
          status: 401,
          code: "TOKEN_EXPIRED",
        })
      )
    );

    render(<LiveTradeWorkspace authMarket={null} />);

    expect(
      screen.getByText("Your Kite session needs attention")
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Reconnect Zerodha" })
    ).toBeTruthy();
    expect(screen.getByTestId("watchlist-item-i1")).toBeTruthy();
  });

  test("deletes only after confirmation and sends the item version", async () => {
    mockBoardHook.mockReturnValue(
      boardState(
        makeBoard([
          makeItem({ itemId: "i1", instrumentId: 1, symbol: "INFY" }),
        ])
      )
    );

    render(<LiveTradeWorkspace authMarket={null} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove INFY from watchlist" })
    );

    expect(
      screen.getByText("Remove INFY trade entry?")
    ).toBeTruthy();
    expect(mockDeleteItem).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(mockDeleteItem).toHaveBeenCalledWith("i1", 1);
    expect(mockApplyBoard).toHaveBeenCalledTimes(1);
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  test("offers a zone retry action when summaries fail", () => {
    mockBoardHook.mockReturnValue(
      boardState(
        makeBoard([
          makeItem({ itemId: "i1", instrumentId: 1, symbol: "INFY" }),
        ])
      )
    );
    mockZonesHook.mockReturnValue({
      summaries: new Map(),
      loading: false,
      error: Object.assign(new Error("Zone summaries failed."), {
        status: 500,
        code: "INTERNAL",
      }),
      reload: mockReloadZones,
    });

    render(<LiveTradeWorkspace authMarket={null} />);

    expect(
      screen.getByText(/Live zone summaries could not be loaded/)
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry zones" }));
    expect(mockReloadZones).toHaveBeenCalledTimes(1);
  });

  test("disables the zone retry while a retry is in progress", () => {
    mockBoardHook.mockReturnValue(
      boardState(
        makeBoard([
          makeItem({ itemId: "i1", instrumentId: 1, symbol: "INFY" }),
        ])
      )
    );
    mockZonesHook.mockReturnValue({
      summaries: new Map(),
      loading: true,
      error: Object.assign(new Error("Zone summaries failed."), {
        status: 500,
        code: "INTERNAL",
      }),
      reload: mockReloadZones,
    });

    render(<LiveTradeWorkspace authMarket={null} />);

    const retry = screen.getByRole("button", { name: "Retry zones" });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retry);
    expect(mockReloadZones).not.toHaveBeenCalled();
  });
});
