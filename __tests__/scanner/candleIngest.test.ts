/**
 * Regression tests for lib/scanner/candle_ingest.ts.
 *
 * Production failure being guarded against: every INGEST_DAILY batch failed
 * with `l.historicalData is not a function` because the code called the legacy
 * kiteconnect v3/v4 API `historicalData(token, from, to, interval)` returning
 * array rows. The installed official SDK (kiteconnect@5.x) exposes
 * `getHistoricalData(token, interval, from, to)` returning
 * `HistoricalData[]` — objects with named { date, open, high, low, close,
 * volume } fields.
 *
 * The mock client below mirrors the real v5 SDK interface (see
 * node_modules/kiteconnect/types/connect.d.ts) — it does not invent a
 * `historicalData` method just to match the old broken code.
 */

import type { KiteSession } from "@/lib/types";

// ─── Mock the Kite client factory (real v5 SDK shape) ───────────────────────

const getHistoricalData = jest.fn();

jest.mock("@/lib/kite-client", () => ({
  createKiteClient: jest.fn(() => ({ getHistoricalData })),
}));

// ─── Mock the database (in-memory daily_candles + checkpoints) ──────────────

const dailyCandles = new Map<string, any>();
const checkpoints = new Map<number, Date>();

jest.mock("@/lib/db", () => ({
  getDb: () => {
    const sql = async (
      strings: TemplateStringsArray | string,
      ...values: unknown[]
    ) => {
      const query = Array.isArray(strings)
        ? (strings as TemplateStringsArray).join("?")
        : (strings as string);

      if (query.includes("SELECT") && query.includes("ingestion_checkpoints")) {
        const cp = checkpoints.get(values[0] as number);
        return cp ? [{ last_candle_date: cp }] : [];
      }
      if (query.includes("INSERT") && query.includes("daily_candles")) {
        const key = `${values[0]}:${(values[1] as Date).toISOString()}`;
        dailyCandles.set(key, {
          instrumentId: values[0],
          date: values[1],
          open: values[2],
          high: values[3],
          low: values[4],
          close: values[5],
          volume: values[6],
          source: values[7],
        });
        return [];
      }
      if (query.includes("INSERT") && query.includes("ingestion_checkpoints")) {
        checkpoints.set(values[0] as number, values[1] as Date);
        return [];
      }
      return [];
    };
    return sql;
  },
}));

// ─── Module under test (imported after mocks) ───────────────────────────────

import { ingestDailyCandles } from "@/lib/scanner/candle_ingest";

const session: KiteSession = {
  accessToken: "token",
  userId: "user",
  userName: "User",
  email: "u@example.com",
  loginTime: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

const INSTRUMENT_ID = 408065;

function sdkCandle(date: string, o = 100, h = 105, l = 95, c = 102, v = 1000) {
  // Real SDK (parseHistorical) returns named-field objects.
  return { date: new Date(date), open: o, high: h, low: l, close: c, volume: v };
}

beforeEach(() => {
  jest.clearAllMocks();
  dailyCandles.clear();
  checkpoints.clear();
});

describe("ingestDailyCandles — kiteconnect v5 getHistoricalData", () => {
  test("fetches daily candles with the correct SDK call and normalizes rows", async () => {
    getHistoricalData.mockResolvedValue([
      sdkCandle("2024-01-02T00:00:00+05:30", 100, 110, 95, 108, 5000),
      sdkCandle("2024-01-03T00:00:00+05:30", 108, 112, 101, 104, 4200),
    ]);

    const from = new Date("2024-01-01T00:00:00Z");
    const to = new Date("2024-01-30T00:00:00Z");
    const inserted = await ingestDailyCandles(session, INSTRUMENT_ID, from, to);

    expect(inserted).toBe(2);
    // Regression guard: interval is the 2nd argument in the v5 API
    // (token, interval, from, to) — the broken code passed it 4th and used
    // the non-existent `historicalData` name.
    expect(getHistoricalData).toHaveBeenCalledTimes(1);
    expect(getHistoricalData).toHaveBeenCalledWith(
      INSTRUMENT_ID,
      "day",
      "2024-01-01 09:15:00",
      "2024-01-30 15:30:00"
    );

    const stored = [...dailyCandles.values()];
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      instrumentId: INSTRUMENT_ID,
      open: 100,
      high: 110,
      low: 95,
      close: 108,
      volume: 5000,
      source: "kite",
    });
    // Checkpoint advanced to the last candle.
    expect(checkpoints.get(INSTRUMENT_ID)?.toISOString()).toBe(
      new Date("2024-01-03T00:00:00+05:30").toISOString()
    );
  });

  test("returns 0 and stores nothing for an empty candle response", async () => {
    getHistoricalData.mockResolvedValue([]);

    const inserted = await ingestDailyCandles(
      session,
      INSTRUMENT_ID,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-30T00:00:00Z")
    );

    expect(inserted).toBe(0);
    expect(dailyCandles.size).toBe(0);
    expect(checkpoints.has(INSTRUMENT_ID)).toBe(false);
  });

  test("rethrows historical-data API errors so the batch is marked failed", async () => {
    // Real SDK rejection shape: plain object with error_type + message
    // (see kiteconnect dist/lib/connect.js request interceptor).
    getHistoricalData.mockRejectedValue({
      error_type: "InputException",
      message: "no candles found for instrument",
      data: null,
    });

    await expect(
      ingestDailyCandles(
        session,
        INSTRUMENT_ID,
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-30T00:00:00Z")
      )
    ).rejects.toMatchObject({ message: "no candles found for instrument" });

    expect(dailyCandles.size).toBe(0);
    expect(checkpoints.has(INSTRUMENT_ID)).toBe(false);
  });

  test("retries on the real SDK rate-limit shape (Too many requests) then succeeds", async () => {
    getHistoricalData
      .mockRejectedValueOnce({
        error_type: "NetworkException",
        message: "Too many requests",
        data: null,
      })
      .mockResolvedValueOnce([sdkCandle("2024-01-02T00:00:00+05:30")]);

    const inserted = await ingestDailyCandles(
      session,
      INSTRUMENT_ID,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-02T00:00:00Z")
    );

    expect(getHistoricalData).toHaveBeenCalledTimes(2);
    // Same chunk retried — identical arguments both times.
    expect(getHistoricalData).toHaveBeenNthCalledWith(
      2,
      INSTRUMENT_ID,
      "day",
      "2024-01-01 09:15:00",
      "2024-01-02 15:30:00"
    );
    expect(inserted).toBe(1);
    expect(dailyCandles.size).toBe(1);
  });

  test("does not retry non-recoverable API errors", async () => {
    getHistoricalData.mockRejectedValue({
      error_type: "PermissionException",
      message: "Invalid `api_key` or `access_token`",
      data: null,
    });

    await expect(
      ingestDailyCandles(
        session,
        INSTRUMENT_ID,
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-02T00:00:00Z")
      )
    ).rejects.toMatchObject({ error_type: "PermissionException" });

    expect(getHistoricalData).toHaveBeenCalledTimes(1);
  });
});
