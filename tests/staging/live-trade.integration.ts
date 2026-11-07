/**
 * Live Trade staging integration suite.
 *
 * Runs only through jest.staging.config.json and only when the staging guard
 * passes (RUN_STAGING_INTEGRATION=1, explicit runtime env file, expected host,
 * forbidden production host). All data is synthetic and owner/run-scoped.
 *
 * The external Kite quote provider is never called: quote paths use an
 * injected fake provider, and API cooldown tests reject before the provider.
 */

jest.mock("@/lib/kite-client", () => ({
  getQuotes: jest.fn(async () => {
    throw new Error("STAGING_GUARD: the real Kite client must never be called");
  }),
}));

import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import type { KiteSession, QuoteData } from "@/lib/types";
import { getQuotes } from "@/lib/kite-client";
import type { LiveTradeOwnerId } from "@/lib/live-trade/types";
import { sessionStore } from "@/lib/kite-session";
import * as repository from "@/lib/live-trade/repository";
import * as service from "@/lib/live-trade/service";
import type { QuoteProvider } from "@/lib/live-trade/quotes";
import { createStagingRun, type StagingRun } from "./harness";

import {
  GET as getGroupsRoute,
  POST as createGroupRoute,
} from "@/app/api/live-trade/groups/route";
import {
  DELETE as deleteGroupRoute,
  PATCH as patchGroupRoute,
} from "@/app/api/live-trade/groups/[groupId]/route";
import { GET as getBoardRoute } from "@/app/api/live-trade/board/route";
import { GET as getQuotesRoute } from "@/app/api/live-trade/quotes/route";
import { GET as getZonesRoute } from "@/app/api/live-trade/zones/route";

const APP_ORIGIN = "http://localhost:3000";
const NOW = new Date("2026-11-07T06:00:00.000Z");
const getQuotesMock = getQuotes as jest.Mock;

let run: StagingRun;
let sessionId: string;
let session: KiteSession;

