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
const mockRefreshQuotes = jest.fn();
const mockCreateItem = jest.fn().mockResolvedValue({});
const mockUpdateItem = jest.fn().mockResolvedValue({});
const mockDeleteItem = jest.fn().mockResolvedValue(undefined);
const mockReorderItems = jest.fn().mockResolvedValue([]);

jest.mock("@/hooks/use-live-trade-board", () => ({
  useLiveTradeBoard: () => mockBoardHook(),
}));

jest.mock("@/hooks/use-live-trade-quotes", () => ({
  useLiveTradeQuotes: () => mockQuotesHook(),
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
  mockRefetch.mockClear();
  mockRefreshQuotes.mockClear();
  mockCreateItem.mockClear();
  mockUpdateItem.mockClear();
  mockDeleteItem.mockClear();
  mockReorderItems.mockClear();

  mockBoardHook.mockReturnValue(boardState(makeBoard([])));
  mockQuotesHook.mockReturnValue(quoteState());
  mockSearchHook.mockImplementation((query: string) =>
    query.trim() === "" ? emptySearch() : emptySearch()
  );
});

describe("LiveTradeWorkspace", () => {
  test("renders the empty workspace with instrument search", () => {
    render(<LiveTradeWorkspace authMarket={null} />);

    expect(screen.getByText("Your board is empty")).toBeTruthy();
    expect(screen.getByText("Add instruments")).toBeTruthy();
    expect(screen.getByLabelText("Search NSE instruments to add")).toBeTruthy();
    expect(screen.getByText(/0 tracked instruments/)).toBeTruthy();
  });

  test("adds a searched instrument and refreshes the board", async () => {
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
    expect(mockRefetch).toHaveBeenCalled();
  });

  test("does not offer Add for an instrument already on the board", () => {
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

    render(<LiveTradeWorkspace authMarket={null} />);
    fireEvent.change(screen.getByLabelText("Search NSE instruments to add"), {
      target: { value: "infy" },
    });

    expect(screen.getByText("On board")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Add INFY to watchlist" })
    ).toBeNull();
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
    expect(screen.getByTestId("watchlist-item-INFY")).toBeTruthy();
    expect(screen.getByTestId("watchlist-item-TCS")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter watchlist by group"), {
      target: { value: "g1" },
    });
    expect(screen.getByTestId("watchlist-item-INFY")).toBeTruthy();
    expect(screen.queryByTestId("watchlist-item-TCS")).toBeNull();
    expect(screen.getByText("Showing 1 of 2")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter watchlist by group"), {
      target: { value: "ALL" },
    });
    fireEvent.change(screen.getByLabelText("Filter watchlist by priority"), {
      target: { value: "LOW" },
    });
    expect(screen.queryByTestId("watchlist-item-INFY")).toBeNull();
    expect(screen.getByTestId("watchlist-item-TCS")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter watchlist by priority"), {
      target: { value: "HIGH" },
    });
    expect(screen.getByTestId("watchlist-item-INFY")).toBeTruthy();
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

    render(<LiveTradeWorkspace authMarket={null} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move BBB up" }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(mockReorderItems).toHaveBeenCalledWith(["b", "a", "c"]);
    expect(mockRefetch).toHaveBeenCalled();
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

    expect(screen.getByTestId("watchlist-item-INFY")).toBeTruthy();
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
    expect(screen.getByTestId("watchlist-item-INFY")).toBeTruthy();
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
      screen.getByText("Remove INFY from your board?")
    ).toBeTruthy();
    expect(mockDeleteItem).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(mockDeleteItem).toHaveBeenCalledWith("i1", 1);
    expect(mockRefetch).toHaveBeenCalled();
  });
});
