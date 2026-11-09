/**
 * Market snapshot tests.
 *
 * Part 1 covers the pure quote primitives: session approximation, timestamp
 * and price validation, change arithmetic, distance arithmetic and sanitized
 * provider-error mapping.
 *
 * Part 2 covers the quote service against the stateful fake database with an
 * injected quote provider: selection scoping, per-instrument fallbacks,
 * freshness labels, zone distances and the 5-second per-owner cooldown.
 */

import type { KiteSession, QuoteData } from "@/lib/types";
import type { LiveTradeOwnerId } from "@/lib/live-trade/types";
import { LiveTradeError } from "@/lib/live-trade/errors";
import type { QuoteProvider } from "@/lib/live-trade/quotes";
import {
  classifyQuoteFreshness,
  classifyQuoteProviderError,
  computeDistancePercent,
  computeQuoteChange,
  isApproxNseMarketOpen,
  isValidQuotePrice,
  parseQuoteTimestamp,
} from "@/lib/live-trade/quotes";
import { getLiveQuotesAt } from "@/lib/live-trade/service";
import { FakeLiveTradeDb } from "./fake-db";

jest.mock("@/lib/db", () => ({
  getDb: () => globalStore.__liveTradeDb,
}));

const mockFake = new FakeLiveTradeDb();
const globalStore = globalThis as typeof globalThis & {
  __liveTradeDb?: unknown;
};

const OWNER_A = "owner-a" as LiveTradeOwnerId;
const OWNER_B = "owner-b" as LiveTradeOwnerId;

/** Friday 2026-11-06, 10:30 IST. */
const NOW_OPEN = new Date("2026-11-06T05:00:00.000Z");
/** Friday 2026-11-06, 16:30 IST. */
const NOW_CLOSED = new Date("2026-11-06T11:00:00.000Z");

const SESSION: KiteSession = {
  accessToken: "server-side-access-token",
  userId: "owner-a",
  userName: "Owner A",
  email: "owner-a@example.com",
  loginTime: "2026-11-06T03:00:00.000Z",
  expiresAt: "2026-11-07T03:00:00.000Z",
};

function quoteData(input: {
  lastPrice?: unknown;
  timestamp?: unknown;
  lastTradeTime?: unknown;
  previousClose?: unknown;
} = {}): QuoteData {
  return {
    instrumentToken: 1,
    timestamp: (input.timestamp ?? "2026-11-06T04:58:00.000Z") as string,
    lastTradeTime: (input.lastTradeTime ?? "2026-11-06T04:58:00.000Z") as string,
    lastPrice: (input.lastPrice ?? 105) as number,
    lastQuantity: 0,
    buyQuantity: 0,
    sellQuantity: 0,
    volume: 0,
    averagePrice: 100,
    ohlc: {
      open: 100,
      high: 106,
      low: 99,
      close: (input.previousClose === undefined ? 100 : input.previousClose) as number,
    },
    netChange: 0,
    oi: 0,
    oiDayHigh: 0,
    oiDayLow: 0,
    lowerCircuitLimit: 0,
    upperCircuitLimit: 0,
  };
}

type MockProvider = QuoteProvider & { fetchQuotes: jest.Mock };

