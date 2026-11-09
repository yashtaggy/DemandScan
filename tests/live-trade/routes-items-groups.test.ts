/**
 * Route tests for Live Trade items and groups.
 *
 * The real HTTP helper, service, validation and repository run against the
 * stateful fake database. Assertions cover status codes, error codes,
 * optimistic concurrency, ownership isolation and mutation-origin protection.
 */

jest.mock("next/server", () => ({
  NextResponse: {
    json: (
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> }
    ) => ({
      status: init?.status ?? 200,
      headers: new Headers(init?.headers ?? {}),
      json: async () => body,
    }),
  },
}));

jest.mock("@/lib/kite-session", () => ({
  getSessionFromRequest: jest.fn(),
}));

jest.mock("@/lib/db", () => ({
  getDb: () => globalStore.__liveTradeDb,
}));

import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/kite-session";
import { POST as createItemRoute } from "@/app/api/live-trade/items/route";
import {
  DELETE as deleteItemRoute,
  PATCH as patchItemRoute,
} from "@/app/api/live-trade/items/[itemId]/route";
import { PATCH as reorderItemsRoute } from "@/app/api/live-trade/items/reorder/route";
import {
  GET as listGroupsRoute,
  POST as createGroupRoute,
} from "@/app/api/live-trade/groups/route";
import {
  DELETE as deleteGroupRoute,
  PATCH as patchGroupRoute,
} from "@/app/api/live-trade/groups/[groupId]/route";
import { PATCH as reorderGroupsRoute } from "@/app/api/live-trade/groups/reorder/route";
import { FakeLiveTradeDb } from "./fake-db";

const mockFake = new FakeLiveTradeDb();
const globalStore = globalThis as typeof globalThis & {
  __liveTradeDb?: unknown;
};

const sessionMock = getSessionFromRequest as jest.Mock;

// Every test asserts a specific part of this JSON envelope structurally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = any;

type MockResponse = {
  status: number;
  headers: Headers;
  json: () => Promise<unknown>;
};

interface RequestOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  origin?: string | null;
  contentType?: string | null;
}

function request(path: string, options: RequestOptions = {}): NextRequest {
  const method = options.method ?? "GET";
  const headers = new Headers();
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? "https://app.example");
  }
  if (method !== "GET" && method !== "HEAD") {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined;
  return new Request(`https://app.example${path}`, {
    method,
    headers,
    body,
  }) as unknown as NextRequest;
}

