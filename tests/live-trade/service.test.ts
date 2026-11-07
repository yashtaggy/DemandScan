/**
 * Live Trade service tests.
 *
 * These exercise the boundary between untrusted route input and the
 * repository: parser failures must stop before any database statement, path
 * identifiers are shape-checked, query version parameters are normalized, and
 * validated values reach the owner-scoped repository unchanged.
 */

import type { LiveTradeOwnerId } from "@/lib/live-trade/types";
import { LiveTradeError } from "@/lib/live-trade/errors";
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
} from "@/lib/live-trade/service";
import { FakeLiveTradeDb } from "./fake-db";

const mockFake = new FakeLiveTradeDb();
const globalStore = globalThis as typeof globalThis & {
  __liveTradeDb?: unknown;
};

jest.mock("@/lib/db", () => ({
  getDb: () => globalStore.__liveTradeDb,
}));

const OWNER_A = "owner-a" as LiveTradeOwnerId;

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

function expectNoDatabaseWork(): void {
  expect(mockFake.transactions).toEqual([]);
  expect(mockFake.standaloneMarkers).toEqual([]);
}

beforeEach(() => {
  mockFake.reset();
  mockFake.seedInstrument({ instrument_id: 1 });
  mockFake.seedInstrument({ instrument_id: 2 });
  globalStore.__liveTradeDb = mockFake.sql;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Owner and path guards ──────────────────────────────────────────────────

describe("owner and path guards", () => {
  it("rejects a forged owner id before parsing", async () => {
    await expectLiveTradeError(createGroup("" as LiveTradeOwnerId, { name: "X" }), "UNAUTHENTICATED");
    expectNoDatabaseWork();
  });

  it("rejects a malformed group id with INVALID_QUERY", async () => {
    await expectLiveTradeError(
      updateGroup(OWNER_A, "not-a-uuid", { name: "X", version: 1 }),
      "INVALID_QUERY"
    );
    expectNoDatabaseWork();
  });

  it("rejects a malformed item id with INVALID_QUERY", async () => {
    await expectLiveTradeError(
      deleteItem(OWNER_A, "not-a-uuid", 1),
      "INVALID_QUERY"
    );
    expectNoDatabaseWork();
  });
});

// ─── Group inputs ───────────────────────────────────────────────────────────

describe("group inputs", () => {
  it("rejects a blank name without touching the database", async () => {
    await expectLiveTradeError(createGroup(OWNER_A, { name: "   " }), "INVALID_BODY");
    expectNoDatabaseWork();
  });

  it("rejects a client-supplied owner field", async () => {
    const error = await expectLiveTradeError(
      createGroup(OWNER_A, { name: "Tech", ownerUserId: "owner-b" }),
      "INVALID_BODY"
    );
    expect(error.message).toBe(
      "The owner is resolved from the session and must not be supplied."
    );
    expectNoDatabaseWork();
  });

  it("requires the version on rename", async () => {
    const group = await createGroup(OWNER_A, { name: "Tech" });
    await expectLiveTradeError(
      updateGroup(OWNER_A, group.groupId, { name: "Technology" }),
      "INVALID_BODY"
    );
  });

  it("trims names before persistence and enforces uniqueness", async () => {
    const created = await createGroup(OWNER_A, { name: "  Tech  " });
    expect(created.name).toBe("Tech");
    await expectLiveTradeError(
      createGroup(OWNER_A, { name: " tech " }),
      "DUPLICATE_GROUP"
    );
  });

  it("normalizes a numeric string version from the query string", async () => {
    const group = await createGroup(OWNER_A, { name: "Tech" });
    await deleteGroup(OWNER_A, group.groupId, String(group.version));
    expect(mockFake.groupById(group.groupId)).toBeUndefined();
  });

  it("rejects malformed or missing query versions", async () => {
    const group = await createGroup(OWNER_A, { name: "Tech" });
    await expectLiveTradeError(
      deleteGroup(OWNER_A, group.groupId, "abc"),
      "INVALID_QUERY"
    );
    await expectLiveTradeError(
      deleteGroup(OWNER_A, group.groupId, undefined),
      "INVALID_QUERY"
    );
    expect(mockFake.groupById(group.groupId)).toBeDefined();
  });

  it("rejects duplicate or malformed group reorder ids before the database", async () => {
    await expectLiveTradeError(
      reorderGroups(OWNER_A, {
        orderedGroupIds: [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000001",
        ],
      }),
      "INVALID_BODY"
    );
    await expectLiveTradeError(
      reorderGroups(OWNER_A, { orderedGroupIds: ["nope"] }),
      "INVALID_BODY"
    );
    expectNoDatabaseWork();
  });

  it("passes a validated group reorder through to the repository", async () => {
    const first = await createGroup(OWNER_A, { name: "First" });
    const second = await createGroup(OWNER_A, { name: "Second" });

    const ordered = await reorderGroups(OWNER_A, {
      orderedGroupIds: [second.groupId, first.groupId],
    });

    expect(ordered.map((group) => group.groupId)).toEqual([
      second.groupId,
      first.groupId,
    ]);
  });
});

// ─── Item inputs ────────────────────────────────────────────────────────────

describe("item inputs", () => {
  it("defaults an omitted timeframe to 1D", async () => {
    const item = await createItem(OWNER_A, { instrumentId: 1 });
    expect(item.timeframe).toBe("1D");
  });

  it("stores an explicit null timeframe as Any", async () => {
    const item = await createItem(OWNER_A, { instrumentId: 1, timeframe: null });
    expect(item.timeframe).toBeNull();
  });

  it("preserves an omitted timeframe on update", async () => {
    const item = await createItem(OWNER_A, { instrumentId: 1 });
    const updated = await updateItem(OWNER_A, item.itemId, {
      version: item.version,
      notes: "no timeframe",
    });
    expect(updated.timeframe).toBe("1D");
  });

  it("clears the timeframe on an explicit null update", async () => {
    const item = await createItem(OWNER_A, { instrumentId: 1 });
    const updated = await updateItem(OWNER_A, item.itemId, {
      version: item.version,
      timeframe: null,
    });
    expect(updated.timeframe).toBeNull();
  });

  it("rejects a client-supplied owner, instrument change or sort order", async () => {
    const item = await createItem(OWNER_A, { instrumentId: 1 });

    for (const body of [
      { version: item.version, ownerUserId: "owner-b" },
      { version: item.version, instrumentId: 2 },
      { version: item.version, sortOrder: 9 },
    ]) {
      await expectLiveTradeError(
        updateItem(OWNER_A, item.itemId, body),
        "INVALID_BODY"
      );
    }

    const stored = mockFake.itemById(item.itemId);
    expect(stored?.instrument_id).toBe(1);
    expect(stored?.version).toBe(1);
  });

  it("rejects invalid priority and price values before the database", async () => {
    await expectLiveTradeError(
      createItem(OWNER_A, { instrumentId: 1, priority: "URGENT" }),
      "INVALID_BODY"
    );
    await expectLiveTradeError(
      createItem(OWNER_A, { instrumentId: 1, entryPrice: 0 }),
      "INVALID_BODY"
    );
    await expectLiveTradeError(
      createItem(OWNER_A, { instrumentId: 1, targetPrice: 10.12345 }),
      "INVALID_BODY"
    );
    expectNoDatabaseWork();
  });

  it("surfaces the inactive-instrument decision from the repository", async () => {
    mockFake.seedInstrument({ instrument_id: 9, active: false });
    await expectLiveTradeError(
      createItem(OWNER_A, { instrumentId: 9 }),
      "INSTRUMENT_INACTIVE"
    );
    expect(mockFake.items).toHaveLength(0);
  });

  it("returns NOT_FOUND for another owner's item", async () => {
    const foreign = mockFake.seedItem({
      owner: "owner-b",
      instrumentId: 2,
    });
    await expectLiveTradeError(
      updateItem(OWNER_A, foreign.item_id, {
        version: 1,
        notes: "hijack",
      }),
      "NOT_FOUND"
    );
    expect(mockFake.itemById(foreign.item_id)?.notes).toBe("");
  });

  it("rejects duplicate, missing and foreign item reorder ids", async () => {
    await expectLiveTradeError(
      reorderItems(OWNER_A, {
        orderedItemIds: [
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000001",
        ],
      }),
      "INVALID_BODY"
    );

    const first = await createItem(OWNER_A, { instrumentId: 1 });
    const second = await createItem(OWNER_A, { instrumentId: 2 });

    await expectLiveTradeError(
      reorderItems(OWNER_A, { orderedItemIds: [first.itemId] }),
      "REORDER_STALE"
    );
    await expectLiveTradeError(
      reorderItems(OWNER_A, {
        orderedItemIds: [
          first.itemId,
          second.itemId,
          "00000000-0000-4000-8000-0000000000ff",
        ],
      }),
      "REORDER_STALE"
    );
  });

  it("accepts an empty reorder only when the owner has no items", async () => {
    await expect(
      reorderItems(OWNER_A, { orderedItemIds: [] })
    ).resolves.toEqual([]);

    await createItem(OWNER_A, { instrumentId: 1 });
    await expectLiveTradeError(
      reorderItems(OWNER_A, { orderedItemIds: [] }),
      "REORDER_STALE"
    );
  });

  it("delegates valid item reads and deletes", async () => {
    const item = await createItem(OWNER_A, { instrumentId: 1 });

    const items = await listItems(OWNER_A);
    expect(items.map((row) => row.itemId)).toEqual([item.itemId]);

    await deleteItem(OWNER_A, item.itemId, String(item.version));
    await expect(listItems(OWNER_A)).resolves.toEqual([]);
  });

  it("delegates group listing", async () => {
    await createGroup(OWNER_A, { name: "Only group" });
    const groups = await listGroups(OWNER_A);
    expect(groups.map((group) => group.name)).toEqual(["Only group"]);
  });
});
