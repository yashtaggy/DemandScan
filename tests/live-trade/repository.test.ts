/**
 * Live Trade repository tests.
 *
 * The database is a stateful in-memory fake (./fake-db.ts) driven by the
 * `-- lt:` statement markers. It enforces the same owner scoping, versioning,
 * limits and case-insensitive name index as the SQL, and serializes
 * lock-taking batches per owner so the concurrency tests exercise the advisory
 * lock contract rather than a call counter.
 *
 * No real database connection is created and no SQL is executed anywhere.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  CreateLiveTradeItemInput,
  LiveTradeOwnerId,
  UpdateLiveTradeItemInput,
} from "@/lib/live-trade/types";
import {
  createGroup,
  createItem,
  deleteGroup,
  deleteItem,
  listGroups,
  listItems,
  reorderGroups,
  reorderItems,
  updateGroup,
  updateItem,
} from "@/lib/live-trade/repository";
import { LiveTradeError } from "@/lib/live-trade/errors";
import { FakeLiveTradeDb } from "./fake-db";

const mockFake = new FakeLiveTradeDb();
const globalStore = globalThis as typeof globalThis & {
  __liveTradeDb?: unknown;
};

jest.mock("@/lib/db", () => ({
  getDb: () => globalStore.__liveTradeDb,
}));

const OWNER_A = "owner-a" as LiveTradeOwnerId;
const OWNER_B = "owner-b" as LiveTradeOwnerId;
const OWNER_A_RAW = OWNER_A as string;
const OWNER_B_RAW = OWNER_B as string;

function itemInput(
  overrides: Partial<CreateLiveTradeItemInput> = {}
): CreateLiveTradeItemInput {
  return {
    instrumentId: 1,
    groupId: null,
    priority: "MEDIUM",
    direction: null,
    timeframe: "1D",
    entryPrice: null,
    targetPrice: null,
    stopLoss: null,
    notes: "",
    tradeStatus: "WATCHING",
    ...overrides,
  };
}

async function expectLiveTradeError(
  promise: Promise<unknown>,
  code: string
): Promise<LiveTradeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LiveTradeError);
    const liveTradeError = error as LiveTradeError;
    expect(liveTradeError.code).toBe(code);
    return liveTradeError;
  }
  throw new Error(`expected LiveTradeError ${code}`);
}

beforeEach(() => {
  mockFake.reset();
  mockFake.seedInstrument({ instrument_id: 1 });
  mockFake.seedInstrument({ instrument_id: 2 });
  mockFake.seedInstrument({ instrument_id: 3 });
  globalStore.__liveTradeDb = mockFake.sql;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Ownership ───────────────────────────────────────────────────────────────

describe("owner scoping", () => {
  it("lists only the caller's groups and items", async () => {
    mockFake.seedGroup({ owner: OWNER_A_RAW, name: "A group" });
    mockFake.seedGroup({ owner: OWNER_B_RAW, name: "B group" });
    mockFake.seedItem({ owner: OWNER_A_RAW, instrumentId: 1 });
    mockFake.seedItem({ owner: OWNER_B_RAW, instrumentId: 2 });

    const groups = await listGroups(OWNER_A);
    const items = await listItems(OWNER_A);

    expect(groups.map((group) => group.name)).toEqual(["A group"]);
    expect(items.map((item) => item.instrumentId)).toEqual([1]);
  });

  it("treats another owner's group as not found on update", async () => {
    const foreign = mockFake.seedGroup({
      owner: OWNER_B_RAW,
      name: "B group",
    });

    await expectLiveTradeError(
      updateGroup(OWNER_A, foreign.group_id, "Renamed", 1),
      "NOT_FOUND"
    );
    expect(mockFake.groupById(foreign.group_id)?.name).toBe("B group");
  });

  it("treats another owner's group as not found on delete", async () => {
    const foreign = mockFake.seedGroup({
      owner: OWNER_B_RAW,
      name: "B group",
    });

    await expectLiveTradeError(
      deleteGroup(OWNER_A, foreign.group_id, 1),
      "NOT_FOUND"
    );
    expect(mockFake.groupById(foreign.group_id)).toBeDefined();
  });

  it("treats another owner's item as not found on update and delete", async () => {
    const foreign = mockFake.seedItem({
      owner: OWNER_B_RAW,
      instrumentId: 2,
    });

    await expectLiveTradeError(
      updateItem(OWNER_A, foreign.item_id, { version: 1, notes: "x" }),
      "NOT_FOUND"
    );
    await expectLiveTradeError(
      deleteItem(OWNER_A, foreign.item_id, 1),
      "NOT_FOUND"
    );
    expect(mockFake.itemById(foreign.item_id)?.notes).toBe("");
  });

  it("rejects assigning another owner's group on create", async () => {
    const foreign = mockFake.seedGroup({
      owner: OWNER_B_RAW,
      name: "B group",
    });

    await expectLiveTradeError(
      createItem(
        OWNER_A,
        itemInput({ instrumentId: 1, groupId: foreign.group_id })
      ),
      "INVALID_GROUP"
    );
    expect(mockFake.items).toHaveLength(0);
  });

  it("rejects assigning another owner's group on update", async () => {
    const foreign = mockFake.seedGroup({
      owner: OWNER_B_RAW,
      name: "B group",
    });
    const own = mockFake.seedItem({ owner: OWNER_A_RAW, instrumentId: 1 });

    await expectLiveTradeError(
      updateItem(OWNER_A, own.item_id, {
        version: 1,
        groupId: foreign.group_id,
      }),
      "INVALID_GROUP"
    );
    expect(mockFake.itemById(own.item_id)?.group_id).toBeNull();
    expect(mockFake.itemById(own.item_id)?.version).toBe(1);
  });

  it("scopes every data statement by owner_user_id", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../lib/live-trade/repository.ts"),
      "utf8"
    );
    const blocks = [...source.matchAll(/-- lt:([a-z0-9:-]+)([\s\S]*?)`/g)];

    expect(blocks.length).toBeGreaterThan(20);
    // The instrument master is shared reference data, not owner-scoped.
    const shared = new Set([
      "lock",
      "instrument-master-info",
      "search-instruments",
    ]);
    const unscoped = blocks
      .filter(([, marker]) => !shared.has(marker))
      .filter(([, , body]) => !body.includes("owner_user_id"))
      .map(([, marker]) => marker);

    expect(unscoped).toEqual([]);
  });
});

// ─── Groups ──────────────────────────────────────────────────────────────────

describe("groups", () => {
  it("enforces case-insensitive, trimmed name uniqueness", async () => {
    await createGroup(OWNER_A, "Tech");
    await expectLiveTradeError(createGroup(OWNER_A, " tech "), "DUPLICATE_GROUP");
  });

  it("allows the same name for different owners", async () => {
    await createGroup(OWNER_A, "Tech");
    const other = await createGroup(OWNER_B, "Tech");
    expect(other.name).toBe("Tech");
  });

  it("enforces the 20 group limit", async () => {
    for (let index = 0; index < 20; index += 1) {
      mockFake.seedGroup({ owner: OWNER_A_RAW, name: `Group ${index}` });
    }
    await expectLiveTradeError(createGroup(OWNER_A, "One more"), "GROUP_LIMIT");
    expect(mockFake.groups).toHaveLength(20);
  });

  it("serializes concurrent creates and never exceeds the limit", async () => {
    for (let index = 0; index < 19; index += 1) {
      mockFake.seedGroup({ owner: OWNER_A_RAW, name: `Group ${index}` });
    }

    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        createGroup(OWNER_A, `Concurrent ${index}`)
      )
    );

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejections = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(rejections).toHaveLength(5);
    for (const rejection of rejections) {
      expect((rejection.reason as LiveTradeError).code).toBe("GROUP_LIMIT");
    }
    expect(
      mockFake.groups.filter((group) => group.owner_user_id === OWNER_A_RAW)
    ).toHaveLength(20);

    // Lock-first ordering and one-backend-per-transaction are part of the
    // repository contract. The fake cannot interleave a serialized batch.
    const locked = mockFake.transactions.filter(
      (transaction) => transaction.owner === OWNER_A_RAW
    );
    expect(locked).toHaveLength(6);
    for (const transaction of locked) {
      expect(transaction.markers[0]).toBe("lock");
      expect(transaction.markers).toEqual([
        "lock",
        "create-group:diagnostics",
        "create-group:insert",
        "create-group:read",
      ]);
    }
    expect(mockFake.maxConcurrentPerOwner).toBe(1);

    const connectionOrder = mockFake.events
      .filter((event) => event.owner === OWNER_A_RAW)
      .map((event) => event.connectionId);
    const runs = connectionOrder.filter(
      (id, index) => index === 0 || id !== connectionOrder[index - 1]
    );
    expect(new Set(runs).size).toBe(runs.length);
  });

  it("increments the version on a successful rename", async () => {
    const group = await createGroup(OWNER_A, "Tech");
    const updated = await updateGroup(OWNER_A, group.groupId, "Technology", group.version);
    expect(updated.name).toBe("Technology");
    expect(updated.version).toBe(2);
  });

  it("reports a stale version as EDIT_CONFLICT with the current version", async () => {
    const group = await createGroup(OWNER_A, "Tech");
    await updateGroup(OWNER_A, group.groupId, "Technology", group.version);

    const error = await expectLiveTradeError(
      updateGroup(OWNER_A, group.groupId, "Techno", group.version),
      "EDIT_CONFLICT"
    );
    expect(error.details).toEqual({ currentVersion: 2 });
  });

  it("requires the expected version to delete", async () => {
    const group = await createGroup(OWNER_A, "Tech");
    const error = await expectLiveTradeError(
      deleteGroup(OWNER_A, group.groupId, group.version + 1),
      "EDIT_CONFLICT"
    );
    expect(error.details).toEqual({ currentVersion: 1 });
    expect(mockFake.groupById(group.groupId)).toBeDefined();
  });

  it("ungroups items and increments their versions in the delete transaction", async () => {
    const group = mockFake.seedGroup({ owner: OWNER_A_RAW, name: "Tech" });
    const first = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 1,
      groupId: group.group_id,
    });
    const second = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 2,
      groupId: group.group_id,
    });

    await deleteGroup(OWNER_A, group.group_id, 1);

    expect(mockFake.groupById(group.group_id)).toBeUndefined();
    expect(mockFake.items).toHaveLength(2);
    expect(mockFake.itemById(first.item_id)?.group_id).toBeNull();
    expect(mockFake.itemById(first.item_id)?.version).toBe(2);
    expect(mockFake.itemById(second.item_id)?.group_id).toBeNull();
    expect(mockFake.itemById(second.item_id)?.version).toBe(2);

    const transaction = mockFake.transactions.at(-1);
    expect(transaction?.markers[0]).toBe("lock");
    expect(transaction?.markers).toContain("delete-group:ungroup");
    expect(transaction?.markers.indexOf("delete-group:ungroup")).toBeLessThan(
      transaction?.markers.indexOf("delete-group:delete") ?? -1
    );
  });

  it("rolls the whole delete back when a later statement fails", async () => {
    const group = mockFake.seedGroup({ owner: OWNER_A_RAW, name: "Tech" });
    const item = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 1,
      groupId: group.group_id,
    });
    mockFake.failOnce("delete-group:delete");

    await expectLiveTradeError(deleteGroup(OWNER_A, group.group_id, 1), "INTERNAL");

    expect(mockFake.groupById(group.group_id)).toBeDefined();
    expect(mockFake.itemById(item.item_id)?.group_id).toBe(group.group_id);
    expect(mockFake.itemById(item.item_id)?.version).toBe(1);
    expect(mockFake.transactions.at(-1)?.committed).toBe(false);
  });

  it("reorders groups and increments every version", async () => {
    const first = mockFake.seedGroup({
      owner: OWNER_A_RAW,
      name: "First",
      sortOrder: 0,
    });
    const second = mockFake.seedGroup({
      owner: OWNER_A_RAW,
      name: "Second",
      sortOrder: 1,
    });

    const result = await reorderGroups(OWNER_A, [second.group_id, first.group_id]);

    expect(result.map((group) => group.groupId)).toEqual([
      second.group_id,
      first.group_id,
    ]);
    expect(mockFake.groupById(second.group_id)?.sort_order).toBe(0);
    expect(mockFake.groupById(first.group_id)?.sort_order).toBe(1);
    expect(mockFake.groupById(second.group_id)?.version).toBe(2);
    expect(mockFake.groupById(first.group_id)?.version).toBe(2);
  });

  it("rejects a reorder with duplicates without changing anything", async () => {
    const group = mockFake.seedGroup({ owner: OWNER_A_RAW, name: "Only" });
    await expectLiveTradeError(
      reorderGroups(OWNER_A, [group.group_id, group.group_id]),
      "REORDER_STALE"
    );
    expect(mockFake.groupById(group.group_id)?.version).toBe(1);
    expect(mockFake.groupById(group.group_id)?.sort_order).toBe(0);
  });

  it("rejects a reorder with missing, additional or foreign ids", async () => {
    const first = mockFake.seedGroup({ owner: OWNER_A_RAW, name: "First" });
    const second = mockFake.seedGroup({ owner: OWNER_A_RAW, name: "Second" });
    const foreign = mockFake.seedGroup({ owner: OWNER_B_RAW, name: "Foreign" });

    await expectLiveTradeError(
      reorderGroups(OWNER_A, [first.group_id]),
      "REORDER_STALE"
    );
    await expectLiveTradeError(
      reorderGroups(OWNER_A, [first.group_id, second.group_id, foreign.group_id]),
      "REORDER_STALE"
    );
    await expectLiveTradeError(
      reorderGroups(OWNER_A, [first.group_id, foreign.group_id]),
      "REORDER_STALE"
    );

    expect(mockFake.groupById(first.group_id)?.version).toBe(1);
    expect(mockFake.groupById(second.group_id)?.version).toBe(1);
    expect(mockFake.groupById(foreign.group_id)?.version).toBe(1);
  });

  it("accepts an empty reorder only when the owner has no groups", async () => {
    await expect(reorderGroups(OWNER_A, [])).resolves.toEqual([]);

    await createGroup(OWNER_A, "Temp");
    await expectLiveTradeError(reorderGroups(OWNER_A, []), "REORDER_STALE");
  });
});

// ─── Items ───────────────────────────────────────────────────────────────────

describe("items", () => {
  it("creates an item with a stable sort order and symbol", async () => {
    const created = await createItem(OWNER_A, itemInput({ instrumentId: 2 }));
    expect(created.instrumentId).toBe(2);
    expect(created.symbol).toBe("SYM2");
    expect(created.sortOrder).toBe(0);
    expect(created.version).toBe(1);
    expect(created.timeframe).toBe("1D");
  });

  it("persists an explicit Any timeframe as null", async () => {
    const created = await createItem(
      OWNER_A,
      itemInput({ instrumentId: 1, timeframe: null })
    );
    expect(created.timeframe).toBeNull();
    expect(mockFake.itemById(created.itemId)?.timeframe).toBeNull();
  });

  it("rejects a duplicate instrument for the same owner", async () => {
    await createItem(OWNER_A, itemInput({ instrumentId: 1 }));
    await expectLiveTradeError(
      createItem(OWNER_A, itemInput({ instrumentId: 1 })),
      "DUPLICATE_ITEM"
    );
  });

  it("allows the same instrument for different owners", async () => {
    await createItem(OWNER_A, itemInput({ instrumentId: 1 }));
    const other = await createItem(OWNER_B, itemInput({ instrumentId: 1 }));
    expect(other.instrumentId).toBe(1);
  });

  it("rejects an instrument that has not been synchronized", async () => {
    await expectLiveTradeError(
      createItem(OWNER_A, itemInput({ instrumentId: 999 })),
      "INSTRUMENT_NOT_SYNCED"
    );
  });

  it("rejects an inactive instrument inside the guarded insert", async () => {
    mockFake.seedInstrument({ instrument_id: 7, active: false });
    await expectLiveTradeError(
      createItem(OWNER_A, itemInput({ instrumentId: 7 })),
      "INSTRUMENT_INACTIVE"
    );
    expect(mockFake.items).toHaveLength(0);
  });

  it("rejects an instrument outside the NSE universe", async () => {
    mockFake.seedInstrument({ instrument_id: 8, exchange: "BSE" });
    await expectLiveTradeError(
      createItem(OWNER_A, itemInput({ instrumentId: 8 })),
      "INSTRUMENT_NOT_SYNCED"
    );
  });

  it("enforces the 200 item limit", async () => {
    for (let index = 0; index < 200; index += 1) {
      const instrumentId = 1000 + index;
      mockFake.seedInstrument({ instrument_id: instrumentId });
      mockFake.seedItem({ owner: OWNER_A_RAW, instrumentId });
    }
    mockFake.seedInstrument({ instrument_id: 2000 });

    await expectLiveTradeError(
      createItem(OWNER_A, itemInput({ instrumentId: 2000 })),
      "ITEM_LIMIT"
    );
    expect(
      mockFake.items.filter((item) => item.owner_user_id === OWNER_A_RAW)
    ).toHaveLength(200);
  });

  it("serializes concurrent creates and never exceeds the item limit", async () => {
    for (let index = 0; index < 199; index += 1) {
      const instrumentId = 1000 + index;
      mockFake.seedInstrument({ instrument_id: instrumentId });
      mockFake.seedItem({ owner: OWNER_A_RAW, instrumentId });
    }
    for (let offset = 0; offset < 6; offset += 1) {
      mockFake.seedInstrument({ instrument_id: 3000 + offset });
    }

    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, offset) =>
        createItem(OWNER_A, itemInput({ instrumentId: 3000 + offset }))
      )
    );

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejections = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    for (const rejection of rejections) {
      expect((rejection.reason as LiveTradeError).code).toBe("ITEM_LIMIT");
    }
    expect(
      mockFake.items.filter((item) => item.owner_user_id === OWNER_A_RAW)
    ).toHaveLength(200);
    expect(mockFake.maxConcurrentPerOwner).toBe(1);

    const locked = mockFake.transactions.filter(
      (transaction) => transaction.owner === OWNER_A_RAW
    );
    expect(locked).toHaveLength(6);
    for (const transaction of locked) {
      expect(transaction.markers[0]).toBe("lock");
    }
  });

  it("updates mutable fields and increments the version", async () => {
    const created = await createItem(OWNER_A, itemInput({ instrumentId: 1 }));
    const patch: UpdateLiveTradeItemInput = {
      version: created.version,
      priority: "HIGH",
      direction: "BUY",
      entryPrice: 100.1234,
      notes: "watch the breakout",
      tradeStatus: "WAITING_FOR_ENTRY",
    };

    const updated = await updateItem(OWNER_A, created.itemId, patch);

    expect(updated.priority).toBe("HIGH");
    expect(updated.direction).toBe("BUY");
    expect(updated.entryPrice).toBe(100.1234);
    expect(updated.notes).toBe("watch the breakout");
    expect(updated.tradeStatus).toBe("WAITING_FOR_ENTRY");
    expect(updated.version).toBe(2);
  });

  it("preserves an omitted timeframe and clears an explicit null", async () => {
    const created = await createItem(OWNER_A, itemInput({ instrumentId: 1 }));

    const renamed = await updateItem(OWNER_A, created.itemId, {
      version: created.version,
      notes: "no timeframe key",
    });
    expect(renamed.timeframe).toBe("1D");

    const cleared = await updateItem(OWNER_A, created.itemId, {
      version: renamed.version,
      timeframe: null,
    });
    expect(cleared.timeframe).toBeNull();
  });

  it("reports a stale item version as EDIT_CONFLICT", async () => {
    const created = await createItem(OWNER_A, itemInput({ instrumentId: 1 }));
    await updateItem(OWNER_A, created.itemId, {
      version: created.version,
      notes: "first",
    });

    const error = await expectLiveTradeError(
      updateItem(OWNER_A, created.itemId, {
        version: created.version,
        notes: "second",
      }),
      "EDIT_CONFLICT"
    );
    expect(error.details).toEqual({ currentVersion: 2 });
  });

  it("requires the expected version to delete an item", async () => {
    const created = await createItem(OWNER_A, itemInput({ instrumentId: 1 }));

    const error = await expectLiveTradeError(
      deleteItem(OWNER_A, created.itemId, created.version + 1),
      "EDIT_CONFLICT"
    );
    expect(error.details).toEqual({ currentVersion: 1 });

    await deleteItem(OWNER_A, created.itemId, created.version);
    expect(mockFake.itemById(created.itemId)).toBeUndefined();
  });

  it("reorders items atomically and increments every version", async () => {
    const first = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 1,
      sortOrder: 0,
    });
    const second = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 2,
      sortOrder: 1,
    });

    const result = await reorderItems(OWNER_A, [second.item_id, first.item_id]);

    expect(result.map((item) => item.itemId)).toEqual([
      second.item_id,
      first.item_id,
    ]);
    expect(mockFake.itemById(second.item_id)?.sort_order).toBe(0);
    expect(mockFake.itemById(first.item_id)?.sort_order).toBe(1);
    expect(mockFake.itemById(second.item_id)?.version).toBe(2);
    expect(mockFake.itemById(first.item_id)?.version).toBe(2);
  });

  it("rejects duplicate, missing, additional and foreign ids", async () => {
    const first = mockFake.seedItem({ owner: OWNER_A_RAW, instrumentId: 1 });
    const second = mockFake.seedItem({ owner: OWNER_A_RAW, instrumentId: 2 });
    const foreign = mockFake.seedItem({ owner: OWNER_B_RAW, instrumentId: 3 });

    await expectLiveTradeError(
      reorderItems(OWNER_A, [second.item_id, second.item_id]),
      "REORDER_STALE"
    );
    await expectLiveTradeError(
      reorderItems(OWNER_A, [first.item_id]),
      "REORDER_STALE"
    );
    await expectLiveTradeError(
      reorderItems(OWNER_A, [first.item_id, second.item_id, foreign.item_id]),
      "REORDER_STALE"
    );
    await expectLiveTradeError(
      reorderItems(OWNER_A, [first.item_id, foreign.item_id]),
      "REORDER_STALE"
    );

    for (const id of [first.item_id, second.item_id, foreign.item_id]) {
      expect(mockFake.itemById(id)?.version).toBe(1);
    }
  });

  it("accepts an empty reorder only when the owner has no items", async () => {
    await expect(reorderItems(OWNER_A, [])).resolves.toEqual([]);
    await expect(reorderItems(OWNER_B, [])).resolves.toEqual([]);

    mockFake.seedItem({ owner: OWNER_A_RAW, instrumentId: 1 });
    await expectLiveTradeError(reorderItems(OWNER_A, []), "REORDER_STALE");
  });

  it("rolls the whole reorder back when a later statement fails", async () => {
    const first = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 1,
      sortOrder: 0,
    });
    const second = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 2,
      sortOrder: 1,
    });
    mockFake.failOnce("reorder-items:list");

    await expectLiveTradeError(
      reorderItems(OWNER_A, [second.item_id, first.item_id]),
      "INTERNAL"
    );

    expect(mockFake.itemById(first.item_id)?.sort_order).toBe(0);
    expect(mockFake.itemById(second.item_id)?.sort_order).toBe(1);
    expect(mockFake.itemById(first.item_id)?.version).toBe(1);
    expect(mockFake.itemById(second.item_id)?.version).toBe(1);
    expect(mockFake.transactions.at(-1)?.committed).toBe(false);
  });
});

// ─── Concurrency corrections ─────────────────────────────────────────────────

function lastTransaction() {
  const transaction = mockFake.transactions.at(-1);
  if (!transaction) throw new Error("expected a transaction");
  return transaction;
}

function rejectedCode(result: PromiseSettledResult<unknown>): string {
  if (result.status !== "rejected") {
    throw new Error("expected a rejected result");
  }
  expect(result.reason).toBeInstanceOf(LiveTradeError);
  return (result.reason as LiveTradeError).code;
}

describe("concurrency corrections", () => {
  it("binds exactly two parameters to the group-delete classification", async () => {
    const group = mockFake.seedGroup({ owner: OWNER_A_RAW, name: "Tech" });

    await deleteGroup(OWNER_A, group.group_id, 1);

    const classify = lastTransaction().statements.find(
      (statement) => statement.marker === "delete-group:classify"
    );
    expect(classify).toBeDefined();
    expect(classify?.params).toEqual([OWNER_A_RAW, group.group_id]);
  });

  it("leaves items untouched when the group delete version is stale", async () => {
    const group = mockFake.seedGroup({ owner: OWNER_A_RAW, name: "Tech" });
    const item = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 1,
      groupId: group.group_id,
    });

    await expectLiveTradeError(
      deleteGroup(OWNER_A, group.group_id, 2),
      "EDIT_CONFLICT"
    );

    expect(mockFake.groupById(group.group_id)?.version).toBe(1);
    expect(mockFake.itemById(item.item_id)?.group_id).toBe(group.group_id);
    expect(mockFake.itemById(item.item_id)?.version).toBe(1);
    expect(lastTransaction().markers).toEqual([
      "lock",
      "delete-group:lock-row",
      "delete-group:ungroup",
      "delete-group:delete",
      "delete-group:classify",
    ]);
    expect(lastTransaction().committed).toBe(true);
  });

  it("serializes a concurrent rename and delete without partial writes", async () => {
    const group = mockFake.seedGroup({ owner: OWNER_A_RAW, name: "Tech" });
    const item = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 1,
      groupId: group.group_id,
    });

    const [renameResult, deleteResult] = await Promise.allSettled([
      updateGroup(OWNER_A, group.group_id, "Renamed", 1),
      deleteGroup(OWNER_A, group.group_id, 1),
    ]);

    if (renameResult.status === "fulfilled") {
      expect(rejectedCode(deleteResult)).toBe("EDIT_CONFLICT");
      expect(mockFake.groupById(group.group_id)?.name).toBe("Renamed");
      expect(mockFake.groupById(group.group_id)?.version).toBe(2);
      expect(mockFake.itemById(item.item_id)?.group_id).toBe(group.group_id);
      expect(mockFake.itemById(item.item_id)?.version).toBe(1);
    } else {
      throw new Error("expected the rename to hold the advisory lock first");
    }
    expect(mockFake.maxConcurrentPerOwner).toBe(1);
  });

  it("serializes a concurrent group reorder and delete without partial updates", async () => {
    const first = mockFake.seedGroup({
      owner: OWNER_A_RAW,
      name: "First",
      sortOrder: 0,
    });
    const second = mockFake.seedGroup({
      owner: OWNER_A_RAW,
      name: "Second",
      sortOrder: 1,
    });
    const item = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 1,
      groupId: first.group_id,
    });

    const [reorderResult, deleteResult] = await Promise.allSettled([
      reorderGroups(OWNER_A, [second.group_id, first.group_id]),
      deleteGroup(OWNER_A, first.group_id, 1),
    ]);

    if (reorderResult.status === "fulfilled") {
      expect(rejectedCode(deleteResult)).toBe("EDIT_CONFLICT");
      expect(mockFake.groupById(first.group_id)?.version).toBe(2);
      expect(mockFake.groupById(second.group_id)?.version).toBe(2);
      expect(mockFake.groupById(second.group_id)?.sort_order).toBe(0);
      expect(mockFake.groupById(first.group_id)?.sort_order).toBe(1);
      expect(mockFake.itemById(item.item_id)?.group_id).toBe(first.group_id);
      expect(mockFake.itemById(item.item_id)?.version).toBe(1);
    } else {
      expect(rejectedCode(reorderResult)).toBe("REORDER_STALE");
      expect(mockFake.groupById(second.group_id)?.version).toBe(1);
      expect(mockFake.groupById(second.group_id)?.sort_order).toBe(1);
      expect(mockFake.itemById(item.item_id)?.group_id).toBeNull();
    }
  });

  it("serializes a concurrent item delete and item reorder without partial updates", async () => {
    const first = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 1,
      sortOrder: 0,
    });
    const second = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 2,
      sortOrder: 1,
    });

    const [reorderResult, deleteResult] = await Promise.allSettled([
      reorderItems(OWNER_A, [second.item_id, first.item_id]),
      deleteItem(OWNER_A, first.item_id, 1),
    ]);

    if (reorderResult.status === "fulfilled") {
      expect(rejectedCode(deleteResult)).toBe("EDIT_CONFLICT");
      expect(mockFake.itemById(second.item_id)?.sort_order).toBe(0);
      expect(mockFake.itemById(first.item_id)?.sort_order).toBe(1);
      expect(mockFake.itemById(second.item_id)?.version).toBe(2);
      expect(mockFake.itemById(first.item_id)?.version).toBe(2);
    } else {
      expect(rejectedCode(reorderResult)).toBe("REORDER_STALE");
      expect(mockFake.itemById(first.item_id)).toBeUndefined();
      expect(mockFake.itemById(second.item_id)?.sort_order).toBe(1);
      expect(mockFake.itemById(second.item_id)?.version).toBe(1);
    }
  });

  it("serializes a concurrent item create and item reorder without partial updates", async () => {
    const first = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 1,
      sortOrder: 0,
    });
    const second = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 2,
      sortOrder: 1,
    });

    const [reorderResult, createResult] = await Promise.allSettled([
      reorderItems(OWNER_A, [second.item_id, first.item_id]),
      createItem(OWNER_A, itemInput({ instrumentId: 3 })),
    ]);

    expect(createResult.status).toBe("fulfilled");
    if (reorderResult.status === "fulfilled") {
      expect(mockFake.itemById(second.item_id)?.sort_order).toBe(0);
      expect(mockFake.itemById(first.item_id)?.sort_order).toBe(1);
      expect(mockFake.items).toHaveLength(3);
    } else {
      expect(rejectedCode(reorderResult)).toBe("REORDER_STALE");
      expect(mockFake.itemById(first.item_id)?.sort_order).toBe(0);
      expect(mockFake.itemById(second.item_id)?.sort_order).toBe(1);
      expect(mockFake.itemById(first.item_id)?.version).toBe(1);
      expect(mockFake.itemById(second.item_id)?.version).toBe(1);
    }
  });

  it("serializes a concurrent group create and group reorder without partial updates", async () => {
    const first = mockFake.seedGroup({
      owner: OWNER_A_RAW,
      name: "First",
      sortOrder: 0,
    });
    const second = mockFake.seedGroup({
      owner: OWNER_A_RAW,
      name: "Second",
      sortOrder: 1,
    });

    const [reorderResult, createResult] = await Promise.allSettled([
      reorderGroups(OWNER_A, [second.group_id, first.group_id]),
      createGroup(OWNER_A, "Third"),
    ]);

    expect(createResult.status).toBe("fulfilled");
    if (reorderResult.status === "fulfilled") {
      expect(mockFake.groupById(second.group_id)?.sort_order).toBe(0);
      expect(mockFake.groupById(first.group_id)?.sort_order).toBe(1);
      expect(mockFake.groups).toHaveLength(3);
    } else {
      expect(rejectedCode(reorderResult)).toBe("REORDER_STALE");
      expect(mockFake.groupById(first.group_id)?.sort_order).toBe(0);
      expect(mockFake.groupById(second.group_id)?.sort_order).toBe(1);
      expect(mockFake.groupById(first.group_id)?.version).toBe(1);
      expect(mockFake.groupById(second.group_id)?.version).toBe(1);
    }
  });

  it("leaves survivor sort orders and versions unchanged on a stale set", async () => {
    const first = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 1,
      sortOrder: 0,
    });
    const second = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 2,
      sortOrder: 1,
    });
    const removed = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 3,
      sortOrder: 2,
    });

    await deleteItem(OWNER_A, removed.item_id, 1);

    await expectLiveTradeError(
      reorderItems(OWNER_A, [second.item_id, first.item_id, removed.item_id]),
      "REORDER_STALE"
    );

    expect(mockFake.itemById(first.item_id)?.sort_order).toBe(0);
    expect(mockFake.itemById(second.item_id)?.sort_order).toBe(1);
    expect(mockFake.itemById(first.item_id)?.version).toBe(1);
    expect(mockFake.itemById(second.item_id)?.version).toBe(1);
  });

  it("reports INVALID_GROUP when a group deletion wins a reassignment race", async () => {
    const group = mockFake.seedGroup({ owner: OWNER_A_RAW, name: "Tech" });
    const item = mockFake.seedItem({
      owner: OWNER_A_RAW,
      instrumentId: 1,
    });

    const deletion = deleteGroup(OWNER_A, group.group_id, 1);
    // Let the deletion acquire its row lock before the reassignment starts.
    await Promise.resolve();
    const reassignment = updateItem(OWNER_A, item.item_id, {
      version: 1,
      groupId: group.group_id,
    });

    const [deleteResult, updateResult] = await Promise.allSettled([
      deletion,
      reassignment,
    ]);

    expect(deleteResult.status).toBe("fulfilled");
    expect(rejectedCode(updateResult)).toBe("INVALID_GROUP");
    expect(mockFake.groupById(group.group_id)).toBeUndefined();
    expect(mockFake.itemById(item.item_id)?.group_id).toBeNull();
    expect(mockFake.itemById(item.item_id)?.version).toBe(1);
  });

  it("classifies a concurrent rename versus duplicate-name creation consistently", async () => {
    const group = mockFake.seedGroup({ owner: OWNER_A_RAW, name: "Tech" });

    const [renameResult, createResult] = await Promise.allSettled([
      updateGroup(OWNER_A, group.group_id, "NewName", 1),
      createGroup(OWNER_A, " newname "),
    ]);

    const outcomes = [
      renameResult.status === "fulfilled",
      createResult.status === "fulfilled",
    ];
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    if (renameResult.status !== "fulfilled") {
      expect(rejectedCode(renameResult)).toBe("DUPLICATE_GROUP");
    } else {
      expect(rejectedCode(createResult)).toBe("DUPLICATE_GROUP");
    }
    const names = mockFake.groups
      .filter((row) => row.owner_user_id === OWNER_A_RAW)
      .map((row) => row.name.trim().toLowerCase())
      .sort();
    if (renameResult.status === "fulfilled") {
      expect(names).toEqual(["newname"]);
    } else {
      expect(names).toEqual(["newname", "tech"]);
    }
  });

  it("classifies an instrument deactivated between guard and classification", async () => {
    mockFake.beforeOnce("create-item:insert", () => {
      mockFake.deactivateInstrument(1);
    });

    await expectLiveTradeError(
      createItem(OWNER_A, itemInput({ instrumentId: 1 })),
      "INSTRUMENT_INACTIVE"
    );

    expect(mockFake.items).toHaveLength(0);
    expect(lastTransaction().markers).toContain("create-item:classify");
    expect(lastTransaction().committed).toBe(true);
  });

  it("binds every executed statement with its declared parameter count", async () => {
    const expected: Record<string, number> = {
      lock: 1,
      "list-groups": 1,
      "create-group:diagnostics": 2,
      "create-group:insert": 3,
      "create-group:read": 2,
      "update-group:update": 4,
      "update-group:classify": 2,
      "update-group:read": 2,
      "reorder-groups:lock-rows": 1,
      "reorder-groups:update": 2,
      "reorder-groups:list": 1,
      "delete-group:lock-row": 2,
      "delete-group:ungroup": 3,
      "delete-group:delete": 3,
      "delete-group:classify": 2,
      "list-items": 1,
      "create-item:insert": 12,
      "create-item:classify": 3,
      "create-item:read": 2,
      "update-item:lock-group": 2,
      "update-item:update": 4,
      "update-item:classify": 3,
      "update-item:read": 2,
      "delete-item:delete": 3,
      "delete-item:classify": 2,
      "reorder-items:lock-rows": 1,
      "reorder-items:update": 2,
      "reorder-items:list": 1,
      "instrument-master-info": 0,
      "search-instruments": 1,
    };

    const group = await createGroup(OWNER_A, "Tech");
    await updateGroup(OWNER_A, group.groupId, "Technology", group.version);
    await reorderGroups(OWNER_A, [group.groupId]);
    const item = await createItem(OWNER_A, itemInput({ instrumentId: 1 }));
    await updateItem(OWNER_A, item.itemId, {
      version: item.version,
      groupId: group.groupId,
    });
    await reorderItems(OWNER_A, [item.itemId]);
    await deleteItem(OWNER_A, item.itemId, 3);
    await deleteGroup(OWNER_A, group.groupId, 3);

    for (const transaction of mockFake.transactions) {
      for (const statement of transaction.statements) {
        expect({
          marker: statement.marker,
          params: statement.params.length,
        }).toEqual({
          marker: statement.marker,
          params: expected[statement.marker],
        });
      }
    }
  });
});

// ─── SQL contracts ───────────────────────────────────────────────────────────

describe("SQL contracts", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../../lib/live-trade/repository.ts"),
    "utf8"
  );
  const blocks = [...source.matchAll(/-- lt:([a-z0-9:-]+)([\s\S]*?)`/g)].map(
    ([, marker, body]) => ({ marker, body })
  );

  function bodyOf(marker: string): string {
    const block = blocks.find((entry) => entry.marker === marker);
    if (!block) throw new Error(`missing SQL block ${marker}`);
    return block.body;
  }

  function functionBody(name: string): string {
    const start = source.indexOf(`export async function ${name}(`);
    const next = source.indexOf("export async function", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  }

  function order(functionName: string, markers: string[]): void {
    const body = functionBody(functionName);
    const positions = markers.map((marker) =>
      body.indexOf(`-- lt:${marker}`)
    );
    for (const [index, position] of positions.entries()) {
      expect({ marker: markers[index], found: position >= 0 }).toEqual({
        marker: markers[index],
        found: true,
      });
    }
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  }

  it("uses the expected highest placeholder for every statement", () => {
    const expected: Record<string, number> = {
      lock: 1,
      "list-groups": 1,
      "create-group:diagnostics": 2,
      "create-group:insert": 3,
      "create-group:read": 2,
      "update-group:update": 4,
      "update-group:classify": 2,
      "update-group:read": 2,
      "reorder-groups:lock-rows": 1,
      "reorder-groups:update": 2,
      "reorder-groups:list": 1,
      "delete-group:lock-row": 2,
      "delete-group:ungroup": 3,
      "delete-group:delete": 3,
      "delete-group:classify": 2,
      "list-items": 1,
      "create-item:insert": 12,
      "create-item:classify": 3,
      "create-item:read": 2,
      "update-item:lock-group": 2,
      "update-item:update": 4,
      "update-item:classify": 3,
      "update-item:read": 2,
      "delete-item:delete": 3,
      "delete-item:classify": 2,
      "reorder-items:lock-rows": 1,
      "reorder-items:update": 2,
      "reorder-items:list": 1,
      "instrument-master-info": 0,
      "search-instruments": 1,
      "list-quote-instruments": 1,
      "quote-cooldown:claim": 2,
      "quote-cooldown:status": 2,
      "zones:nearest": 6,
      "zones:coverage": 2,
      "zones:expanded": 4,
    };

    expect(blocks.length).toBeGreaterThanOrEqual(Object.keys(expected).length);
    for (const { marker, body } of blocks) {
      const placeholders = [...body.matchAll(/\$(\d+)/g)].map((match) =>
        Number(match[1])
      );
      const highest = placeholders.length === 0 ? 0 : Math.max(...placeholders);
      expect({ marker, highest }).toEqual({ marker, highest: expected[marker] });
    }
  });

  it("takes the advisory lock first and row locks before mutation", () => {
    order("createGroup", [
      "lock",
      "create-group:diagnostics",
      "create-group:insert",
      "create-group:read",
    ]);
    order("updateGroup", [
      "lock",
      "update-group:update",
      "update-group:classify",
      "update-group:read",
    ]);
    order("reorderGroups", [
      "lock",
      "reorder-groups:lock-rows",
      "reorder-groups:update",
      "reorder-groups:list",
    ]);
    order("deleteGroup", [
      "lock",
      "delete-group:lock-row",
      "delete-group:ungroup",
      "delete-group:delete",
      "delete-group:classify",
    ]);
    order("createItem", [
      "lock",
      "create-item:insert",
      "create-item:classify",
      "create-item:read",
    ]);
    order("updateItem", [
      "update-item:lock-group",
      "update-item:update",
      "update-item:classify",
      "update-item:read",
    ]);
    order("deleteItem", [
      "lock",
      "delete-item:delete",
      "delete-item:classify",
    ]);
    order("reorderItems", [
      "lock",
      "reorder-items:lock-rows",
      "reorder-items:update",
      "reorder-items:list",
    ]);
  });

  it("guards every mutation by owner and expected version", () => {
    for (const marker of [
      "delete-group:lock-row",
      "reorder-groups:lock-rows",
      "reorder-items:lock-rows",
      "update-item:lock-group",
    ]) {
      expect(bodyOf(marker)).toContain("owner_user_id");
    }

    expect(bodyOf("update-group:update")).toContain(
      "owner_user_id = $2 AND version = $3"
    );
    expect(bodyOf("delete-group:ungroup")).toContain("g.version = $3");
    expect(bodyOf("delete-group:delete")).toContain(
      "owner_user_id = $1 AND version = $3"
    );
    expect(bodyOf("delete-item:delete")).toContain(
      "owner_user_id = $2 AND version = $3"
    );
    expect(bodyOf("update-item:update")).toContain(
      "owner_user_id = $2 AND version = $3"
    );
    expect(bodyOf("create-item:insert")).toContain("inst.active = TRUE");
    expect(bodyOf("create-item:insert")).toContain("inst.exchange = 'NSE'");
  });

  it("scopes the market-snapshot selection to the owner", () => {
    expect(bodyOf("list-quote-instruments")).toContain(
      "WHERE it.owner_user_id = $1"
    );
    expect(bodyOf("list-quote-instruments")).toContain(
      "JOIN instruments i ON i.instrument_id = it.instrument_id"
    );
  });

  it("claims the cooldown atomically and returns the retry hint", () => {
    const claim = bodyOf("quote-cooldown:claim");
    expect(claim).toContain("ON CONFLICT (owner_user_id) DO UPDATE");
    expect(claim).toContain("RETURNING last_request_at");
    expect(claim).toContain("make_interval(secs => $2::double precision)");
    expect(claim).not.toContain("BEGIN");
    expect(bodyOf("quote-cooldown:status")).toContain(
      "FROM live_trade_quote_state"
    );
  });

  it("selects one eligible nearest zone per instrument and side", () => {
    const nearest = bodyOf("zones:nearest");
    expect(nearest).toContain("LEFT JOIN LATERAL");
    expect(nearest).toContain("LIMIT 1");
    expect(nearest).toContain("z.lifecycle_state <> 'BROKEN'");
    expect(nearest).toContain("z.proximal > 0");
    expect(nearest).toContain("THEN -z.proximal ELSE z.proximal");
    expect(nearest).toContain("FROM zones z");
    expect(nearest).toContain("it.owner_user_id = $1");
    expect(nearest).not.toContain("LIMIT 500");
  });

  it("applies optional price eligibility with distal boundaries", () => {
    const nearest = bodyOf("zones:nearest");
    expect(nearest).toContain(
      "LEFT JOIN unnest($5::bigint[], $6::numeric[])"
    );
    expect(nearest).toContain("p.current_price");
    expect(nearest).toContain("r.current_price IS NULL");
    expect(nearest).toContain(
      "s.side = 'DEMAND' AND z.distal <= r.current_price"
    );
    expect(nearest).toContain(
      "s.side = 'SUPPLY' AND z.distal >= r.current_price"
    );
    // Price eligibility is part of the WHERE clause, so it is applied before
    // the preferred-timeframe ORDER BY ranking and its fallback.
    expect(nearest.indexOf("z.distal <= r.current_price")).toBeLessThan(
      nearest.indexOf("ORDER BY")
    );
  });

  it("rejects PostgreSQL NaN and Infinity boundaries in nearest selection", () => {
    const nearest = bodyOf("zones:nearest");
    expect(nearest).toContain("z.proximal <> 'NaN'::numeric");
    expect(nearest).toContain("z.proximal <> 'Infinity'::numeric");
    expect(nearest).toContain("z.distal <> 'NaN'::numeric");
    expect(nearest).toContain("z.distal <> 'Infinity'::numeric");
    expect(nearest).toContain("z.distal <> '-Infinity'::numeric");
  });

  it("derives coverage from scans, batches and current universe membership", () => {
    const coverage = bodyOf("zones:coverage");
    expect(coverage).toContain("nifty500_membership");
    expect(coverage).toContain("scan_job_batches");
    expect(coverage).toContain("j.instrument_ids @> to_jsonb(r.instrument_id)");
    expect(coverage).toContain("b.instrument_ids @> to_jsonb(r.instrument_id)");
    expect(coverage).toContain("has_unattributable_scan");
    expect(coverage).toContain("it.owner_user_id = $1");
  });

  it("attributes coverage set-wise instead of per-instrument subqueries", () => {
    const coverage = bodyOf("zones:coverage");
    expect(coverage).toContain("UNION ALL");
    expect(coverage).toContain("max(e.completed_at)");
    expect(coverage).toContain("GROUP BY e.instrument_id");
    // A correlated GREATEST((SELECT max(...)) ...) rescans the scan history
    // once per requested instrument and degrades with history size.
    expect(coverage).not.toMatch(/GREATEST\(\s*\(SELECT max\(/);
    expect(coverage).not.toContain("GREATEST");
  });

  it("paginates the expanded zone list deterministically with an owner guard", () => {
    const expanded = bodyOf("zones:expanded");
    expect(expanded).toContain("it.owner_user_id = $2");
    expect(expanded).toContain("it.instrument_id = $1");
    expect(expanded).toContain(
      "ORDER BY z.formation_ts DESC, z.score DESC, z.zone_id ASC"
    );
    expect(expanded).toContain("LIMIT $3 OFFSET $4");
    expect(expanded).not.toContain("lifecycle_state <>");
    expect(expanded).not.toContain("z.score >=");
  });
});

// ─── Error sanitation ────────────────────────────────────────────────────────

describe("database error sanitation", () => {
  it("maps the item unique constraint to DUPLICATE_ITEM", async () => {
    mockFake.failOnce(
      "create-item:insert",
      Object.assign(new Error("simulated"), {
        code: "23505",
        constraint: "live_trade_items_owner_instrument_uq",
      })
    );

    await expectLiveTradeError(
      createItem(OWNER_A, itemInput({ instrumentId: 1 })),
      "DUPLICATE_ITEM"
    );
  });

  it("does not leak SQL text, table names or stack traces", async () => {
    mockFake.failOnce(
      "list-items",
      Object.assign(new Error('relation "live_trade_items" does not exist'), {
        code: "42P01",
        table: "live_trade_items",
        detail: "SELECT it.* FROM live_trade_items it",
      })
    );

    const error = await expectLiveTradeError(listItems(OWNER_A), "INTERNAL");

    expect(error.message).toBe("An unexpected error occurred.");
    expect(error.message).not.toContain("live_trade");
    expect(error.details).toBeUndefined();
    const logged = JSON.stringify(
      (console.error as jest.Mock).mock.calls,
      (_key, value) => value
    );
    expect(logged).not.toContain("live_trade_items");
    expect(logged).not.toContain("SELECT");
  });

  it("rejects a forged owner id before any statement runs", async () => {
    const forged = "" as LiveTradeOwnerId;
    await expectLiveTradeError(listGroups(forged), "UNAUTHENTICATED");
    expect(mockFake.standaloneMarkers).toEqual([]);
    expect(mockFake.transactions).toEqual([]);
  });
});