async function call(
  handler: (req: NextRequest) => Promise<unknown>,
  req: NextRequest
): Promise<{ status: number; headers: Headers; body: JsonBody }> {
  const res = (await handler(req)) as MockResponse;
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function callDynamic<T extends Record<string, string>>(
  handler: (
    req: NextRequest,
    ctx: { params: Promise<T> }
  ) => Promise<unknown>,
  req: NextRequest,
  params: T
): Promise<{ status: number; headers: Headers; body: JsonBody }> {
  const res = (await handler(req, {
    params: Promise.resolve(params),
  })) as MockResponse;
  return { status: res.status, headers: res.headers, body: await res.json() };
}

function signIn(): void {
  sessionMock.mockResolvedValue({ userId: "owner-a" } as unknown as never);
}

function itemBody(overrides: Record<string, unknown> = {}) {
  return { instrumentId: 1, ...overrides };
}

const FOREIGN_UUID = "00000000-0000-4000-8000-000000000999";
const MALFORMED_ID = "not-a-uuid";

beforeEach(() => {
  mockFake.reset();
  globalStore.__liveTradeDb = mockFake.sql;
  mockFake.seedInstrument({
    instrument_id: 1,
    symbol: "INFY",
    company_name: "Infosys Limited",
  });
  mockFake.seedInstrument({
    instrument_id: 2,
    symbol: "TCS",
    company_name: "Tata Consultancy Services",
  });
  mockFake.seedInstrument({
    instrument_id: 3,
    symbol: "OLDCO",
    active: false,
  });
  mockFake.seedInstrument({
    instrument_id: 4,
    symbol: "BSEONLY",
    exchange: "BSE",
  });

  sessionMock.mockReset();
  signIn();
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Item creation ──────────────────────────────────────────────────────────

describe("POST /api/live-trade/items", () => {
  it("creates an item with server defaults and returns 201", async () => {
    const { status, body } = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        body: itemBody(),
      })
    );

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      instrumentId: 1,
      symbol: "INFY",
      companyName: "Infosys Limited",
      groupId: null,
      priority: "MEDIUM",
      direction: null,
      timeframe: "1D",
      tradeStatus: "WATCHING",
      sortOrder: 0,
      version: 1,
      entryPrice: null,
      targetPrice: null,
      stopLoss: null,
      notes: "",
    });
    expect(mockFake.items).toHaveLength(1);
    expect(mockFake.items[0].owner_user_id).toBe("owner-a");
  });

  it("keeps explicit null timeframe as Any", async () => {
    const { status, body } = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        body: itemBody({ timeframe: null, direction: "BUY", priority: "HIGH" }),
      })
    );
    expect(status).toBe(201);
    expect(body.data.timeframe).toBeNull();
    expect(body.data.direction).toBe("BUY");
    expect(body.data.priority).toBe("HIGH");
  });

  it("creates a second independent entry for an instrument already on the board", async () => {
    mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    const { status, body } = await call(
      createItemRoute,
      request("/api/live-trade/items", { method: "POST", body: itemBody() })
    );
    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.instrumentId).toBe(1);
    expect(body.data.symbol).toBe("INFY");
    const ownerItems = mockFake.items.filter(
      (item) => item.owner_user_id === "owner-a"
    );
    expect(ownerItems).toHaveLength(2);
    expect(new Set(ownerItems.map((item) => item.item_id)).size).toBe(2);
  });

  it("rejects an unknown instrument with 422 INSTRUMENT_NOT_SYNCED", async () => {
    const { status, body } = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        body: itemBody({ instrumentId: 999 }),
      })
    );
    expect(status).toBe(422);
    expect(body.code).toBe("INSTRUMENT_NOT_SYNCED");
  });

  it("rejects an inactive instrument with 422 INSTRUMENT_INACTIVE", async () => {
    const { status, body } = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        body: itemBody({ instrumentId: 3 }),
      })
    );
    expect(status).toBe(422);
    expect(body.code).toBe("INSTRUMENT_INACTIVE");
  });

  it("rejects a non-NSE instrument with 422 INSTRUMENT_NOT_SYNCED", async () => {
    const { status, body } = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        body: itemBody({ instrumentId: 4 }),
      })
    );
    expect(status).toBe(422);
    expect(body.code).toBe("INSTRUMENT_NOT_SYNCED");
  });

  it("rejects another owner's group with 422 INVALID_GROUP", async () => {
    const foreign = mockFake.seedGroup({ owner: "owner-b", name: "Theirs" });
    const { status, body } = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        body: itemBody({ groupId: foreign.group_id }),
      })
    );
    expect(status).toBe(422);
    expect(body.code).toBe("INVALID_GROUP");
  });

  it("rejects an unknown group with 422 INVALID_GROUP", async () => {
    const { status, body } = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        body: itemBody({ groupId: FOREIGN_UUID }),
      })
    );
    expect(status).toBe(422);
    expect(body.code).toBe("INVALID_GROUP");
  });

  it("attaches an item to an owned group", async () => {
    const group = mockFake.seedGroup({ owner: "owner-a", name: "Momentum" });
    const { status, body } = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        body: itemBody({ groupId: group.group_id }),
      })
    );
    expect(status).toBe(201);
    expect(body.data.groupId).toBe(group.group_id);
  });

  it("rejects client-supplied server fields", async () => {
    for (const field of ["ownerUserId", "ownerId", "version", "sortOrder", "itemId"]) {
      const { status, body } = await call(
        createItemRoute,
        request("/api/live-trade/items", {
          method: "POST",
          body: itemBody({ [field]: 1 }),
        })
      );
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_BODY");
      expect(body.details.issues.map((i: { field: string }) => i.field)).toContain(field);
    }
    expect(mockFake.items).toEqual([]);
  });

  it("rejects an item limit overrun with 409", async () => {
    for (let index = 0; index < 200; index += 1) {
      mockFake.seedItem({
        owner: "owner-a",
        instrumentId: 1000 + index,
      });
    }
    const { status, body } = await call(
      createItemRoute,
      request("/api/live-trade/items", { method: "POST", body: itemBody() })
    );
    expect(status).toBe(409);
    expect(body.code).toBe("ITEM_LIMIT");
  });

  it("rejects malformed, empty, non-object and oversized bodies", async () => {
    const malformed = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        rawBody: "{not-json",
      })
    );
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("INVALID_BODY");

    const empty = await call(
      createItemRoute,
      request("/api/live-trade/items", { method: "POST", rawBody: "" })
    );
    expect(empty.status).toBe(400);

    const array = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        body: [itemBody()],
      })
    );
    expect(array.status).toBe(400);

    const wrongType = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        body: itemBody(),
        contentType: "text/plain",
      })
    );
    expect(wrongType.status).toBe(400);

    const oversized = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        rawBody: JSON.stringify({ notes: "x".repeat(70_000) }),
      })
    );
    expect(oversized.status).toBe(413);
    expect(oversized.body.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

// ─── Item update ────────────────────────────────────────────────────────────

describe("PATCH /api/live-trade/items/[itemId]", () => {
  it("updates one field and preserves an omitted timeframe", async () => {
    const item = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    const { status, body } = await callDynamic(
      patchItemRoute,
      request(`/api/live-trade/items/${item.item_id}`, {
        method: "PATCH",
        body: { version: 1, priority: "HIGH" },
      }),
      { itemId: item.item_id }
    );
    expect(status).toBe(200);
    expect(body.data.priority).toBe("HIGH");
    expect(body.data.timeframe).toBe("1D");
    expect(body.data.version).toBe(2);
  });

  it("distinguishes omitted timeframe from explicit null", async () => {
    const item = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });

    const cleared = await callDynamic(
      patchItemRoute,
      request(`/api/live-trade/items/${item.item_id}`, {
        method: "PATCH",
        body: { version: 1, timeframe: null },
      }),
      { itemId: item.item_id }
    );
    expect(cleared.body.data.timeframe).toBeNull();
    expect(cleared.body.data.version).toBe(2);

    const unrelated = await callDynamic(
      patchItemRoute,
      request(`/api/live-trade/items/${item.item_id}`, {
        method: "PATCH",
        body: { version: 2, notes: "still Any" },
      }),
      { itemId: item.item_id }
    );
    expect(unrelated.body.data.timeframe).toBeNull();
    expect(unrelated.body.data.version).toBe(3);
  });

  it("clears a group with an explicit null", async () => {
    const group = mockFake.seedGroup({ owner: "owner-a", name: "Momentum" });
    const item = mockFake.seedItem({
      owner: "owner-a",
      instrumentId: 1,
      groupId: group.group_id,
    });
    const { body } = await callDynamic(
      patchItemRoute,
      request(`/api/live-trade/items/${item.item_id}`, {
        method: "PATCH",
        body: { version: 1, groupId: null },
      }),
      { itemId: item.item_id }
    );
    expect(body.data.groupId).toBeNull();
  });

  it("rejects a stale version with 409 and the current version", async () => {
    const item = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    const { status, body } = await callDynamic(
      patchItemRoute,
      request(`/api/live-trade/items/${item.item_id}`, {
        method: "PATCH",
        body: { version: 5, priority: "HIGH" },
      }),
      { itemId: item.item_id }
    );
    expect(status).toBe(409);
    expect(body.code).toBe("EDIT_CONFLICT");
    expect(body.details).toEqual({ currentVersion: 1 });
  });

  it("returns 404 for a missing or foreign item", async () => {
    const foreign = mockFake.seedItem({ owner: "owner-b", instrumentId: 2 });
    for (const itemId of [FOREIGN_UUID, foreign.item_id]) {
      const { status, body } = await callDynamic(
        patchItemRoute,
        request(`/api/live-trade/items/${itemId}`, {
          method: "PATCH",
          body: { version: 1, priority: "HIGH" },
        }),
        { itemId }
      );
      expect(status).toBe(404);
      expect(body.code).toBe("NOT_FOUND");
    }
  });

  it("rejects a malformed path id with 400 before reading the body", async () => {
    // The non-JSON content type would be rejected by body parsing; INVALID_QUERY
    // proves the id is checked first.
    const { status, body } = await callDynamic(
      patchItemRoute,
      request(`/api/live-trade/items/${MALFORMED_ID}`, {
        method: "PATCH",
        contentType: "text/plain",
        rawBody: "not json",
      }),
      { itemId: MALFORMED_ID }
    );
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_QUERY");
  });

  it("rejects immutable and server-controlled fields", async () => {
    const item = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    for (const field of ["instrumentId", "ownerUserId", "sortOrder", "itemId"]) {
      const { status, body } = await callDynamic(
        patchItemRoute,
        request(`/api/live-trade/items/${item.item_id}`, {
          method: "PATCH",
          body: { version: 1, [field]: 2 },
        }),
        { itemId: item.item_id }
      );
      expect(status).toBe(400);
      expect(body).toMatchObject({ code: "INVALID_BODY" });
    }
  });

  it("rejects a group owned by another user with 422", async () => {
    const foreign = mockFake.seedGroup({ owner: "owner-b", name: "Theirs" });
    const item = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    const { status, body } = await callDynamic(
      patchItemRoute,
      request(`/api/live-trade/items/${item.item_id}`, {
        method: "PATCH",
        body: { version: 1, groupId: foreign.group_id },
      }),
      { itemId: item.item_id }
    );
    expect(status).toBe(422);
    expect(body.code).toBe("INVALID_GROUP");
  });

  it("requires at least one mutable field and a version", async () => {
    const item = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    const noFields = await callDynamic(
      patchItemRoute,
      request(`/api/live-trade/items/${item.item_id}`, {
        method: "PATCH",
        body: { version: 1 },
      }),
      { itemId: item.item_id }
    );
    expect(noFields.status).toBe(400);

    const noVersion = await callDynamic(
      patchItemRoute,
      request(`/api/live-trade/items/${item.item_id}`, {
        method: "PATCH",
        body: { priority: "HIGH" },
      }),
      { itemId: item.item_id }
    );
    expect(noVersion.status).toBe(400);
  });
});