function providerReturning(map: Record<string, QuoteData> = {}): MockProvider {
  const fetchQuotes = jest.fn(async () => new Map(Object.entries(map)));
  return { fetchQuotes } as unknown as MockProvider;
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
  globalStore.__liveTradeDb = mockFake.sql;
  mockFake.seedInstrument({ instrument_id: 1, symbol: "INFY" });
  mockFake.seedInstrument({ instrument_id: 2, symbol: "TCS" });
  mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
  mockFake.seedItem({ owner: "owner-a", instrumentId: 2 });
  mockFake.setNow(NOW_OPEN);
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Pure primitives ────────────────────────────────────────────────────────

describe("approx NSE session", () => {
  it("opens at 09:15 IST and closes at 15:30 IST on weekdays", () => {
    expect(isApproxNseMarketOpen(new Date("2026-11-06T03:44:59Z"))).toBe(false);
    expect(isApproxNseMarketOpen(new Date("2026-11-06T03:45:00Z"))).toBe(true);
    expect(isApproxNseMarketOpen(new Date("2026-11-06T09:59:59Z"))).toBe(true);
    expect(isApproxNseMarketOpen(new Date("2026-11-06T10:00:00Z"))).toBe(false);
  });

  it("treats Saturday and Sunday as closed", () => {
    expect(isApproxNseMarketOpen(new Date("2026-11-07T05:00:00Z"))).toBe(false);
    expect(isApproxNseMarketOpen(new Date("2026-11-08T05:00:00Z"))).toBe(false);
  });
});

describe("quote value guards", () => {
  it("accepts ISO strings and Date instances, rejects blank and invalid", () => {
    expect(parseQuoteTimestamp("2026-11-06T05:00:00Z")?.toISOString()).toBe(
      "2026-11-06T05:00:00.000Z"
    );
    expect(
      parseQuoteTimestamp(new Date("2026-11-06T05:00:00Z"))?.toISOString()
    ).toBe("2026-11-06T05:00:00.000Z");
    expect(parseQuoteTimestamp("")).toBeNull();
    expect(parseQuoteTimestamp("not-a-date")).toBeNull();
    expect(parseQuoteTimestamp(null)).toBeNull();
    expect(parseQuoteTimestamp(42)).toBeNull();
  });

  it("accepts only finite positive prices", () => {
    expect(isValidQuotePrice(1)).toBe(true);
    expect(isValidQuotePrice(0)).toBe(false);
    expect(isValidQuotePrice(-1)).toBe(false);
    expect(isValidQuotePrice(Number.NaN)).toBe(false);
    expect(isValidQuotePrice(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidQuotePrice("100")).toBe(false);
  });
});

describe("freshness classification", () => {
  const now = new Date("2026-11-06T05:00:00Z");

  it("labels a recent quote LIVE during the session, including the boundary", () => {
    expect(
      classifyQuoteFreshness({
        quoteTimestamp: new Date("2026-11-06T04:55:00Z"),
        now,
        marketOpen: true,
      })
    ).toBe("LIVE");
    expect(
      classifyQuoteFreshness({
        quoteTimestamp: new Date("2026-11-06T04:54:59Z"),
        now,
        marketOpen: true,
      })
    ).toBe("DELAYED");
  });

  it("always labels a closed-market quote LAST_CLOSE", () => {
    expect(
      classifyQuoteFreshness({
        quoteTimestamp: new Date("2026-11-06T04:59:59Z"),
        now,
        marketOpen: false,
      })
    ).toBe("LAST_CLOSE");
  });
});

describe("change and distance arithmetic", () => {
  it("computes change from a usable previous close", () => {
    expect(computeQuoteChange(105, 100)).toEqual({
      change: 5,
      changePercent: 5,
    });
    expect(computeQuoteChange(90, 100)).toEqual({
      change: -10,
      changePercent: -10,
    });
  });

  it("never invents a change when the previous close is unusable", () => {
    expect(computeQuoteChange(105, null)).toEqual({
      change: null,
      changePercent: null,
    });
    expect(computeQuoteChange(105, 0)).toEqual({
      change: null,
      changePercent: null,
    });
    expect(computeQuoteChange(105, "100")).toEqual({
      change: null,
      changePercent: null,
    });
  });

  it("preserves the sign and precision of the proximal distance", () => {
    expect(computeDistancePercent(110, 100)).toBeCloseTo(10, 10);
    expect(computeDistancePercent(90, 100)).toBeCloseTo(-10, 10);
    expect(computeDistancePercent(105, 110)).toBeCloseTo(-4.545454545, 8);
  });

  it("returns null instead of dividing by zero or using invalid inputs", () => {
    expect(computeDistancePercent(100, 0)).toBeNull();
    expect(computeDistancePercent(100, null)).toBeNull();
    expect(computeDistancePercent(0, 100)).toBeNull();
    expect(computeDistancePercent(Number.NaN, 100)).toBeNull();
    expect(computeDistancePercent(100, "100")).toBeNull();
  });
});

describe("provider error mapping", () => {
  function errorWith(message: string, name = "Error") {
    return Object.assign(new Error(message), { name });
  }

  it("maps rate limiting to 429", () => {
    expect(classifyQuoteProviderError(errorWith("Too many requests")).code).toBe(
      "RATE_LIMITED"
    );
    expect(classifyQuoteProviderError(errorWith("HTTP 429")).status).toBe(429);
  });

  it("maps an invalid or expired token to TOKEN_EXPIRED", () => {
    expect(
      classifyQuoteProviderError(errorWith("TokenException: invalid token"))
        .code
    ).toBe("TOKEN_EXPIRED");
  });

  it("maps a permissions failure to FORBIDDEN with a safe message", () => {
    const error = classifyQuoteProviderError(
      errorWith("PermissionException: no market data permission")
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(JSON.stringify(error.toBody())).not.toContain("PermissionException");
  });

  it("maps network and unknown failures to QUOTE_FETCH_FAILED", () => {
    expect(
      classifyQuoteProviderError(errorWith("connect ECONNREFUSED")).code
    ).toBe("QUOTE_FETCH_FAILED");
    expect(classifyQuoteProviderError({ weird: true }).code).toBe(
      "QUOTE_FETCH_FAILED"
    );
  });

  it("prefers Kite's structured error_type over message text", () => {
    expect(
      classifyQuoteProviderError({
        error_type: "TokenException",
        message: "Too many requests",
      }).code
    ).toBe("TOKEN_EXPIRED");
    expect(
      classifyQuoteProviderError({
        error_type: "RateLimitException",
        message: "unknown",
      }).code
    ).toBe("RATE_LIMITED");
    expect(
      classifyQuoteProviderError({
        error_type: "PermissionException",
        message: "network noise",
      }).code
    ).toBe("FORBIDDEN");
    expect(
      classifyQuoteProviderError({
        error_type: "GeneralException",
        message: "Too many requests",
      }).code
    ).toBe("QUOTE_FETCH_FAILED");
  });

  it("prefers an HTTP status when no structured type is present", () => {
    expect(classifyQuoteProviderError({ status: 429 }).code).toBe("RATE_LIMITED");
    expect(classifyQuoteProviderError({ statusCode: 401 }).code).toBe(
      "TOKEN_EXPIRED"
    );
    expect(classifyQuoteProviderError({ response: { status: 403 } }).code).toBe(
      "FORBIDDEN"
    );
  });

  it("does not treat a bare number inside an unrelated message as authoritative", () => {
    expect(
      classifyQuoteProviderError(errorWith("request 429123 failed")).code
    ).toBe("QUOTE_FETCH_FAILED");
    expect(
      classifyQuoteProviderError(errorWith("instrument 403 unavailable")).code
    ).toBe("QUOTE_FETCH_FAILED");
  });

  it("logs only the error name and code, never the provider message", () => {
    classifyQuoteProviderError(
      errorWith("secret-token should not be logged", "NetworkException")
    );
    const logged = JSON.stringify((console.error as jest.Mock).mock.calls);
    expect(logged).not.toContain("secret-token");
    expect(logged).toContain("NetworkException");
  });
});

// ─── Quote service ──────────────────────────────────────────────────────────

describe("quote service", () => {
  it("returns an empty snapshot without a cooldown claim or provider call", async () => {
    mockFake.reset();
    const provider = providerReturning({});
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, undefined, provider);

    expect(result.quotes).toEqual([]);
    expect(result.requestedInstruments).toBe(0);
    expect(result.cooldownSeconds).toBe(5);
    expect(provider.fetchQuotes).not.toHaveBeenCalled();
    expect(mockFake.standaloneMarkers).toEqual(["list-quote-instruments"]);
    expect(mockFake.quoteState.size).toBe(0);
  });

  it("rejects a missing session token before any database work", async () => {
    await expectLiveTradeError(
      getLiveQuotesAt(
        NOW_OPEN,
        OWNER_A,
        { ...SESSION, accessToken: "   " },
        undefined,
        providerReturning({})
      ),
      "TOKEN_EXPIRED"
    );
    expect(mockFake.standaloneMarkers).toEqual([]);
  });

  it("requests only the owner's symbols in saved order", async () => {
    const provider = providerReturning({
      "NSE:INFY": quoteData(),
      "NSE:TCS": quoteData(),
    });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, undefined, provider);

    expect(provider.fetchQuotes).toHaveBeenCalledWith(
      "server-side-access-token",
      ["NSE:INFY", "NSE:TCS"]
    );
    expect(result.quotes.map((row) => row.symbol)).toEqual(["INFY", "TCS"]);
  });

  it("requests repeated entries for one instrument only once", async () => {
    mockFake.seedItem({ owner: "owner-a", instrumentId: 1 });
    const provider = providerReturning({
      "NSE:INFY": quoteData(),
      "NSE:TCS": quoteData(),
    });

    const result = await getLiveQuotesAt(
      NOW_OPEN,
      OWNER_A,
      SESSION,
      undefined,
      provider
    );

    expect(provider.fetchQuotes).toHaveBeenCalledTimes(1);
    expect(provider.fetchQuotes).toHaveBeenCalledWith(
      "server-side-access-token",
      ["NSE:INFY", "NSE:TCS"]
    );
    expect(result.quotes.map((row) => row.instrumentId)).toEqual([1, 2]);
    expect(result.requestedInstruments).toBe(2);
  });

  it("honours a requested subset and its order", async () => {
    const provider = providerReturning({
      "NSE:INFY": quoteData(),
      "NSE:TCS": quoteData(),
    });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [2], provider);

    expect(provider.fetchQuotes).toHaveBeenCalledWith(
      "server-side-access-token",
      ["NSE:TCS"]
    );
    expect(result.quotes.map((row) => row.instrumentId)).toEqual([2]);
  });

  it("rejects a valid but foreign instrument id without a provider call", async () => {
    mockFake.seedInstrument({ instrument_id: 3, symbol: "FOREIGN" });
    mockFake.seedItem({ owner: "owner-b", instrumentId: 3 });
    const provider = providerReturning({});

    await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [3], provider),
      "NOT_FOUND"
    );
    expect(provider.fetchQuotes).not.toHaveBeenCalled();
    expect(mockFake.standaloneMarkers).toEqual(["list-quote-instruments"]);
  });

  it("rejects duplicate or non-positive requested ids", async () => {
    const provider = providerReturning({});
    await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1, 1], provider),
      "INVALID_QUERY"
    );
    await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [0], provider),
      "INVALID_QUERY"
    );
    expect(provider.fetchQuotes).not.toHaveBeenCalled();
  });

  it("reports a missing provider quote as UNAVAILABLE, never zero", async () => {
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, undefined, provider);

    const tcs = result.quotes.find((row) => row.symbol === "TCS");
    expect(tcs).toMatchObject({
      lastPrice: null,
      change: null,
      changePercent: null,
      lastTradedAt: null,
      freshness: "UNAVAILABLE",
      errorCode: "QUOTE_NOT_RETURNED",
    });
  });

  it("rejects an invalid price and an invalid provider timestamp", async () => {
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastPrice: 0 }),
      "NSE:TCS": quoteData({ timestamp: "not-a-date" }),
    });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, undefined, provider);

    expect(result.quotes[0]).toMatchObject({
      lastPrice: null,
      freshness: "UNAVAILABLE",
      errorCode: "QUOTE_INVALID",
    });
    expect(result.quotes[1]).toMatchObject({
      lastPrice: null,
      freshness: "UNAVAILABLE",
      errorCode: "QUOTE_TIMESTAMP_INVALID",
    });
  });

  it("labels a valid recent quote LIVE with change and a server fetch time", async () => {
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0]).toMatchObject({
      lastPrice: 105,
      change: 5,
      changePercent: 5,
      lastTradedAt: "2026-11-06T04:58:00.000Z",
      fetchedAt: NOW_OPEN.toISOString(),
      freshness: "LIVE",
      errorCode: null,
    });
    expect(result.market.isOpen).toBe(true);
  });

  it("labels an old but valid quote DELAYED during the session", async () => {
    const provider = providerReturning({
      "NSE:INFY": quoteData({ timestamp: "2026-11-06T04:40:00.000Z" }),
    });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].freshness).toBe("DELAYED");
  });

  it("labels a valid quote LAST_CLOSE when the market is closed", async () => {
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    const result = await getLiveQuotesAt(NOW_CLOSED, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].freshness).toBe("LAST_CLOSE");
    expect(result.market.isOpen).toBe(false);
  });

  it("keeps change null when the provider omits a usable previous close", async () => {
    const provider = providerReturning({
      "NSE:INFY": quoteData({ previousClose: null }),
    });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].lastPrice).toBe(105);
    expect(result.quotes[0].change).toBeNull();
    expect(result.quotes[0].changePercent).toBeNull();
  });

  it("sets lastTradedAt from the trade time and null when it is invalid", async () => {
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastTradeTime: "" }),
    });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].freshness).toBe("LIVE");
    expect(result.quotes[0].lastTradedAt).toBeNull();
  });

  it("attaches signed distances to the nearest demand and supply zones", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      timeframe: "1D",
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "SUPPLY",
      proximal: 110,
      timeframe: "1D",
    });
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastPrice: 105 }),
    });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    const quote = result.quotes[0];
    expect(quote.nearestDemand?.proximal).toBe(100);
    expect(quote.nearestDemand?.distancePercent).toBeCloseTo(5, 10);
    expect(quote.nearestDemand?.distanceBasis).toBe("PROXIMAL");
    expect(quote.nearestSupply?.proximal).toBe(110);
    expect(quote.nearestSupply?.distancePercent).toBeCloseTo(
      ((105 - 110) / 110) * 100,
      10
    );
  });

  it("uses zones.score as the Formation Score and retains low scores", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      score: 37,
      lifecycle: "RETESTED",
    });
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].nearestDemand).toMatchObject({
      formationScore: 37,
      lifecycleState: "RETESTED",
    });
  });

  it("never selects a BROKEN zone as nearest", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      lifecycle: "BROKEN",
    });
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].nearestDemand).toBeNull();
    expect(result.quotes[0].nearestSupply).toBeNull();
  });

  it("never exposes the access token or raw provider payload", async () => {
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("server-side-access-token");
    expect(serialized).not.toContain("instrumentToken");
    expect(serialized).not.toContain("oiDayHigh");
  });

  it("uses the response clock for fetchedAt, market state and freshness", async () => {
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    const result = await getLiveQuotesAt(
      NOW_OPEN,
      OWNER_A,
      SESSION,
      [1],
      provider,
      () => NOW_CLOSED
    );

    expect(result.fetchedAt).toBe(NOW_CLOSED.toISOString());
    expect(result.market.isOpen).toBe(false);
    expect(result.quotes[0]).toMatchObject({
      fetchedAt: NOW_CLOSED.toISOString(),
      freshness: "LAST_CLOSE",
    });
  });

  it("maps each provider failure class without forwarding provider text", async () => {
    const failing = (error: Error): MockProvider =>
      ({
        fetchQuotes: jest.fn(async () => {
          throw error;
        }),
      }) as unknown as MockProvider;

    await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, undefined, failing(new Error("Too many requests"))),
      "RATE_LIMITED"
    );
    jest.restoreAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockFake.setNow(NOW_OPEN);
    mockFake.quoteState.clear();

    const permissionError = await expectLiveTradeError(
      getLiveQuotesAt(
        NOW_OPEN,
        OWNER_A,
        SESSION,
        undefined,
        failing(new Error("PermissionException: internal detail"))
      ),
      "FORBIDDEN"
    );
    expect(JSON.stringify(permissionError.toBody())).not.toContain(
      "internal detail"
    );
  });
});

