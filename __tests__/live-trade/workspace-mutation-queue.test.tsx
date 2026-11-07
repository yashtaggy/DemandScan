/**
 * @jest-environment jsdom
 *
 * Board mutation ordering. The real `useLiveTradeBoard` queue is exercised
 * through the workspace with a stateful fake API, so these tests fail if a
 * mutation response can overwrite a newer confirmed change.
 *
 *  - a reorder followed by an add sends the add only after the reorder lands;
 *  - two overlapping reorders are serialised and each payload is complete;
 *  - a delete queued behind a reorder uses the reorder's bumped version;
 *  - a group create/rename queued behind a group reorder uses the new order
 *    and the bumped version;
 *  - a delayed response blocks the next request instead of arriving late;
 *  - a memoised row reorders against the current list after a delete;
 *  - an add in flight is included in a following reorder;
 *  - group deletion reconciles item versions before the next mutation.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type {
  CreateItemPayload,
  LiveTradeBoardDto,
  LiveTradeGroupDto,
  LiveTradeItemDto,
  UpdateItemPayload,
} from "@/lib/live-trade/client";
import { LiveTradeClientError } from "@/lib/live-trade/client";

const mockQuotesHook = jest.fn();
const mockZonesHook = jest.fn();
const mockSearchHook = jest.fn();
const mockReloadZones = jest.fn();

const mockGetBoard = jest.fn();
const mockCreateItem = jest.fn();
const mockUpdateItem = jest.fn();
const mockDeleteItem = jest.fn();
const mockReorderItems = jest.fn();
const mockCreateGroup = jest.fn();
const mockUpdateGroup = jest.fn();
const mockDeleteGroup = jest.fn();
const mockReorderGroups = jest.fn();

jest.mock("@/hooks/use-live-trade-quotes", () => ({
  useLiveTradeQuotes: () => mockQuotesHook(),
}));

jest.mock("@/hooks/use-live-trade-zone-summaries", () => ({
  useLiveTradeZoneSummaries: () => mockZonesHook(),
}));

jest.mock("@/hooks/use-instrument-search", () => ({
  useInstrumentSearch: (query: string, enabled: boolean) =>
    mockSearchHook(query, enabled),
}));

jest.mock("@/lib/live-trade/client", () => {
  const actual = jest.requireActual("@/lib/live-trade/client");
  return {
    ...actual,
    getBoard: (...args: unknown[]) => mockGetBoard(...args),
    createItem: (...args: unknown[]) => mockCreateItem(...args),
    updateItem: (...args: unknown[]) => mockUpdateItem(...args),
    deleteItem: (...args: unknown[]) => mockDeleteItem(...args),
    reorderItems: (...args: unknown[]) => mockReorderItems(...args),
    createGroup: (...args: unknown[]) => mockCreateGroup(...args),
    updateGroup: (...args: unknown[]) => mockUpdateGroup(...args),
    deleteGroup: (...args: unknown[]) => mockDeleteGroup(...args),
    reorderGroups: (...args: unknown[]) => mockReorderGroups(...args),
  };
});

import { LiveTradeWorkspace } from "@/components/live-trade/workspace";

// ─── Fake owner state and API ────────────────────────────────────────────────

interface OwnerState {
  items: LiveTradeItemDto[];
  groups: LiveTradeGroupDto[];
  requests: string[];
}

let state: OwnerState;

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
    sortOrder: 0,
    version: 1,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  };
}

function makeGroup(
  groupId: string,
  name: string,
  sortOrder: number
): LiveTradeGroupDto {
  return {
    groupId,
    name,
    sortOrder,
    version: 1,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

function boardFromState(): LiveTradeBoardDto {
  return {
    groups: state.groups.map((group) => ({ ...group })),
    items: state.items.map((item) => ({ ...item })),
    instrumentMaster: {
      latestInstrumentUpdateAt: null,
      activeInstrumentCount: 0,
      freshness: "unknown",
      stale: null,
    },
    zones: {
      available: false,
      status: "not_requested",
      freshnessThresholdDays: 7,
      summaries: [],
    },
    generatedAt: "2026-11-06T09:29:00.000Z",
  };
}

function reorderError(message: string): LiveTradeClientError {
  return new LiveTradeClientError(message, {
    status: 409,
    code: "REORDER_STALE",
  });
}

function conflictError(): LiveTradeClientError {
  return new LiveTradeClientError("This item changed in another request.", {
    status: 409,
    code: "EDIT_CONFLICT",
  });
}

function applyItemReorder(ids: string[]): LiveTradeItemDto[] {
  const byId = new Map(state.items.map((item) => [item.itemId, item]));
  const valid =
    ids.length === state.items.length &&
    new Set(ids).size === ids.length &&
    ids.every((id) => byId.has(id));
  if (!valid) throw reorderError("The saved order changed elsewhere.");

  state.items = ids.map((id, index) => {
    const item = byId.get(id)!;
    return { ...item, sortOrder: index, version: item.version + 1 };
  });
  return state.items.map((item) => ({ ...item }));
}

function applyGroupReorder(ids: string[]): LiveTradeGroupDto[] {
  const byId = new Map(state.groups.map((group) => [group.groupId, group]));
  const valid =
    ids.length === state.groups.length &&
    new Set(ids).size === ids.length &&
    ids.every((id) => byId.has(id));
  if (!valid) throw reorderError("The saved order changed elsewhere.");

  state.groups = ids.map((id, index) => {
    const group = byId.get(id)!;
    return { ...group, sortOrder: index, version: group.version + 1 };
  });
  return state.groups.map((group) => ({ ...group }));
}

function applyItemUpdate(
  itemId: string,
  payload: UpdateItemPayload
): LiveTradeItemDto {
  const item = state.items.find((candidate) => candidate.itemId === itemId);
  if (!item) {
    throw new LiveTradeClientError("That record no longer exists.", {
      status: 404,
      code: "NOT_FOUND",
    });
  }
  if (payload.version !== item.version) throw conflictError();

  const next: LiveTradeItemDto = {
    ...item,
    ...payload,
    version: item.version + 1,
    updatedAt: "2026-11-06T10:00:00.000Z",
  };
  state.items = state.items.map((candidate) =>
    candidate.itemId === itemId ? next : candidate
  );
  return { ...next };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 14; i += 1) await Promise.resolve();
  });
}

function visibleSymbols(): string[] {
  return screen
    .getAllByTestId(/^watchlist-item-/)
    .map((node) =>
      (node.getAttribute("data-testid") ?? "").replace("watchlist-item-", "")
    );
}

function optionLabels(select: HTMLElement): string[] {
  return Array.from((select as HTMLSelectElement).options).map(
    (option) => option.textContent ?? ""
  );
}

function heldItemReorder() {
  const held = deferred<LiveTradeItemDto[]>();
  let ids: string[] | null = null;
  mockReorderItems.mockImplementationOnce((nextIds: string[]) => {
    ids = nextIds;
    state.requests.push(`reorderItems:${nextIds.join(",")}`);
    return held.promise;
  });
  return {
    ids: () => ids,
    resolve: async () => {
      if (ids === null) throw new Error("reorderItems was not called");
      held.resolve(applyItemReorder(ids));
      await flush();
    },
  };
}

function heldGroupReorder() {
  const held = deferred<LiveTradeGroupDto[]>();
  let ids: string[] | null = null;
  mockReorderGroups.mockImplementationOnce((nextIds: string[]) => {
    ids = nextIds;
    state.requests.push(`reorderGroups:${nextIds.join(",")}`);
    return held.promise;
  });
  return {
    ids: () => ids,
    resolve: async () => {
      if (ids === null) throw new Error("reorderGroups was not called");
      held.resolve(applyGroupReorder(ids));
      await flush();
    },
  };
}

function heldBoardRead() {
  const held = deferred<LiveTradeBoardDto>();
  mockGetBoard.mockImplementationOnce(() => {
    state.requests.push("getBoard");
    return held.promise;
  });
  return {
    resolve: async () => {
      held.resolve(boardFromState());
      await flush();
    },
  };
}

const QUOTES = {
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
  refresh: jest.fn(),
};

const ZONES = {
  summaries: new Map(),
  loading: false,
  error: null,
  reload: jest.fn(),
};

function emptySearch() {
  return {
    results: [],
    master: null,
    resultQuery: null,
    loading: false,
    error: null,
  };
}

function infySearch() {
  return {
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
  };
}

beforeEach(() => {
  state = { items: [], groups: [], requests: [] };

  mockGetBoard.mockReset();
  mockCreateItem.mockReset();
  mockUpdateItem.mockReset();
  mockDeleteItem.mockReset();
  mockReorderItems.mockReset();
  mockCreateGroup.mockReset();
  mockUpdateGroup.mockReset();
  mockDeleteGroup.mockReset();
  mockReorderGroups.mockReset();
  mockQuotesHook.mockReset();
  mockZonesHook.mockReset();
  mockSearchHook.mockReset();
  mockReloadZones.mockReset();

  mockGetBoard.mockImplementation(async () => boardFromState());
  mockReorderItems.mockImplementation(async (ids: string[]) => {
    state.requests.push(`reorderItems:${ids.join(",")}`);
    return applyItemReorder(ids);
  });
  mockCreateItem.mockImplementation(async (payload: CreateItemPayload) => {
    state.requests.push(`createItem:${payload.instrumentId}`);
    const created = makeItem({
      itemId: `new-${payload.instrumentId}`,
      instrumentId: payload.instrumentId,
      symbol: payload.instrumentId === 408065 ? "INFY" : `SYM${payload.instrumentId}`,
      groupId: payload.groupId ?? null,
      sortOrder: state.items.length,
    });
    state.items = [...state.items, created];
    return created;
  });
  mockUpdateItem.mockImplementation(
    async (itemId: string, payload: UpdateItemPayload) => {
      state.requests.push(`updateItem:${itemId}:${payload.version}`);
      return applyItemUpdate(itemId, payload);
    }
  );
  mockDeleteItem.mockImplementation(
    async (itemId: string, version: number) => {
      state.requests.push(`deleteItem:${itemId}:${version}`);
      const item = state.items.find((candidate) => candidate.itemId === itemId);
      if (!item) {
        throw new LiveTradeClientError("That record no longer exists.", {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      if (item.version !== version) throw conflictError();
      state.items = state.items.filter(
        (candidate) => candidate.itemId !== itemId
      );
    }
  );
  mockCreateGroup.mockImplementation(async (name: string) => {
    state.requests.push(`createGroup:${name}`);
    const created = makeGroup(`g${state.groups.length + 1}`, name, state.groups.length);
    state.groups = [...state.groups, created];
    return created;
  });
  mockUpdateGroup.mockImplementation(
    async (groupId: string, name: string, version: number) => {
      state.requests.push(`updateGroup:${groupId}:${version}`);
      const group = state.groups.find(
        (candidate) => candidate.groupId === groupId
      );
      if (!group) {
        throw new LiveTradeClientError("That record no longer exists.", {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      if (group.version !== version) throw conflictError();
      const next = { ...group, name, version: group.version + 1 };
      state.groups = state.groups.map((candidate) =>
        candidate.groupId === groupId ? next : candidate
      );
      return { ...next };
    }
  );
  mockDeleteGroup.mockImplementation(
    async (groupId: string, version: number) => {
      state.requests.push(`deleteGroup:${groupId}:${version}`);
      const group = state.groups.find(
        (candidate) => candidate.groupId === groupId
      );
      if (!group) {
        throw new LiveTradeClientError("That record no longer exists.", {
          status: 404,
          code: "NOT_FOUND",
        });
      }
      if (group.version !== version) throw conflictError();
      state.groups = state.groups.filter(
        (candidate) => candidate.groupId !== groupId
      );
      state.items = state.items.map((item) =>
        item.groupId === groupId
          ? { ...item, groupId: null, version: item.version + 1 }
          : item
      );
    }
  );
  mockReorderGroups.mockImplementation(async (ids: string[]) => {
    state.requests.push(`reorderGroups:${ids.join(",")}`);
    return applyGroupReorder(ids);
  });

  mockQuotesHook.mockReturnValue(QUOTES);
  mockZonesHook.mockReturnValue(ZONES);
  mockSearchHook.mockReturnValue(emptySearch());
});

async function mount() {
  render(<LiveTradeWorkspace authMarket={null} />);
  await flush();
}

function seedABC() {
  state.items = [
    makeItem({ itemId: "a", instrumentId: 1, symbol: "AAA", sortOrder: 0 }),
    makeItem({ itemId: "b", instrumentId: 2, symbol: "BBB", sortOrder: 1 }),
    makeItem({ itemId: "c", instrumentId: 3, symbol: "CCC", sortOrder: 2 }),
  ];
}

// ─── H1: ordered board mutations ────────────────────────────────────────────

describe("board mutation ordering", () => {
  test("an add queued behind a reorder is sent only after the reorder lands", async () => {
    seedABC();
    mockSearchHook.mockImplementation((query: string) =>
      query.trim() === "" ? emptySearch() : infySearch()
    );
    await mount();

    const held = heldItemReorder();
    fireEvent.click(screen.getByRole("button", { name: "Move CCC up" }));
    await flush();
    expect(held.ids()).toEqual(["a", "c", "b"]);

    fireEvent.change(screen.getByLabelText("Search NSE instruments to add"), {
      target: { value: "infy" },
    });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Add INFY to watchlist" }));
    await flush();

    expect(mockCreateItem).not.toHaveBeenCalled();

    await held.resolve();
    await flush();

    expect(mockCreateItem).toHaveBeenCalledTimes(1);
    expect(state.requests).toEqual([
      "reorderItems:a,c,b",
      "createItem:408065",
    ]);
    expect(visibleSymbols()).toEqual(["AAA", "CCC", "BBB", "INFY"]);
  });

  test("two overlapping item reorders are serialised and each payload is complete", async () => {
    seedABC();
    await mount();

    const held = heldItemReorder();
    fireEvent.click(screen.getByRole("button", { name: "Move CCC up" }));
    await flush();
    expect(mockReorderItems).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Move BBB up" }));
    await flush();
    expect(mockReorderItems).toHaveBeenCalledTimes(1);

    await held.resolve();
    await flush();

    expect(mockReorderItems).toHaveBeenCalledTimes(2);
    // The second move is resolved against the order produced by the first,
    // not the click-time list that still showed AAA, BBB, CCC.
    expect(mockReorderItems.mock.calls[1][0]).toEqual(["a", "b", "c"]);
    expect(visibleSymbols()).toEqual(["AAA", "BBB", "CCC"]);
    expect(state.requests).toEqual([
      "reorderItems:a,c,b",
      "reorderItems:a,b,c",
    ]);
  });

  test("a delete queued behind a reorder uses the reorder's version", async () => {
    state.items = [
      makeItem({ itemId: "a", instrumentId: 1, symbol: "AAA", sortOrder: 0 }),
      makeItem({ itemId: "b", instrumentId: 2, symbol: "BBB", sortOrder: 1 }),
    ];
    await mount();

    const held = heldItemReorder();
    fireEvent.click(screen.getByRole("button", { name: "Move BBB up" }));
    await flush();
    expect(held.ids()).toEqual(["b", "a"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Remove BBB from watchlist" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await flush();

    expect(mockDeleteItem).not.toHaveBeenCalled();

    await held.resolve();
    await flush();

    // The reorder bumped BBB to version 2; the delete must use it.
    expect(mockDeleteItem).toHaveBeenCalledWith("b", 2);
    expect(state.requests).toEqual([
      "reorderItems:b,a",
      "deleteItem:b:2",
    ]);
    expect(visibleSymbols()).toEqual(["AAA"]);
  });

  test("a group create queued behind a group reorder uses the reordered list", async () => {
    state.groups = [makeGroup("g1", "Alpha", 0), makeGroup("g2", "Beta", 1)];
    state.items = [
      makeItem({ itemId: "a", instrumentId: 1, symbol: "AAA", groupId: "g1" }),
    ];
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "Manage groups" }));
    const held = heldGroupReorder();
    fireEvent.click(screen.getByRole("button", { name: "Move Beta up" }));
    await flush();
    expect(held.ids()).toEqual(["g2", "g1"]);

    fireEvent.change(screen.getByLabelText("New group"), {
      target: { value: "Gamma" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await flush();

    expect(mockCreateGroup).not.toHaveBeenCalled();

    await held.resolve();
    await flush();

    expect(mockCreateGroup).toHaveBeenCalledWith("Gamma");
    expect(state.requests).toEqual([
      "reorderGroups:g2,g1",
      "createGroup:Gamma",
    ]);
    expect(
      optionLabels(screen.getByLabelText("Filter watchlist by group"))
    ).toEqual(["All groups", "Ungrouped", "Beta", "Alpha", "Gamma"]);
  });

  test("a group rename queued behind a group reorder uses the bumped version", async () => {
    state.groups = [makeGroup("g1", "Alpha", 0), makeGroup("g2", "Beta", 1)];
    state.items = [
      makeItem({ itemId: "a", instrumentId: 1, symbol: "AAA", groupId: "g1" }),
    ];
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "Manage groups" }));
    const held = heldGroupReorder();
    fireEvent.click(screen.getByRole("button", { name: "Move Beta up" }));
    await flush();

    fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]);
    fireEvent.change(screen.getByLabelText("Rename Alpha"), {
      target: { value: "Alpha+" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await flush();

    expect(mockUpdateGroup).not.toHaveBeenCalled();

    await held.resolve();
    await flush();

    expect(mockUpdateGroup).toHaveBeenCalledWith("g1", "Alpha+", 2);
    expect(state.requests).toEqual([
      "reorderGroups:g2,g1",
      "updateGroup:g1:2",
    ]);
    expect(screen.queryByText(/changed in another request/i)).toBeNull();
  });

  test("a delayed reorder response blocks the next request instead of arriving late", async () => {
    seedABC();
    await mount();

    const first = heldItemReorder();
    fireEvent.click(screen.getByRole("button", { name: "Move CCC up" }));
    await flush();
    expect(mockReorderItems).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Move BBB up" }));
    await flush();
    expect(mockReorderItems).toHaveBeenCalledTimes(1);

    await first.resolve();
    await flush();

    expect(mockReorderItems).toHaveBeenCalledTimes(2);
    expect(visibleSymbols()).toEqual(
      state.items.map((item) => item.symbol)
    );
  });
});

// ─── M1: memoised rows and current item sets ────────────────────────────────

describe("current list semantics", () => {
  test("a memoised row reorders against the list after a delete below it", async () => {
    seedABC();
    await mount();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove BBB from watchlist" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await flush();
    expect(visibleSymbols()).toEqual(["AAA", "CCC"]);

    fireEvent.click(screen.getByRole("button", { name: "Move AAA down" }));
    await flush();

    expect(mockReorderItems).toHaveBeenCalledWith(["c", "a"]);
    expect(visibleSymbols()).toEqual(["CCC", "AAA"]);
  });

  test("a reorder sent while an add is in flight includes the added item", async () => {
    state.items = [
      makeItem({ itemId: "a", instrumentId: 1, symbol: "AAA", sortOrder: 0 }),
      makeItem({ itemId: "b", instrumentId: 2, symbol: "BBB", sortOrder: 1 }),
    ];
    mockSearchHook.mockImplementation((query: string) =>
      query.trim() === "" ? emptySearch() : infySearch()
    );
    await mount();

    const heldAdd = deferred<LiveTradeItemDto>();
    mockCreateItem.mockImplementationOnce(async (payload: CreateItemPayload) => {
      state.requests.push(`createItem:${payload.instrumentId}`);
      return heldAdd.promise;
    });

    fireEvent.change(screen.getByLabelText("Search NSE instruments to add"), {
      target: { value: "infy" },
    });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Add INFY to watchlist" }));
    await flush();
    expect(mockCreateItem).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Move BBB up" }));
    await flush();
    expect(mockReorderItems).not.toHaveBeenCalled();

    const created = makeItem({
      itemId: "new-408065",
      instrumentId: 408065,
      symbol: "INFY",
      sortOrder: 2,
    });
    await act(async () => {
      state.items = [...state.items, created];
      heldAdd.resolve(created);
      for (let i = 0; i < 14; i += 1) await Promise.resolve();
    });
    await flush();

    expect(mockReorderItems).toHaveBeenCalledWith(["b", "a", "new-408065"]);
    expect(visibleSymbols()).toEqual(["BBB", "AAA", "INFY"]);
  });
});

// ─── M2: group-delete version reconciliation ────────────────────────────────

describe("group deletion reconciliation", () => {
  function seedGroups() {
    state.groups = [makeGroup("g1", "Alpha", 0), makeGroup("g2", "Beta", 1)];
    state.items = [
      makeItem({ itemId: "a", instrumentId: 1, symbol: "AAA", groupId: "g1" }),
      makeItem({ itemId: "b", instrumentId: 2, symbol: "BBB", groupId: "g2" }),
    ];
  }

  async function deleteAlpha() {
    fireEvent.click(screen.getByRole("button", { name: "Manage groups" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
  }

  test("an edit after a group delete uses the reconciled item version", async () => {
    seedGroups();
    await mount();

    await deleteAlpha();
    await flush();

    expect(state.items.find((item) => item.itemId === "a")?.version).toBe(2);

    fireEvent.change(screen.getByLabelText("Move AAA to another group"), {
      target: { value: "g2" },
    });
    await flush();

    expect(mockUpdateItem).toHaveBeenCalledWith("a", {
      version: 2,
      groupId: "g2",
    });
    expect(state.requests.at(-1)).toBe("updateItem:a:2");
    expect(screen.queryByText(/changed in another request/i)).toBeNull();
  });

  test("a mutation during reconciliation waits for the refreshed versions", async () => {
    seedGroups();
    await mount();

    const heldRead = heldBoardRead();
    await deleteAlpha();
    await flush();
    expect(state.requests).toContain("getBoard");

    fireEvent.change(screen.getByLabelText("Move AAA to another group"), {
      target: { value: "g2" },
    });
    await flush();
    expect(mockUpdateItem).not.toHaveBeenCalled();

    await heldRead.resolve();
    await flush();

    expect(mockUpdateItem).toHaveBeenCalledWith("a", {
      version: 2,
      groupId: "g2",
    });
    expect(screen.queryByText(/changed in another request/i)).toBeNull();
  });
});
