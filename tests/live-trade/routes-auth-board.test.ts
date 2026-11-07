/**
 * Route tests for authentication, mutation-origin protection, the board and
 * instrument search.
 *
 * These run the real HTTP helper, real service and real repository against the
 * stateful fake database; only the Next response object and the Kite session
 * lookup are substituted.
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
import { GET as getBoard } from "@/app/api/live-trade/board/route";
import { GET as searchInstrumentsRoute } from "@/app/api/live-trade/instruments/route";
import { POST as createGroupRoute } from "@/app/api/live-trade/groups/route";
import { POST as createItemRoute } from "@/app/api/live-trade/items/route";
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
  base?: string;
  contentType?: string | null;
}

function request(path: string, options: RequestOptions = {}): NextRequest {
  const base = options.base ?? "https://app.example";
  const method = options.method ?? "GET";
  const headers = new Headers();

  if (options.origin !== null) {
    headers.set("origin", options.origin ?? base);
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

  return new Request(`${base}${path}`, { method, headers, body }) as unknown as NextRequest;
}

async function call(
  handler: (req: NextRequest, ctx?: unknown) => Promise<unknown>,
  req: NextRequest
): Promise<{ status: number; headers: Headers; body: JsonBody }> {
  const res = (await handler(req)) as MockResponse;
  return { status: res.status, headers: res.headers, body: await res.json() };
}

function signIn(userId: string | null = "owner-a"): void {
  sessionMock.mockResolvedValue(
    userId === null ? null : ({ userId } as unknown as never)
  );
}

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

  sessionMock.mockReset();
  signIn();
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Authentication ─────────────────────────────────────────────────────────

describe("authentication", () => {
  it("rejects a missing session with 401 and does no database work", async () => {
    signIn(null);
    const { status, body } = await call(getBoard, request("/api/live-trade/board"));
    expect(status).toBe(401);
    expect(body).toEqual({ error: "Authentication required.", code: "UNAUTHENTICATED" });
    expect(mockFake.standaloneMarkers).toEqual([]);
  });

  it("rejects an expired session the same way", async () => {
    // getSessionFromRequest returns null for expired or unknown sessions.
    signIn(null);
    const { status, body } = await call(
      searchInstrumentsRoute,
      request("/api/live-trade/instruments?q=infy")
    );
    expect(status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a blank owner id even when the session row exists", async () => {
    signIn("   ");
    const { status, body } = await call(getBoard, request("/api/live-trade/board"));
    expect(status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("rejects an owner id longer than 64 characters", async () => {
    signIn("x".repeat(65));
    const { status, body } = await call(getBoard, request("/api/live-trade/board"));
    expect(status).toBe(401);
    expect(body.code).toBe("UNAUTHENTICATED");
  });

  it("maps a session-store failure to 500 without leaking the driver message", async () => {
    sessionMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    const { status, body } = await call(getBoard, request("/api/live-trade/board"));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "An unexpected error occurred.", code: "INTERNAL" });
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("ignores owner values supplied in query parameters and headers", async () => {
    mockFake.seedGroup({ owner: "owner-b", name: "Theirs" });
    const req = request(
      "/api/live-trade/board?ownerId=owner-b&owner_user_id=owner-b"
    );
    req.headers.set("x-owner-id", "owner-b");
    req.headers.set("x-owner-user-id", "owner-b");

    const { status, body } = await call(getBoard, req);
    expect(status).toBe(200);
    expect(body.data.groups).toEqual([]);
  });

  it("ignores owner fields supplied in a create body", async () => {
    const { status, body } = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        body: { instrumentId: 1, ownerUserId: "attacker" },
      })
    );
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_BODY");
    expect(body.details.issues[0].field).toBe("ownerUserId");
    expect(mockFake.items).toEqual([]);
  });
});

// ─── Mutation origin protection ─────────────────────────────────────────────

describe("mutation origin protection", () => {
  it("accepts the configured production origin", async () => {
    const { status, body } = await call(
      createGroupRoute,
      request("/api/live-trade/groups", {
        method: "POST",
        origin: "https://app.example",
        body: { name: "Momentum" },
      })
    );
    expect(status).toBe(201);
    expect(body.data.name).toBe("Momentum");
  });

  it("accepts a loopback development origin outside production", async () => {
    const { status } = await call(
      createGroupRoute,
      request("/api/live-trade/groups", {
        method: "POST",
        base: "http://localhost:3000",
        origin: "http://localhost:3000",
        body: { name: "Local" },
      })
    );
    expect(status).toBe(201);
  });

  it("rejects an unexpected origin with 403 and no mutation", async () => {
    const { status, body } = await call(
      createGroupRoute,
      request("/api/live-trade/groups", {
        method: "POST",
        origin: "https://evil.example",
        body: { name: "Nope" },
      })
    );
    expect(status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
    expect(mockFake.groups).toEqual([]);
  });

  it("rejects a missing Origin header", async () => {
    const { status, body } = await call(
      createGroupRoute,
      request("/api/live-trade/groups", {
        method: "POST",
        origin: null,
        body: { name: "Nope" },
      })
    );
    expect(status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
    expect(mockFake.groups).toEqual([]);
  });

  it("rejects a malformed Origin header", async () => {
    const { status, body } = await call(
      createGroupRoute,
      request("/api/live-trade/groups", {
        method: "POST",
        origin: "not a url",
        body: { name: "Nope" },
      })
    );
    expect(status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
  });

  it("rejects a loopback origin in production mode", async () => {
    const env = process.env as Record<string, string | undefined>;
    const original = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const { status, body } = await call(
        createGroupRoute,
        request("/api/live-trade/groups", {
          method: "POST",
          base: "http://localhost:3000",
          origin: "http://localhost:3000",
          body: { name: "Nope" },
        })
      );
      expect(status).toBe(403);
      expect(body.code).toBe("FORBIDDEN");
    } finally {
      env.NODE_ENV = original;
    }
  });

  it("rejects before authentication, so no session or database work occurs", async () => {
    signIn(null);
    const { status } = await call(
      createItemRoute,
      request("/api/live-trade/items", {
        method: "POST",
        origin: "https://evil.example",
        body: { instrumentId: 1 },
      })
    );
    expect(status).toBe(403);
    expect(mockFake.transactions).toEqual([]);
    expect(mockFake.standaloneMarkers).toEqual([]);
  });
});

// ─── Board ──────────────────────────────────────────────────────────────────

describe("GET /api/live-trade/board", () => {
  it("returns an empty board with an available zone section and no summaries", async () => {
    mockFake.reset();
    const { status, body } = await call(getBoard, request("/api/live-trade/board"));
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.groups).toEqual([]);
    expect(body.data.items).toEqual([]);
    expect(body.data.instrumentMaster).toMatchObject({
      latestInstrumentUpdateAt: null,
      freshness: "unknown",
      stale: null,
    });
    expect(body.data.zones).toEqual({
      available: true,
      status: "available",
      freshnessThresholdDays: 7,
      summaries: [],
    });
    expect(Number.isNaN(Date.parse(body.data.generatedAt))).toBe(false);
  });

  it("returns groups and items in saved order", async () => {
    mockFake.seedGroup({ owner: "owner-a", name: "Second", sortOrder: 2 });
    mockFake.seedGroup({ owner: "owner-a", name: "First", sortOrder: 0 });
    mockFake.seedGroup({ owner: "owner-a", name: "Middle", sortOrder: 1 });

    mockFake.seedItem({ owner: "owner-a", instrumentId: 1, sortOrder: 1 });
    mockFake.seedItem({ owner: "owner-a", instrumentId: 2, sortOrder: 0 });

    const { body } = await call(getBoard, request("/api/live-trade/board"));
    expect(body.data.groups.map((g: { name: string }) => g.name)).toEqual([
      "First",
      "Middle",
      "Second",
    ]);
    expect(body.data.items.map((i: { symbol: string }) => i.symbol)).toEqual([
      "TCS",
      "INFY",
    ]);
    expect(body.data.items[0].companyName).toBe("Tata Consultancy Services");
  });

  it("isolates the owner's board from another owner's rows", async () => {
    mockFake.seedGroup({ owner: "owner-b", name: "Theirs" });
    mockFake.seedItem({ owner: "owner-b", instrumentId: 1 });

    const { body } = await call(getBoard, request("/api/live-trade/board"));
    expect(body.data.groups).toEqual([]);
    expect(body.data.items).toEqual([]);
  });

  it("maps a database failure to a sanitized 500", async () => {
    mockFake.failOnce("list-groups");
    const { status, body } = await call(getBoard, request("/api/live-trade/board"));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "An unexpected error occurred.", code: "INTERNAL" });
    expect(JSON.stringify(body)).not.toContain("simulated database error");
  });

  it("exposes the newest row update but never infers freshness from it", async () => {
    mockFake.reset();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    mockFake.seedInstrument({ instrument_id: 3, symbol: "OLD", updated_at: old });

    const { status, body } = await call(getBoard, request("/api/live-trade/board"));
    expect(status).toBe(200);
    expect(body.data.instrumentMaster).toEqual({
      latestInstrumentUpdateAt: old.toISOString(),
      activeInstrumentCount: 1,
      freshness: "unknown",
      stale: null,
    });
  });

  it("is quote-free and scan-free: three read statements only", async () => {
    await call(getBoard, request("/api/live-trade/board"));
    expect(mockFake.transactions).toEqual([]);
    expect([...mockFake.standaloneMarkers].sort()).toEqual([
      "instrument-master-info",
      "list-groups",
      "list-items",
    ]);
  });
});

// ─── Instrument search ──────────────────────────────────────────────────────

describe("GET /api/live-trade/instruments", () => {
  it("matches an exact symbol case-insensitively", async () => {
    const { status, body } = await call(
      searchInstrumentsRoute,
      request("/api/live-trade/instruments?q=infy")
    );
    expect(status).toBe(200);
    expect(body.data.query).toBe("infy");
    expect(body.data.instruments[0]).toMatchObject({
      instrumentId: 1,
      symbol: "INFY",
      tradingSymbol: "INFY",
      name: "Infosys Limited",
      exchange: "NSE",
      active: true,
    });
  });

  it("matches a partial symbol", async () => {
    const { body } = await call(
      searchInstrumentsRoute,
      request("/api/live-trade/instruments?q=NF")
    );
    expect(body.data.instruments.map((i: { symbol: string }) => i.symbol)).toEqual([
      "INFY",
    ]);
  });

  it("matches a company name", async () => {
    const { body } = await call(
      searchInstrumentsRoute,
      request("/api/live-trade/instruments?q=consultancy")
    );
    expect(body.data.instruments.map((i: { symbol: string }) => i.symbol)).toEqual([
      "TCS",
    ]);
  });

  it("trims surrounding whitespace", async () => {
    const { body } = await call(
      searchInstrumentsRoute,
      request(`/api/live-trade/instruments?q=${encodeURIComponent("  TCS  ")}`)
    );
    expect(body.data.query).toBe("TCS");
    expect(body.data.instruments).toHaveLength(1);
  });

  it("rejects missing, empty and whitespace-only queries", async () => {
    for (const qs of ["", "?q=", `?q=${encodeURIComponent("   ")}`]) {
      const { status, body } = await call(
        searchInstrumentsRoute,
        request(`/api/live-trade/instruments${qs}`)
      );
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_QUERY");
    }
    expect(mockFake.standaloneMarkers).toEqual([]);
  });

  it("rejects a query longer than 50 characters", async () => {
    const { status, body } = await call(
      searchInstrumentsRoute,
      request(`/api/live-trade/instruments?q=${"a".repeat(51)}`)
    );
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_QUERY");
  });

  it("accepts exactly 50 characters", async () => {
    const { status } = await call(
      searchInstrumentsRoute,
      request(`/api/live-trade/instruments?q=${"a".repeat(50)}`)
    );
    expect(status).toBe(200);
  });

  it("caps results at 20", async () => {
    for (let index = 0; index < 25; index += 1) {
      mockFake.seedInstrument({
        instrument_id: 100 + index,
        symbol: `MATCH${index}`,
        company_name: "Match Corp",
      });
    }
    const { body } = await call(
      searchInstrumentsRoute,
      request("/api/live-trade/instruments?q=match")
    );
    expect(body.data.instruments).toHaveLength(20);
  });

  it("excludes inactive and non-NSE instruments", async () => {
    mockFake.seedInstrument({
      instrument_id: 50,
      symbol: "INFYINACTIVE",
      active: false,
    });
    mockFake.seedInstrument({
      instrument_id: 51,
      symbol: "INFYBSE",
      exchange: "BSE",
    });

    const { body } = await call(
      searchInstrumentsRoute,
      request("/api/live-trade/instruments?q=infy")
    );
    expect(body.data.instruments.map((i: { symbol: string }) => i.symbol)).toEqual([
      "INFY",
    ]);
  });

  it("reports the master update time as unknown freshness and never syncs", async () => {
    mockFake.reset();
    mockFake.seedInstrument({
      instrument_id: 60,
      symbol: "OLD",
      updated_at: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    });

    const { body } = await call(
      searchInstrumentsRoute,
      request("/api/live-trade/instruments?q=OLD")
    );
    expect(body.data.instrumentMaster.freshness).toBe("unknown");
    expect(body.data.instrumentMaster.stale).toBeNull();
    expect([...mockFake.standaloneMarkers].sort()).toEqual([
      "instrument-master-info",
      "search-instruments",
    ]);
    expect(mockFake.transactions).toEqual([]);
  });

  it("returns an explicit empty state when the master has no rows", async () => {
    mockFake.reset();
    const { status, body } = await call(
      searchInstrumentsRoute,
      request("/api/live-trade/instruments?q=INFY")
    );
    expect(status).toBe(200);
    expect(body.data.instruments).toEqual([]);
    expect(body.data.instrumentMaster).toMatchObject({
      latestInstrumentUpdateAt: null,
      freshness: "unknown",
      activeInstrumentCount: 0,
    });
  });

  it("returns only public instrument fields", async () => {
    const { body } = await call(
      searchInstrumentsRoute,
      request("/api/live-trade/instruments?q=INFY")
    );
    expect(Object.keys(body.data.instruments[0]).sort()).toEqual([
      "active",
      "exchange",
      "instrumentId",
      "name",
      "symbol",
      "tradingSymbol",
      "updatedAt",
    ]);
  });
});