// ─── Quote-relative nearest zones ───────────────────────────────────────────

describe("quote-relative nearest zone selection", () => {
  it("excludes a demand zone entirely above the current price", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 120,
      distal: 110,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 95,
      distal: 90,
    });
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastPrice: 105 }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].nearestDemand).toMatchObject({
      proximal: 95,
      distal: 90,
    });
  });

  it("excludes a supply zone entirely below the current price", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "SUPPLY",
      timeframe: "1D",
      proximal: 80,
      distal: 90,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "SUPPLY",
      timeframe: "1D",
      proximal: 110,
      distal: 120,
    });
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastPrice: 105 }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].nearestSupply).toMatchObject({
      proximal: 110,
      distal: 120,
    });
  });

  it("keeps a zone that contains the current price eligible on both sides", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 110,
      distal: 100,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "SUPPLY",
      timeframe: "1D",
      proximal: 100,
      distal: 110,
    });
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastPrice: 105 }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].nearestDemand).toMatchObject({
      proximal: 110,
      distal: 100,
    });
    expect(result.quotes[0].nearestSupply).toMatchObject({
      proximal: 100,
      distal: 110,
    });
  });

  it("returns null for a side with no price-eligible zone", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 120,
      distal: 110,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "SUPPLY",
      timeframe: "1D",
      proximal: 80,
      distal: 90,
    });
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastPrice: 105 }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].nearestDemand).toBeNull();
    expect(result.quotes[0].nearestSupply).toBeNull();
  });

  it("falls back to another eligible timeframe when the preferred one is not priced in", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 130,
      distal: 120,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1W",
      proximal: 100,
      distal: 90,
    });
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastPrice: 105 }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].nearestDemand).toMatchObject({
      timeframe: "1W",
      timeframeMatch: "FALLBACK",
      proximal: 100,
    });
  });

  it("applies each instrument's own price in one batched query", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 120,
      distal: 110,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 95,
      distal: 90,
    });
    mockFake.seedZone({
      instrumentId: 2,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 260,
      distal: 250,
    });
    mockFake.seedZone({
      instrumentId: 2,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 320,
      distal: 310,
    });
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastPrice: 105 }),
      "NSE:TCS": quoteData({ lastPrice: 300 }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, undefined, provider);

    const infy = result.quotes.find((row) => row.symbol === "INFY");
    const tcs = result.quotes.find((row) => row.symbol === "TCS");
    expect(infy?.nearestDemand?.proximal).toBe(95);
    expect(tcs?.nearestDemand?.proximal).toBe(260);
    expect(
      mockFake.standaloneMarkers.filter((marker) => marker === "zones:nearest")
    ).toHaveLength(1);
  });

  it("keeps structural selection and a null distance for an unavailable quote", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 120,
      distal: 110,
    });
    const provider = providerReturning({});

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0]).toMatchObject({
      lastPrice: null,
      freshness: "UNAVAILABLE",
      errorCode: "QUOTE_NOT_RETURNED",
    });
    expect(result.quotes[0].nearestDemand).toMatchObject({
      proximal: 120,
      distancePercent: null,
    });
  });

  it("never selects a BROKEN zone even when it satisfies the price rule", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 105,
      distal: 100,
      lifecycle: "BROKEN",
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 90,
      distal: 85,
      lifecycle: "CONFIRMED_FRESH",
    });
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastPrice: 105 }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].nearestDemand).toMatchObject({
      proximal: 90,
      lifecycleState: "CONFIRMED_FRESH",
    });
  });

  it("computes signed distances to the proximal boundary", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 110,
      distal: 100,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "SUPPLY",
      timeframe: "1D",
      proximal: 100,
      distal: 110,
    });
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastPrice: 105 }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0].nearestDemand?.distancePercent).toBeCloseTo(
      ((105 - 110) / 110) * 100,
      10
    );
    expect(result.quotes[0].nearestSupply?.distancePercent).toBeCloseTo(5, 10);
  });
});

