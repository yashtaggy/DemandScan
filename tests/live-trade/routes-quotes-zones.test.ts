/**
 * Route tests for the Phase 5 market snapshot and zone endpoints.
 *
 * Real HTTP helper, real query parser, real service and real repository run
 * against the stateful fake database. Only the Next response object, the Kite
 * session lookup and the Kite quote call are substituted.
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

jest.mock("@/lib/kite-client", () => ({
  getQuotes: jest.fn(),
}));

import type { NextRequest } from "next/server";
import type { QuoteData } from "@/lib/types";
import { getSessionFromRequest } from "@/lib/kite-session";
import { getQuotes } from "@/lib/kite-client";
import { GET as getQuotesRoute } from "@/app/api/live-trade/quotes/route";
import { GET as getZonesRoute } from "@/app/api/live-trade/zones/route";
import { FakeLiveTradeDb } from "./fake-db";

const mockFake = new FakeLiveTradeDb();
const globalStore = globalThis as typeof globalThis & {
  __liveTradeDb?: unknown;
};

const sessionMock = getSessionFromRequest as jest.Mock;
const quotesMock = getQuotes as jest.Mock;

type JsonBody = {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: string;
  code?: string;
  details?: Record<string, unknown>;
};

type MockResponse = {
  status: number;
  headers: Headers;
  json: () => Promise<unknown>;
};

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  const all = new Headers({ cookie: "ds_sid=session-cookie" });
  for (const [key, value] of Object.entries(headers)) all.set(key, value);
  return new Request(`https://app.example${path}`, {
    method: "GET",
    headers: all,
  }) as unknown as NextRequest;
}

async function call(
  handler: (req: NextRequest) => Promise<unknown>,
  req: NextRequest
): Promise<{ status: number; headers: Headers; body: JsonBody }> {
  const res = (await handler(req)) as MockResponse;
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json()) as JsonBody,
  };
}

function signIn(
  userId: string | null = "owner-a",
  accessToken = "server-side-access-token"
): void {
  sessionMock.mockResolvedValue(
    userId === null
      ? null
      : { userId, accessToken, userName: userId, email: `${userId}@example.com` }
  );
}

function quoteData(input: {
  lastPrice?: number;
  timestamp?: string;
  previousClose?: number;
} = {}): QuoteData {
  return {
    instrumentToken: 1,
    timestamp: input.timestamp ?? new Date().toISOString(),
    lastTradeTime: input.timestamp ?? new Date().toISOString(),
    lastPrice: input.lastPrice ?? 105,
    lastQuantity: 0,
    buyQuantity: 0,
    sellQuantity: 0,
    volume: 0,
    averagePrice: 100,
    ohlc: {
      open: 100,
      high: 106,
      low: 99,
      close: input.previousClose ?? 100,
    },
    netChange: 0,
    oi: 0,
    oiDayHigh: 0,
    oiDayLow: 0,
    lowerCircuitLimit: 0,
    upperCircuitLimit: 0,
  };
}

function mockProvider(map: Record<string, QuoteData>): void {
  quotesMock.mockResolvedValue(new Map(Object.entries(map)));
}

function seedBoard(): void {
  mockFake.seedInstrument({ instrument_id: 1, symbol: "INFY" });
  mockFake.seedInstrument({ instrument_id: 2, symbol: "TCS" });
  mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
  mockFake.seedItem({ owner: "owner-a", instrumentId: 2 });
  mockFake.seedMembership(1);
  mockFake.seedMembership(2);
}

beforeEach(() => {
  mockFake.reset();
  globalStore.__liveTradeDb = mockFake.sql;
  sessionMock.mockReset();
  quotesMock.mockReset();
  signIn();
  seedBoard();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Authentication and ownership ──────────────────────────────────────────

describe("authentication", () => {
  it.each([
    ["a missing session", () => signIn(null)],
    ["a blank owner id", () => signIn("   ")],
    ["an owner id over 64 characters", () => signIn("x".repeat(65))],
  ])("rejects %s on the quotes endpoint without database work", async (_label, arrange) => {
    arrange();
    const { status, body } = await call(getQuotesRoute, request("/api/live-trade/quotes"));
    expect(status).toBe(401);
    expect(body).toEqual({
      error: "Authentication required.",
      code: "UNAUTHENTICATED",
    });
    expect(mockFake.standaloneMarkers).toEqual([]);
  });

  it("rejects an unauthenticated zones request", async () => {
    signIn(null);
    const { status, body } = await call(getZonesRoute, request("/api/live-trade/zones"));
    expect(status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
    expect(mockFake.standaloneMarkers).toEqual([]);
  });

  it("maps a session-store failure to a sanitized 500", async () => {
    sessionMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    const { status, body } = await call(getQuotesRoute, request("/api/live-trade/quotes"));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "An unexpected error occurred.", code: "INTERNAL" });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("derives the owner from the session, ignoring query parameters and headers", async () => {
    mockFake.seedInstrument({ instrument_id: 3, symbol: "FOREIGN" });
    mockFake.seedItem({ owner: "owner-b", instrumentId: 3 });
    mockProvider({ "NSE:INFY": quoteData(), "NSE:TCS": quoteData() });

    const { status, body } = await call(
      getQuotesRoute,
      request(
        "/api/live-trade/quotes?ownerId=owner-b&owner_user_id=owner-b",
        { "x-owner-id": "owner-b", "x-owner-user-id": "owner-b" }
      )
    );

    expect(status).toBe(200);
    const quotes = (body.data as { quotes: Array<{ symbol: string }> }).quotes;
    expect(quotes.map((row) => row.symbol)).toEqual(["INFY", "TCS"]);
    expect(quotes.some((row) => row.symbol === "FOREIGN")).toBe(false);
  });
});

// ─── Quotes endpoint ───────────────────────────────────────────────────────

describe("GET /api/live-trade/quotes", () => {
  it("requires no Origin header because it is a read", async () => {
    mockProvider({ "NSE:INFY": quoteData(), "NSE:TCS": quoteData() });
    const { status } = await call(getQuotesRoute, request("/api/live-trade/quotes"));
    expect(status).toBe(200);
  });

  it("returns the snapshot contract with change and no sensitive fields", async () => {
    mockProvider({ "NSE:INFY": quoteData(), "NSE:TCS": quoteData() });
    const { status, body } = await call(
      getQuotesRoute,
      request("/api/live-trade/quotes")
    );

    expect(status).toBe(200);
    const data = body.data as {
      quotes: Array<Record<string, unknown>>;
      market: { exchange: string; approximation: string };
      cooldownSeconds: number;
      requestedInstruments: number;
      fetchedAt: string;
      zonesAvailable: boolean;
    };
    expect(data.quotes).toHaveLength(2);
    expect(data.zonesAvailable).toBe(true);
    expect(data.quotes[0]).toMatchObject({
      instrumentId: 1,
      symbol: "INFY",
      lastPrice: 105,
      change: 5,
      changePercent: 5,
      errorCode: null,
    });
    expect(["LIVE", "DELAYED", "LAST_CLOSE"]).toContain(
      data.quotes[0].freshness
    );
    expect(data.market.exchange).toBe("NSE");
    expect(data.market.approximation).toContain("holidays");
    expect(data.cooldownSeconds).toBe(5);
    expect(data.requestedInstruments).toBe(2);
    expect(Number.isNaN(Date.parse(data.fetchedAt))).toBe(false);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("server-side-access-token");
    expect(serialized).not.toContain("instrumentToken");
    expect(serialized).not.toContain("oiDayHigh");
  });

  it("attaches nearest-zone distances from the fetched quote", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100, score: 61 });
    mockFake.seedZone({ instrumentId: 1, side: "SUPPLY", proximal: 110, score: 72 });
    mockProvider({ "NSE:INFY": quoteData({ lastPrice: 105 }) });

    const { body } = await call(
      getQuotesRoute,
      request("/api/live-trade/quotes?instrumentIds=1")
    );
    const quote = (body.data as { quotes: Array<Record<string, unknown>> }).quotes[0];
    const demand = quote.nearestDemand as Record<string, unknown>;
    const supply = quote.nearestSupply as Record<string, unknown>;

    expect(demand).toMatchObject({
      proximal: 100,
      formationScore: 61,
      distanceBasis: "PROXIMAL",
    });
    expect(demand.distancePercent).toBeCloseTo(5, 10);
    expect(supply.proximal).toBe(110);
    expect(supply.distancePercent).toBeCloseTo(
      ((105 - 110) / 110) * 100,
      10
    );
  });

  it("reports an absent provider quote as UNAVAILABLE, not zero", async () => {
    mockProvider({ "NSE:INFY": quoteData() });
    const { body } = await call(
      getQuotesRoute,
      request("/api/live-trade/quotes?instrumentIds=2")
    );
    const quote = (body.data as { quotes: Array<Record<string, unknown>> }).quotes[0];

    expect(quote).toMatchObject({
      lastPrice: null,
      change: null,
      freshness: "UNAVAILABLE",
      errorCode: "QUOTE_NOT_RETURNED",
    });
  });

  it("maps provider failures to a sanitized 502", async () => {
    quotesMock.mockRejectedValue(new Error("provider secret detail"));
    const { status, body } = await call(getQuotesRoute, request("/api/live-trade/quotes"));

    expect(status).toBe(502);
    expect(body).toEqual({
      error: "Live quotes are temporarily unavailable.",
      code: "QUOTE_FETCH_FAILED",
    });
    expect(JSON.stringify(body)).not.toContain("provider secret detail");
  });

  it("maps an expired provider token to 401 TOKEN_EXPIRED", async () => {
    quotesMock.mockRejectedValue(new Error("TokenException: invalid token"));
    const { status, body } = await call(getQuotesRoute, request("/api/live-trade/quotes"));

    expect(status).toBe(401);
    expect(body.code).toBe("TOKEN_EXPIRED");
  });

  it("maps rate limiting to 429", async () => {
    quotesMock.mockRejectedValue(new Error("Too many requests"));
    const { status, body } = await call(getQuotesRoute, request("/api/live-trade/quotes"));

    expect(status).toBe(429);
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("enforces the five-second cooldown with a retry hint", async () => {
    mockProvider({ "NSE:INFY": quoteData(), "NSE:TCS": quoteData() });
    const first = await call(getQuotesRoute, request("/api/live-trade/quotes"));
    expect(first.status).toBe(200);

    const second = await call(getQuotesRoute, request("/api/live-trade/quotes"));
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("QUOTE_COOLDOWN");
    const retryAfter = (second.body.details as { retryAfterSeconds: number })
      .retryAfterSeconds;
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(second.headers.get("Retry-After")).toBe(String(retryAfter));
    expect(second.headers.get("Cache-Control")).toBe("no-store");
    expect(quotesMock).toHaveBeenCalledTimes(1);
  });

  it("validates the instrument list before any database work", async () => {
    for (const query of [
      "?instrumentIds=",
      "?instrumentIds=1,1",
      "?instrumentIds=0",
      "?instrumentIds=abc",
    ]) {
      const { status, body } = await call(
        getQuotesRoute,
        request(`/api/live-trade/quotes${query}`)
      );
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_QUERY");
    }
    expect(mockFake.standaloneMarkers).toEqual([]);
  });

  it("rejects more than 200 instrument ids", async () => {
    const ids = Array.from({ length: 201 }, (_, index) => index + 1).join(",");
    const { status, body } = await call(
      getQuotesRoute,
      request(`/api/live-trade/quotes?instrumentIds=${ids}`)
    );
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_QUERY");
  });

  it("returns NOT_FOUND for a foreign instrument id without revealing ownership", async () => {
    mockFake.seedInstrument({ instrument_id: 3, symbol: "FOREIGN" });
    mockFake.seedItem({ owner: "owner-b", instrumentId: 3 });
    mockProvider({});

    const { status, body } = await call(
      getQuotesRoute,
      request("/api/live-trade/quotes?instrumentIds=3")
    );
    expect(status).toBe(404);
    expect(body).toMatchObject({
      error: "The requested record was not found.",
      code: "NOT_FOUND",
    });
    expect(JSON.stringify(body)).not.toContain("FOREIGN");
    expect(quotesMock).not.toHaveBeenCalled();
  });
});

// ─── Zones endpoint ────────────────────────────────────────────────────────

describe("GET /api/live-trade/zones", () => {
  it("requires no Origin header because it is a read", async () => {
    const { status } = await call(getZonesRoute, request("/api/live-trade/zones"));
    expect(status).toBe(200);
  });

  it("returns batched summaries and never calls Kite", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      score: 64,
      lifecycle: "RETESTED",
    });
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(),
      instrumentIds: [1],
    });

    const { status, body } = await call(getZonesRoute, request("/api/live-trade/zones"));
    expect(status).toBe(200);

    const data = body.data as {
      summaries: Array<Record<string, unknown>>;
      expanded: unknown;
      timeframeContext: unknown;
      freshnessThresholdDays: number;
    };
    expect(data.summaries).toHaveLength(2);
    const summary = data.summaries.find(
      (row) => row.instrumentId === 1
    ) as Record<string, unknown>;
    expect(summary).toMatchObject({
      symbol: "INFY",
      preferredTimeframe: "1D",
      coverage: "AVAILABLE",
    });
    const demand = summary.nearestDemand as Record<string, unknown>;
    expect(demand).toMatchObject({
      proximal: 100,
      formationScore: 64,
      lifecycleState: "RETESTED",
      distancePercent: null,
      distanceBasis: "PROXIMAL",
    });
    expect(data.expanded).toBeNull();
    expect(data.timeframeContext).toEqual({ hasOverride: false, value: null });
    expect(data.freshnessThresholdDays).toBe(7);
    expect(quotesMock).not.toHaveBeenCalled();

    expect(mockFake.standaloneMarkers).toEqual([
      "list-quote-instruments",
      "zones:nearest",
      "zones:coverage",
    ]);
  });

  it("returns an expanded page for exactly one instrument", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      score: 64,
      lifecycle: "BROKEN",
    });

    const { status, body } = await call(
      getZonesRoute,
      request(
        "/api/live-trade/zones?instrumentIds=1&includeExpanded=true&limit=1&offset=0"
      )
    );
    expect(status).toBe(200);
    const expanded = (body.data as { expanded: Record<string, unknown> })
      .expanded;
    expect(expanded).toMatchObject({
      instrumentId: 1,
      symbol: "INFY",
    });
    const zones = expanded.zones as Array<Record<string, unknown>>;
    expect(zones).toHaveLength(1);
    expect(zones[0]).toMatchObject({
      lifecycleState: "BROKEN",
      formationScore: 64,
      distancePercent: null,
      distanceBasis: "PROXIMAL",
    });
  });

  it("isolates one owner's zones from another owner's rows", async () => {
    mockFake.seedInstrument({ instrument_id: 3, symbol: "FOREIGN" });
    mockFake.seedItem({ owner: "owner-b", instrumentId: 3 });
    mockFake.seedZone({ instrumentId: 3, side: "DEMAND", proximal: 999 });

    const { body } = await call(getZonesRoute, request("/api/live-trade/zones"));
    const summaries = (body.data as { summaries: Array<Record<string, unknown>> })
      .summaries;
    expect(summaries.map((row) => row.symbol)).toEqual(["INFY", "TCS"]);
  });

  it("rejects invalid pagination, timeframe and expansion parameters", async () => {
    for (const query of [
      "?limit=501",
      "?limit=0",
      "?offset=-1",
      "?offset=5000&limit=1",
      "?offset=4500&limit=501",
      "?timeframe=2D",
      "?timeframe=",
      "?includeExpanded=yes",
      "?instrumentIds=1,1",
    ]) {
      const { status, body } = await call(
        getZonesRoute,
        request(`/api/live-trade/zones${query}`)
      );
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_QUERY");
    }
  });

  it("accepts the maximum page size and the 5000-zone window boundary", async () => {
    const maxPage = await call(
      getZonesRoute,
      request("/api/live-trade/zones?limit=500")
    );
    expect(maxPage.status).toBe(200);

    const boundary = await call(
      getZonesRoute,
      request("/api/live-trade/zones?offset=4500&limit=500")
    );
    expect(boundary.status).toBe(200);
  });

  it("rejects includeExpanded for more than one selected instrument", async () => {
    const { status, body } = await call(
      getZonesRoute,
      request("/api/live-trade/zones?includeExpanded=true")
    );
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_QUERY");
    expect(mockFake.standaloneMarkers).toEqual(["list-quote-instruments"]);
  });

  it("rejects includeExpanded on an empty board instead of returning 200", async () => {
    mockFake.reset();
    const { status, body } = await call(
      getZonesRoute,
      request("/api/live-trade/zones?includeExpanded=true")
    );
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_QUERY");
    expect(mockFake.standaloneMarkers).toEqual(["list-quote-instruments"]);
  });

  it("keeps valid quotes and reports zonesAvailable=false when zone lookup fails", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    mockFake.failOnce("zones:nearest");
    mockProvider({ "NSE:INFY": quoteData({ lastPrice: 105 }) });

    const { status, body } = await call(
      getQuotesRoute,
      request("/api/live-trade/quotes?instrumentIds=1")
    );
    expect(status).toBe(200);
    const data = body.data as {
      quotes: Array<Record<string, unknown>>;
      zonesAvailable: boolean;
    };
    expect(data.zonesAvailable).toBe(false);
    expect(data.quotes[0]).toMatchObject({
      lastPrice: 105,
      freshness: expect.stringMatching(/LIVE|DELAYED|LAST_CLOSE/),
      errorCode: null,
      nearestDemand: null,
      nearestSupply: null,
    });
    expect(JSON.stringify(body)).not.toContain("simulated database error");
  });

  it("returns NOT_FOUND for a foreign instrument id", async () => {
    mockFake.seedInstrument({ instrument_id: 3, symbol: "FOREIGN" });
    mockFake.seedItem({ owner: "owner-b", instrumentId: 3 });
    mockFake.seedZone({ instrumentId: 3, side: "DEMAND", proximal: 999 });

    const { status, body } = await call(
      getZonesRoute,
      request("/api/live-trade/zones?instrumentIds=3")
    );
    expect(status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
    expect(JSON.stringify(body)).not.toContain("FOREIGN");
    expect(mockFake.standaloneMarkers).toEqual(["list-quote-instruments"]);
  });

  it("maps a database failure to a sanitized 500", async () => {
    mockFake.failOnce("zones:nearest");
    const { status, body } = await call(getZonesRoute, request("/api/live-trade/zones"));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "An unexpected error occurred.", code: "INTERNAL" });
    expect(JSON.stringify(body)).not.toContain("simulated database error");
  });
});