function apiRequest(
  path: string,
  options: {
    method?: string;
    cookie?: string;
    origin?: string;
    body?: unknown;
  } = {}
): NextRequest {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  return new NextRequest(`${APP_ORIGIN}${path}`, {
    method: options.method ?? "GET",
    headers,
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function buildQuote(lastPrice: number): QuoteData {
  return {
    instrumentToken: run.instrumentIds.active,
    timestamp: "2026-11-07T05:30:00.000Z",
    lastTradeTime: "2026-11-07T05:29:59.000Z",
    lastPrice,
    lastQuantity: 1,
    buyQuantity: 10,
    sellQuantity: 10,
    volume: 1000,
    averagePrice: lastPrice,
    ohlc: {
      open: lastPrice,
      high: lastPrice,
      low: lastPrice,
      close: lastPrice - 1,
    },
    netChange: 1,
    oi: 0,
    oiDayHigh: 0,
    oiDayLow: 0,
    lowerCircuitLimit: 0,
    upperCircuitLimit: 0,
  };
}

async function clearCooldown(ownerId: LiveTradeOwnerId): Promise<void> {
  await run.sql.query(
    `DELETE FROM live_trade_quote_state WHERE owner_user_id = $1`,
    [ownerId as string]
  );
}

async function createItem(
  ownerId: LiveTradeOwnerId,
  instrumentId: number,
  overrides: Record<string, unknown> = {}
) {
  return service.createItem(ownerId, { instrumentId, ...overrides });
}

beforeAll(async () => {
  run = createStagingRun();
  await run.seedBase();

  sessionId = `zztest-session-${randomUUID()}`;
  session = {
    accessToken: "zztest-access-token",
    userId: run.ownerB,
    userName: "ZZTEST Staging User",
    email: "zztest@example.test",
    loginTime: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  await sessionStore.set(sessionId, session);

  // Board fixture for coverage, zones, quotes and API tests (owner B).
  await createItem(run.ownerB, run.instrumentIds.active, { timeframe: null });
  await createItem(run.ownerB, run.instrumentIds.active2, { timeframe: "1D" });
  await createItem(run.ownerB, run.instrumentIds.outside, { timeframe: null });
  await createItem(run.ownerB, run.instrumentIds.noHistory, { timeframe: null });
  await createItem(run.ownerB, run.instrumentIds.stale, { timeframe: null });
  await createItem(run.ownerB, run.instrumentIds.noZones, { timeframe: null });
});

afterAll(async () => {
  if (sessionId) {
    await sessionStore.clear(sessionId).catch(() => undefined);
  }
  if (run) {
    await run.cleanup();
  }
});

describe("groups and items CRUD", () => {
  it("creates, lists, renames and rejects a stale group rename", async () => {
    const group = await service.createGroup(run.ownerA, {
      name: `ZZTEST Group ${run.runId.slice(0, 8)}`,
    });
    expect(group.version).toBe(1);

    const listed = await service.listGroups(run.ownerA);
    expect(listed.map((row) => row.groupId)).toContain(group.groupId);

    const renamed = await service.updateGroup(run.ownerA, group.groupId, {
      name: `ZZTEST Renamed ${run.runId.slice(0, 8)}`,
      version: 1,
    });
    expect(renamed.version).toBe(2);

    await expect(
      service.updateGroup(run.ownerA, group.groupId, {
        name: "ZZTEST Stale Rename",
        version: 1,
      })
    ).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
  });

  it("creates active NSE items, updates with optimistic concurrency, and reorders", async () => {
    const first = await createItem(run.ownerA, run.instrumentIds.active, {
      priority: "HIGH",
      direction: "BUY",
      timeframe: "1D",
      entryPrice: 100,
      targetPrice: 110,
      stopLoss: 95,
      notes: "zztest first",
    });
    const second = await createItem(run.ownerA, run.instrumentIds.active2);

    expect(first.version).toBe(1);
    expect(first.notes).toBe("zztest first");

    const updated = await service.updateItem(run.ownerA, first.itemId, {
      version: 1,
      notes: "zztest updated",
    });
    expect(updated.version).toBe(2);
    expect(updated.notes).toBe("zztest updated");

    await expect(
      service.updateItem(run.ownerA, first.itemId, {
        version: 1,
        notes: "zztest stale",
      })
    ).rejects.toMatchObject({ code: "EDIT_CONFLICT" });

    const reordered = await service.reorderItems(run.ownerA, {
      orderedItemIds: [second.itemId, first.itemId],
    });
    expect(reordered.map((row) => row.itemId)).toEqual([
      second.itemId,
      first.itemId,
    ]);

    const firstAfterReorder = reordered.find(
      (row) => row.itemId === first.itemId
    );
    const secondAfterReorder = reordered.find(
      (row) => row.itemId === second.itemId
    );

    await service.deleteItem(
      run.ownerA,
      second.itemId,
      String(secondAfterReorder?.version)
    );
    const remaining = await service.listItems(run.ownerA);
    expect(remaining.map((row) => row.itemId)).toEqual([first.itemId]);

    await service.deleteItem(
      run.ownerA,
      first.itemId,
      String(firstAfterReorder?.version)
    );
    expect(await service.listItems(run.ownerA)).toHaveLength(0);
  });

  it("rejects an inactive NSE instrument without creating an item", async () => {
    await expect(
      createItem(run.ownerA, run.instrumentIds.inactive)
    ).rejects.toMatchObject({ code: "INSTRUMENT_INACTIVE" });

    expect(await service.listItems(run.ownerA)).toHaveLength(0);
  });

  it("rejects a non-NSE instrument without creating an item", async () => {
    await expect(
      createItem(run.ownerA, run.instrumentIds.nonNse)
    ).rejects.toMatchObject({ code: "INSTRUMENT_NOT_SYNCED" });

    expect(await service.listItems(run.ownerA)).toHaveLength(0);
  });

  it("deletes a group by ungrouping its items first", async () => {
    const group = await service.createGroup(run.ownerA, {
      name: `ZZTEST Delete ${run.runId.slice(0, 8)}`,
    });
    const item = await createItem(run.ownerA, run.instrumentIds.active, {
      groupId: group.groupId,
    });

    await service.deleteGroup(run.ownerA, group.groupId, String(group.version));

    const items = await service.listItems(run.ownerA);
    const ungrouped = items.find((row) => row.itemId === item.itemId);
    expect(ungrouped).toBeDefined();
    expect(ungrouped?.groupId).toBeNull();
    expect(ungrouped?.version).toBe(item.version + 1);

    const groups = await service.listGroups(run.ownerA);
    expect(groups.map((row) => row.groupId)).not.toContain(group.groupId);
  });
});

describe("owner isolation", () => {
  it("does not expose or mutate another owner's items or groups", async () => {
    const bItems = await service.listItems(run.ownerB);
    const bItem = bItems.find(
      (row) => row.instrumentId === run.instrumentIds.active2
    );
    expect(bItem).toBeDefined();

    const aItems = await service.listItems(run.ownerA);
    expect(aItems.map((row) => row.itemId)).not.toContain(bItem?.itemId);

    await expect(
      service.updateItem(run.ownerA, bItem!.itemId, {
        version: bItem!.version,
        notes: "zztest cross-owner",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      service.deleteItem(run.ownerA, bItem!.itemId, String(bItem!.version))
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const bGroup = await service.createGroup(run.ownerB, {
      name: `ZZTEST Foreign ${run.runId.slice(0, 8)}`,
    });

    await expect(
      createItem(run.ownerA, run.instrumentIds.active, {
        groupId: bGroup.groupId,
      })
    ).rejects.toMatchObject({ code: "INVALID_GROUP" });

    const aGroups = await service.listGroups(run.ownerA);
    expect(aGroups.map((row) => row.groupId)).not.toContain(bGroup.groupId);
  });
});

describe("quote cooldown", () => {
  it("allows one claim then rejects a concurrent claim", async () => {
    await clearCooldown(run.ownerB);

    const first = await repository.claimQuoteCooldown(run.ownerB);
    expect(first.allowed).toBe(true);

    const second = await repository.claimQuoteCooldown(run.ownerB);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("serves a quote through an injected provider and enriches zones", async () => {
    await clearCooldown(run.ownerB);

    const fetchQuotes = jest.fn(async () => {
      const quotes = new Map<string, QuoteData>();
      quotes.set(`NSE:${run.symbols.active}`, buildQuote(100));
      return quotes;
    });
    const provider: QuoteProvider = { fetchQuotes };

    const response = await service.getLiveQuotesAt(
      NOW,
      run.ownerB,
      session,
      [run.instrumentIds.active],
      provider,
      () => NOW
    );

    expect(fetchQuotes).toHaveBeenCalledTimes(1);
    expect(getQuotesMock).not.toHaveBeenCalled();
    expect(response.quotes).toHaveLength(1);
    expect(response.quotes[0].lastPrice).toBe(100);
    expect(response.quotes[0].nearestDemand?.proximal).toBe(98);
    expect(response.quotes[0].nearestSupply?.proximal).toBe(105);
    expect(response.quotes[0].nearestDemand?.distancePercent).toBeCloseTo(2.0408, 3);
  });
});

describe("board coverage", () => {
  it("classifies all documented coverage states from real scan evidence", async () => {
    const board = await service.getBoard(run.ownerB);
    const coverage = new Map(
      board.zones.summaries.map((row) => [row.instrumentId, row.coverage])
    );

    expect(coverage.get(run.instrumentIds.active)).toBe("AVAILABLE");
    expect(coverage.get(run.instrumentIds.active2)).toBe("AVAILABLE");
    expect(coverage.get(run.instrumentIds.outside)).toBe(
      "OUTSIDE_SCANNER_UNIVERSE"
    );
    expect(coverage.get(run.instrumentIds.stale)).toBe("STALE");
    expect(coverage.get(run.instrumentIds.noZones)).toBe("NO_ZONES");
    expect(coverage.get(run.instrumentIds.noHistory)).toBe("NO_SCAN_HISTORY");
  });
});

describe("nearest zones and expanded pagination", () => {
  it("selects structural nearest demand/supply and excludes broken zones", async () => {
    const rows = await repository.getNearestZones(
      run.ownerB,
      [run.instrumentIds.active],
      null,
      false
    );

    const demand = rows.find((row) => row.side === "DEMAND");
    const supply = rows.find((row) => row.side === "SUPPLY");
    expect(demand?.proximal).toBe(101);
    expect(supply?.proximal).toBe(99);
    expect(demand?.lifecycleState).not.toBe("BROKEN");
  });

  it("applies price-relative eligibility and timeframe preference", async () => {
    const priced = await repository.getNearestZones(
      run.ownerB,
      [run.instrumentIds.active],
      null,
      false,
      new Map([[run.instrumentIds.active, 100]])
    );
    expect(priced.find((row) => row.side === "DEMAND")?.proximal).toBe(98);
    expect(priced.find((row) => row.side === "SUPPLY")?.proximal).toBe(105);

    const preferred = await repository.getNearestZones(
      run.ownerB,
      [run.instrumentIds.active],
      "1W",
      true
    );
    expect(preferred.find((row) => row.side === "SUPPLY")?.proximal).toBe(115);
  });

  it("paginates expanded zones without overlap or duplicates", async () => {
    const seen = new Set<string>();
    const pages: number[] = [];

    for (const offset of [0, 2, 4, 6]) {
      const response = await service.getZoneOverviewsAt(NOW, run.ownerB, {
        instrumentIds: [run.instrumentIds.active],
        hasTimeframeOverride: false,
        timeframeOverride: null,
        includeExpanded: true,
        limit: 2,
        offset,
      });

      const expanded = response.expanded;
      expect(expanded).not.toBeNull();
      pages.push(expanded?.pagination.returned ?? 0);
      for (const zone of expanded?.zones ?? []) {
        expect(seen.has(zone.zoneId)).toBe(false);
        seen.add(zone.zoneId);
      }
    }

    expect(pages).toEqual([2, 2, 2, 1]);
    expect(seen.size).toBe(7);
  });
});

describe("API authentication and error contracts", () => {
  it("returns 401 without a session cookie", async () => {
    const response = await getGroupsRoute(apiRequest("/api/live-trade/groups"));
    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("returns 401 for a mutation without a session cookie", async () => {
    const response = await createGroupRoute(
      apiRequest("/api/live-trade/groups", {
        method: "POST",
        origin: APP_ORIGIN,
        body: { name: "ZZTEST No Session" },
      })
    );
    expect(response.status).toBe(401);
  });

  it("authenticates with a real session and enforces duplicate names", async () => {
    const cookie = `ds_sid=${sessionId}`;
    const listed = await getGroupsRoute(
      apiRequest("/api/live-trade/groups", { cookie })
    );
    expect(listed.status).toBe(200);
    expect(await bodyOf(listed)).toMatchObject({ success: true });

    const name = `ZZTEST API ${run.runId.slice(0, 8)}`;
    const first = await createGroupRoute(
      apiRequest("/api/live-trade/groups", {
        method: "POST",
        cookie,
        origin: APP_ORIGIN,
        body: { name },
      })
    );
    expect(first.status).toBe(201);

    const duplicate = await createGroupRoute(
      apiRequest("/api/live-trade/groups", {
        method: "POST",
        cookie,
        origin: APP_ORIGIN,
        body: { name: name.toUpperCase() },
      })
    );
    expect(duplicate.status).toBe(409);
    expect(await bodyOf(duplicate)).toMatchObject({ code: "DUPLICATE_GROUP" });
  });

  it("rejects malformed identifiers with 400 before database work", async () => {
    const cookie = `ds_sid=${sessionId}`;

    const patch = await patchGroupRoute(
      apiRequest("/api/live-trade/groups/not-a-uuid", {
        method: "PATCH",
        cookie,
        origin: APP_ORIGIN,
        body: { name: "ZZTEST", version: 1 },
      }),
      { params: Promise.resolve({ groupId: "not-a-uuid" }) }
    );
    expect(patch.status).toBe(400);
    expect(await bodyOf(patch)).toMatchObject({ code: "INVALID_QUERY" });

    const remove = await deleteGroupRoute(
      apiRequest("/api/live-trade/groups/not-a-uuid?version=1", {
        method: "DELETE",
        cookie,
        origin: APP_ORIGIN,
      }),
      { params: Promise.resolve({ groupId: "not-a-uuid" }) }
    );
    expect(remove.status).toBe(400);
  });

  it("maps a rejected cooldown claim to 429 with Retry-After", async () => {
    const cookie = `ds_sid=${sessionId}`;
    await clearCooldown(run.ownerB);
    const claim = await repository.claimQuoteCooldown(run.ownerB);
    expect(claim.allowed).toBe(true);

    const response = await getQuotesRoute(
      apiRequest("/api/live-trade/quotes", { cookie })
    );
    expect(response.status).toBe(429);
    expect(await bodyOf(response)).toMatchObject({ code: "QUOTE_COOLDOWN" });
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(getQuotesMock).not.toHaveBeenCalled();
  });

  it("serves the board and validates expanded-zone requirements", async () => {
    const cookie = `ds_sid=${sessionId}`;

    const board = await getBoardRoute(
      apiRequest("/api/live-trade/board", { cookie })
    );
    expect(board.status).toBe(200);

    const zones = await getZonesRoute(
      apiRequest(
        `/api/live-trade/zones?instrumentIds=${run.instrumentIds.active}&includeExpanded=true&limit=2`,
        { cookie }
      )
    );
    expect(zones.status).toBe(200);
    const zoneBody = await bodyOf(zones);
    expect(zoneBody.success).toBe(true);

    const invalid = await getZonesRoute(
      apiRequest(
        `/api/live-trade/zones?instrumentIds=${run.instrumentIds.active},${run.instrumentIds.active2}&includeExpanded=true`,
        { cookie }
      )
    );
    expect(invalid.status).toBe(400);
    expect(await bodyOf(invalid)).toMatchObject({ code: "INVALID_QUERY" });
  });
});