// ─── Kite timestamp integration ─────────────────────────────────────────────

describe("Kite timestamp handling", () => {
  it("interprets a 19-character Kite wall clock as IST", async () => {
    const provider = providerReturning({
      "NSE:INFY": quoteData({
        timestamp: "2026-11-06 10:28:00",
        lastTradeTime: "2026-11-06 10:28:00",
      }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0]).toMatchObject({
      freshness: "LIVE",
      lastTradedAt: "2026-11-06T04:58:00.000Z",
    });
  });

  it("accepts a Date representing the same instant as the IST wall clock", async () => {
    const instant = new Date("2026-11-06T04:58:00Z");
    const provider = providerReturning({
      "NSE:INFY": quoteData({
        timestamp: instant,
        lastTradeTime: instant,
      }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0]).toMatchObject({
      freshness: "LIVE",
      lastTradedAt: "2026-11-06T04:58:00.000Z",
    });
  });

  it("accepts ISO timestamps with Z or an explicit offset", async () => {
    const provider = providerReturning({
      "NSE:INFY": quoteData({ timestamp: "2026-11-06T04:58:00Z" }),
      "NSE:TCS": quoteData({ timestamp: "2026-11-06T10:28:00+05:30" }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, undefined, provider);

    expect(result.quotes.map((row) => row.freshness)).toEqual(["LIVE", "LIVE"]);
    expect(result.quotes[1].lastTradedAt).toBe("2026-11-06T04:58:00.000Z");
  });

  it("rejects an unparseable timestamp as UNAVAILABLE", async () => {
    const provider = providerReturning({
      "NSE:INFY": quoteData({ timestamp: "2026-11-06 25:99:99" }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.quotes[0]).toMatchObject({
      lastPrice: null,
      freshness: "UNAVAILABLE",
      errorCode: "QUOTE_TIMESTAMP_INVALID",
    });
  });

  it("tolerates a small future skew but rejects a materially future timestamp", async () => {
    const provider = providerReturning({
      "NSE:INFY": quoteData({ timestamp: "2026-11-06 10:30:30" }),
      "NSE:TCS": quoteData({ timestamp: "2026-11-06 11:30:00" }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, undefined, provider);

    expect(result.quotes[0].freshness).toBe("LIVE");
    expect(result.quotes[1]).toMatchObject({
      lastPrice: null,
      freshness: "UNAVAILABLE",
      errorCode: "QUOTE_TIMESTAMP_INVALID",
    });
  });

  it("produces the same freshness under TZ=UTC as under other runtimes", async () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const provider = providerReturning({
        "NSE:INFY": quoteData({ timestamp: "2026-11-06 10:28:00" }),
      });
      const utc = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

      mockFake.quoteState.clear();
      process.env.TZ = "Asia/Kolkata";
      const ist = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

      expect(utc.quotes[0].freshness).toBe("LIVE");
      expect(ist.quotes[0].freshness).toBe("LIVE");
      expect(utc.quotes[0].lastTradedAt).toBe(ist.quotes[0].lastTradedAt);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

// ─── Zone enrichment failure isolation ──────────────────────────────────────

describe("zone enrichment failure", () => {
  it("keeps valid quotes when the nearest-zone read fails", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    mockFake.failOnce("zones:nearest");
    const provider = providerReturning({
      "NSE:INFY": quoteData({ lastPrice: 105 }),
    });

    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(result.zonesAvailable).toBe(false);
    expect(result.quotes[0]).toMatchObject({
      lastPrice: 105,
      change: 5,
      freshness: "LIVE",
      errorCode: null,
      nearestDemand: null,
      nearestSupply: null,
    });

    const logged = JSON.stringify((console.error as jest.Mock).mock.calls);
    expect(logged).not.toContain("simulated database error");
    expect(logged).not.toContain("SELECT");
  });

  it("still fails the request when the provider itself fails", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    const failing = {
      fetchQuotes: jest.fn(async () => {
        throw new Error("network down");
      }),
    } as unknown as MockProvider;

    await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], failing),
      "QUOTE_FETCH_FAILED"
    );
  });
});

// ─── Cooldown ───────────────────────────────────────────────────────────────

describe("per-owner quote cooldown", () => {
  it("accepts the first request and records only cooldown metadata", async () => {
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    expect(mockFake.quoteState.get("owner-a")).toEqual(NOW_OPEN);
    expect(mockFake.quoteState.size).toBe(1);
    expect(mockFake.standaloneMarkers).toEqual([
      "list-quote-instruments",
      "quote-cooldown:claim",
      "zones:nearest",
    ]);
  });

  it("rejects a second request within five seconds with a retry hint", async () => {
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    const error = await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider),
      "QUOTE_COOLDOWN"
    );
    expect(error.status).toBe(429);
    expect(error.details).toEqual({ retryAfterSeconds: 5 });
  });

  it("rejects a request one millisecond before the boundary and accepts at five seconds", async () => {
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    mockFake.advance(4_999);
    const error = await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider),
      "QUOTE_COOLDOWN"
    );
    expect(error.details).toEqual({ retryAfterSeconds: 1 });

    mockFake.advance(1);
    const result = await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);
    expect(result.quotes).toHaveLength(1);
  });

  it("never calls the provider for a rejected request", async () => {
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);
    provider.fetchQuotes.mockClear();

    await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider),
      "QUOTE_COOLDOWN"
    );
    expect(provider.fetchQuotes).not.toHaveBeenCalled();
  });

  it("keeps owners independent", async () => {
    mockFake.seedInstrument({ instrument_id: 3, symbol: "WIPRO" });
    mockFake.seedItem({ owner: "owner-b", instrumentId: 3 });
    const provider = providerReturning({ "NSE:INFY": quoteData(), "NSE:WIPRO": quoteData() });

    await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, undefined, provider);
    const other = await getLiveQuotesAt(NOW_OPEN, OWNER_B, SESSION, undefined, provider);

    expect(other.quotes.map((row) => row.symbol)).toEqual(["WIPRO"]);
    expect(mockFake.quoteState.has("owner-a")).toBe(true);
    expect(mockFake.quoteState.has("owner-b")).toBe(true);
  });

  it("allows exactly one of two concurrent same-owner requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchQuotes = jest.fn(async () => {
      await gate;
      return new Map([["NSE:INFY", quoteData()]]);
    });
    const provider = { fetchQuotes } as unknown as MockProvider;

    const first = getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);
    const second = getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);
    // Attach handlers immediately so the rejected claim is never unhandled.
    const settled = Promise.allSettled([first, second]);
    // Let both requests reach the atomic claim before the provider gate opens.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const results = await settled;

    const statuses = results.map((result) => result.status);
    expect(statuses.filter((status) => status === "fulfilled")).toHaveLength(1);
    const rejections = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(rejections).toHaveLength(1);
    expect((rejections[0].reason as LiveTradeError).code).toBe("QUOTE_COOLDOWN");
    expect(fetchQuotes).toHaveBeenCalledTimes(1);
  });

  it("consumes the cooldown even when the provider fails", async () => {
    const fetchQuotes = jest.fn(async () => {
      throw new Error("network down");
    });
    const provider = { fetchQuotes } as unknown as MockProvider;

    await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider),
      "QUOTE_FETCH_FAILED"
    );
    await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider),
      "QUOTE_COOLDOWN"
    );
    expect(fetchQuotes).toHaveBeenCalledTimes(1);
  });

  it("counts the retry hint down as time passes", async () => {
    const provider = providerReturning({ "NSE:INFY": quoteData() });
    await getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider);

    mockFake.advance(2_000);
    const error = await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider),
      "QUOTE_COOLDOWN"
    );
    expect(error.details).toEqual({ retryAfterSeconds: 3 });
  });

  it("fails closed when the cooldown claim itself fails", async () => {
    mockFake.failOnce("quote-cooldown:claim");
    const provider = providerReturning({ "NSE:INFY": quoteData() });

    await expectLiveTradeError(
      getLiveQuotesAt(NOW_OPEN, OWNER_A, SESSION, [1], provider),
      "INTERNAL"
    );
    expect(provider.fetchQuotes).not.toHaveBeenCalled();
  });
});