// ─── Item delete ────────────────────────────────────────────────────────────

describe("DELETE /api/live-trade/items/[itemId]", () => {
  it("deletes the item with a matching version", async () => {
    const item = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    const { status, body } = await callDynamic(
      deleteItemRoute,
      request(`/api/live-trade/items/${item.item_id}?version=1`, {
        method: "DELETE",
      }),
      { itemId: item.item_id }
    );
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, data: { deleted: true } });
    expect(mockFake.items).toEqual([]);
  });

  it("requires a valid version query parameter", async () => {
    const item = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    for (const search of ["", "?version=", "?version=abc", "?version=0", "?version=1.5"]) {
      const { status, body } = await callDynamic(
        deleteItemRoute,
        request(`/api/live-trade/items/${item.item_id}${search}`, {
          method: "DELETE",
        }),
        { itemId: item.item_id }
      );
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_QUERY");
    }
    expect(mockFake.items).toHaveLength(1);
  });

  it("returns 404 for a foreign or missing item", async () => {
    const foreign = mockFake.seedItem({ owner: "owner-b", instrumentId: 2 });
    for (const itemId of [FOREIGN_UUID, foreign.item_id]) {
      const { status, body } = await callDynamic(
        deleteItemRoute,
        request(`/api/live-trade/items/${itemId}?version=1`, {
          method: "DELETE",
        }),
        { itemId }
      );
      expect(status).toBe(404);
      expect(body.code).toBe("NOT_FOUND");
    }
    expect(mockFake.items).toHaveLength(1);
  });

  it("rejects a stale delete with 409", async () => {
    const item = mockFake.seedItem({ owner: "owner-a", instrumentId: 1, version: 3 });
    const { status, body } = await callDynamic(
      deleteItemRoute,
      request(`/api/live-trade/items/${item.item_id}?version=1`, {
        method: "DELETE",
      }),
      { itemId: item.item_id }
    );
    expect(status).toBe(409);
    expect(body.code).toBe("EDIT_CONFLICT");
    expect(body.details).toEqual({ currentVersion: 3 });
  });

  it("rejects a malformed path id with 400", async () => {
    const { status, body } = await callDynamic(
      deleteItemRoute,
      request(`/api/live-trade/items/${MALFORMED_ID}?version=1`, {
        method: "DELETE",
      }),
      { itemId: MALFORMED_ID }
    );
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_QUERY");
  });
});

// ─── Item reorder ───────────────────────────────────────────────────────────

describe("PATCH /api/live-trade/items/reorder", () => {
  it("applies the submitted order and increments versions", async () => {
    const first = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    const second = mockFake.seedItem({ owner: "owner-a", instrumentId: 2 });

    const { status, body } = await call(
      reorderItemsRoute,
      request("/api/live-trade/items/reorder", {
        method: "PATCH",
        body: { orderedItemIds: [second.item_id, first.item_id] },
      })
    );

    expect(status).toBe(200);
    expect(body.data.items.map((i: { itemId: string }) => i.itemId)).toEqual([
      second.item_id,
      first.item_id,
    ]);
    expect(body.data.items.map((i: { version: number }) => i.version)).toEqual([2, 2]);
  });

  it("rejects duplicate and malformed IDs", async () => {
    const first = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    mockFake.seedItem({ owner: "owner-a", instrumentId: 2 });

    const duplicate = await call(
      reorderItemsRoute,
      request("/api/live-trade/items/reorder", {
        method: "PATCH",
        body: { orderedItemIds: [first.item_id, first.item_id] },
      })
    );
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code).toBe("INVALID_BODY");

    const malformed = await call(
      reorderItemsRoute,
      request("/api/live-trade/items/reorder", {
        method: "PATCH",
        body: { orderedItemIds: [first.item_id, MALFORMED_ID] },
      })
    );
    expect(malformed.status).toBe(400);
  });

  it("rejects a set that does not match the owner's items", async () => {
    const first = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    mockFake.seedItem({ owner: "owner-a", instrumentId: 2 });

    const missing = await call(
      reorderItemsRoute,
      request("/api/live-trade/items/reorder", {
        method: "PATCH",
        body: { orderedItemIds: [first.item_id] },
      })
    );
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe("REORDER_STALE");

    const withForeign = await call(
      reorderItemsRoute,
      request("/api/live-trade/items/reorder", {
        method: "PATCH",
        body: { orderedItemIds: [first.item_id, FOREIGN_UUID] },
      })
    );
    expect(withForeign.status).toBe(409);
  });

  it("accepts an empty reorder only when the owner has no items", async () => {
    const none = await call(
      reorderItemsRoute,
      request("/api/live-trade/items/reorder", {
        method: "PATCH",
        body: { orderedItemIds: [] },
      })
    );
    expect(none.status).toBe(200);
    expect(none.body.data.items).toEqual([]);

    mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    const withItems = await call(
      reorderItemsRoute,
      request("/api/live-trade/items/reorder", {
        method: "PATCH",
        body: { orderedItemIds: [] },
      })
    );
    expect(withItems.status).toBe(409);
    expect(withItems.body.code).toBe("REORDER_STALE");
  });

  it("rejects a foreign owner's IDs and leaves rows unchanged", async () => {
    const mine = mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    const theirs = mockFake.seedItem({ owner: "owner-b", instrumentId: 2 });

    const { status } = await call(
      reorderItemsRoute,
      request("/api/live-trade/items/reorder", {
        method: "PATCH",
        body: { orderedItemIds: [theirs.item_id] },
      })
    );
    expect(status).toBe(409);
    expect(mockFake.itemById(mine.item_id)?.sort_order).toBe(0);
    expect(mockFake.itemById(mine.item_id)?.version).toBe(1);
  });
});

// ─── Groups ─────────────────────────────────────────────────────────────────

describe("groups", () => {
  it("lists groups in saved order", async () => {
    mockFake.seedGroup({ owner: "owner-a", name: "Second", sortOrder: 1 });
    mockFake.seedGroup({ owner: "owner-a", name: "First", sortOrder: 0 });
    mockFake.seedGroup({ owner: "owner-b", name: "Theirs", sortOrder: 0 });

    const { status, body } = await call(
      listGroupsRoute,
      request("/api/live-trade/groups")
    );
    expect(status).toBe(200);
    expect(body.data.groups.map((g: { name: string }) => g.name)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("creates a group with 201 and server-managed order", async () => {
    mockFake.seedGroup({ owner: "owner-a", name: "Existing" });
    const { status, body } = await call(
      createGroupRoute,
      request("/api/live-trade/groups", {
        method: "POST",
        body: { name: "  Swing  " },
      })
    );
    expect(status).toBe(201);
    expect(body.data).toMatchObject({
      name: "Swing",
      sortOrder: 1,
      version: 1,
    });
  });

  it("rejects duplicate names case-insensitively", async () => {
    mockFake.seedGroup({ owner: "owner-a", name: "Swing" });
    const { status, body } = await call(
      createGroupRoute,
      request("/api/live-trade/groups", {
        method: "POST",
        body: { name: "  swing " },
      })
    );
    expect(status).toBe(409);
    expect(body.code).toBe("DUPLICATE_GROUP");
  });

  it("enforces the 20-group limit", async () => {
    for (let index = 0; index < 20; index += 1) {
      mockFake.seedGroup({ owner: "owner-a", name: `Group ${index}` });
    }
    const { status, body } = await call(
      createGroupRoute,
      request("/api/live-trade/groups", {
        method: "POST",
        body: { name: "One more" },
      })
    );
    expect(status).toBe(409);
    expect(body.code).toBe("GROUP_LIMIT");
  });

  it("validates the group name", async () => {
    for (const name of ["", "   ", "a".repeat(61), "line\nbreak"]) {
      const { status, body } = await call(
        createGroupRoute,
        request("/api/live-trade/groups", {
          method: "POST",
          body: { name },
        })
      );
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_BODY");
    }
  });

  it("rejects client-supplied server fields on create", async () => {
    for (const field of ["ownerUserId", "ownerId", "version", "sortOrder"]) {
      const { status } = await call(
        createGroupRoute,
        request("/api/live-trade/groups", {
          method: "POST",
          body: { name: "Swing", [field]: 1 },
        })
      );
      expect(status).toBe(400);
    }
  });

  it("renames a group and increments its version", async () => {
    const group = mockFake.seedGroup({ owner: "owner-a", name: "Old" });
    const { status, body } = await callDynamic(
      patchGroupRoute,
      request(`/api/live-trade/groups/${group.group_id}`, {
        method: "PATCH",
        body: { name: "New", version: 1 },
      }),
      { groupId: group.group_id }
    );
    expect(status).toBe(200);
    expect(body.data.name).toBe("New");
    expect(body.data.version).toBe(2);
  });

  it("rejects a stale rename and a duplicate rename", async () => {
    const group = mockFake.seedGroup({ owner: "owner-a", name: "Old" });
    mockFake.seedGroup({ owner: "owner-a", name: "Taken" });

    const stale = await callDynamic(
      patchGroupRoute,
      request(`/api/live-trade/groups/${group.group_id}`, {
        method: "PATCH",
        body: { name: "New", version: 5 },
      }),
      { groupId: group.group_id }
    );
    expect(stale.status).toBe(409);
    expect(stale.body.details).toEqual({ currentVersion: 1 });

    const duplicate = await callDynamic(
      patchGroupRoute,
      request(`/api/live-trade/groups/${group.group_id}`, {
        method: "PATCH",
        body: { name: "taken", version: 1 },
      }),
      { groupId: group.group_id }
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("DUPLICATE_GROUP");
  });

  it("returns 404 for foreign and missing group ids", async () => {
    const foreign = mockFake.seedGroup({ owner: "owner-b", name: "Theirs" });
    for (const groupId of [FOREIGN_UUID, foreign.group_id]) {
      const { status, body } = await callDynamic(
        patchGroupRoute,
        request(`/api/live-trade/groups/${groupId}`, {
          method: "PATCH",
          body: { name: "New", version: 1 },
        }),
        { groupId }
      );
      expect(status).toBe(404);
      expect(body.code).toBe("NOT_FOUND");
    }
  });

  it("rejects a malformed group id with 400 before reading the body", async () => {
    const { status, body } = await callDynamic(
      patchGroupRoute,
      request(`/api/live-trade/groups/${MALFORMED_ID}`, {
        method: "PATCH",
        contentType: "text/plain",
        rawBody: "not json",
      }),
      { groupId: MALFORMED_ID }
    );
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_QUERY");
  });

  it("deletes a group, ungroups its items and increments their versions", async () => {
    const group = mockFake.seedGroup({ owner: "owner-a", name: "Momentum" });
    const other = mockFake.seedGroup({ owner: "owner-a", name: "Other" });
    const inGroup = mockFake.seedItem({
      owner: "owner-a",
      instrumentId: 1,
      groupId: group.group_id,
    });
    const elsewhere = mockFake.seedItem({
      owner: "owner-a",
      instrumentId: 2,
      groupId: other.group_id,
    });

    const { status, body } = await callDynamic(
      deleteGroupRoute,
      request(`/api/live-trade/groups/${group.group_id}?version=1`, {
        method: "DELETE",
      }),
      { groupId: group.group_id }
    );

    expect(status).toBe(200);
    expect(body.data).toEqual({ deleted: true });
    expect(mockFake.groupById(group.group_id)).toBeUndefined();
    expect(mockFake.itemById(inGroup.item_id)).toMatchObject({
      group_id: null,
      version: 2,
    });
    expect(mockFake.itemById(elsewhere.item_id)).toMatchObject({
      group_id: other.group_id,
      version: 1,
    });
  });

  it("requires a valid version to delete", async () => {
    const group = mockFake.seedGroup({ owner: "owner-a", name: "Momentum" });
    for (const search of ["", "?version=", "?version=abc", "?version=0"]) {
      const { status, body } = await callDynamic(
        deleteGroupRoute,
        request(`/api/live-trade/groups/${group.group_id}${search}`, {
          method: "DELETE",
        }),
        { groupId: group.group_id }
      );
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_QUERY");
    }
  });

  it("rejects a stale delete and keeps the group", async () => {
    const group = mockFake.seedGroup({ owner: "owner-a", name: "Momentum", version: 2 });
    const { status, body } = await callDynamic(
      deleteGroupRoute,
      request(`/api/live-trade/groups/${group.group_id}?version=1`, {
        method: "DELETE",
      }),
      { groupId: group.group_id }
    );
    expect(status).toBe(409);
    expect(body.code).toBe("EDIT_CONFLICT");
    expect(mockFake.groupById(group.group_id)).toBeDefined();
  });

  it("returns 404 for a foreign or missing group delete", async () => {
    const foreign = mockFake.seedGroup({ owner: "owner-b", name: "Theirs" });
    for (const groupId of [FOREIGN_UUID, foreign.group_id]) {
      const { status, body } = await callDynamic(
        deleteGroupRoute,
        request(`/api/live-trade/groups/${groupId}?version=1`, {
          method: "DELETE",
        }),
        { groupId }
      );
      expect(status).toBe(404);
      expect(body.code).toBe("NOT_FOUND");
    }
  });

  it("rejects a malformed group id with 400", async () => {
    const { status, body } = await callDynamic(
      deleteGroupRoute,
      request(`/api/live-trade/groups/${MALFORMED_ID}?version=1`, {
        method: "DELETE",
      }),
      { groupId: MALFORMED_ID }
    );
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_QUERY");
  });

  it("reorders groups and increments versions", async () => {
    const first = mockFake.seedGroup({ owner: "owner-a", name: "First", sortOrder: 0 });
    const second = mockFake.seedGroup({ owner: "owner-a", name: "Second", sortOrder: 1 });

    const { status, body } = await call(
      reorderGroupsRoute,
      request("/api/live-trade/groups/reorder", {
        method: "PATCH",
        body: { orderedGroupIds: [second.group_id, first.group_id] },
      })
    );

    expect(status).toBe(200);
    expect(body.data.groups.map((g: { groupId: string }) => g.groupId)).toEqual([
      second.group_id,
      first.group_id,
    ]);
    expect(body.data.groups.map((g: { version: number }) => g.version)).toEqual([2, 2]);
  });

  it("rejects duplicate, malformed and incomplete group reorders", async () => {
    const first = mockFake.seedGroup({ owner: "owner-a", name: "First" });
    mockFake.seedGroup({ owner: "owner-a", name: "Second" });

    const duplicate = await call(
      reorderGroupsRoute,
      request("/api/live-trade/groups/reorder", {
        method: "PATCH",
        body: { orderedGroupIds: [first.group_id, first.group_id] },
      })
    );
    expect(duplicate.status).toBe(400);

    const malformed = await call(
      reorderGroupsRoute,
      request("/api/live-trade/groups/reorder", {
        method: "PATCH",
        body: { orderedGroupIds: [first.group_id, MALFORMED_ID] },
      })
    );
    expect(malformed.status).toBe(400);

    const incomplete = await call(
      reorderGroupsRoute,
      request("/api/live-trade/groups/reorder", {
        method: "PATCH",
        body: { orderedGroupIds: [first.group_id] },
      })
    );
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.code).toBe("REORDER_STALE");
  });

  it("accepts an empty group reorder only with zero groups", async () => {
    const none = await call(
      reorderGroupsRoute,
      request("/api/live-trade/groups/reorder", {
        method: "PATCH",
        body: { orderedGroupIds: [] },
      })
    );
    expect(none.status).toBe(200);

    mockFake.seedGroup({ owner: "owner-a", name: "First" });
    const withGroups = await call(
      reorderGroupsRoute,
      request("/api/live-trade/groups/reorder", {
        method: "PATCH",
        body: { orderedGroupIds: [] },
      })
    );
    expect(withGroups.status).toBe(409);
  });

  it("requires an Origin header for every group mutation", async () => {
    const group = mockFake.seedGroup({ owner: "owner-a", name: "First" });
    const create = await call(
      createGroupRoute,
      request("/api/live-trade/groups", {
        method: "POST",
        origin: null,
        body: { name: "Nope" },
      })
    );
    expect(create.status).toBe(403);

    const patch = await callDynamic(
      patchGroupRoute,
      request(`/api/live-trade/groups/${group.group_id}`, {
        method: "PATCH",
        origin: null,
        body: { name: "Nope", version: 1 },
      }),
      { groupId: group.group_id }
    );
    expect(patch.status).toBe(403);

    const remove = await callDynamic(
      deleteGroupRoute,
      request(`/api/live-trade/groups/${group.group_id}?version=1`, {
        method: "DELETE",
        origin: null,
      }),
      { groupId: group.group_id }
    );
    expect(remove.status).toBe(403);

    const reorder = await call(
      reorderGroupsRoute,
      request("/api/live-trade/groups/reorder", {
        method: "PATCH",
        origin: null,
        body: { orderedGroupIds: [group.group_id] },
      })
    );
    expect(reorder.status).toBe(403);

    expect(mockFake.groupById(group.group_id)?.name).toBe("First");
  });
});
