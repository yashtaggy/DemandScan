/**
 * Regression tests for lib/scanner/hourly_ingest.ts.
 *
 * Production failure being guarded against: after the daily-ingest fix,
 * single-symbol scans reached INGEST_HOURLY and failed with
 * `relation "hourly_ingestion_checkpoints" does not exist` (Postgres code
 * 42P01). The table IS defined in the repo migration
 * (db/migrations/2024-10-18-v1-intraday-scoring-history.sql, section H), but
 * the old db/migrate.js statement splitter crashed on semicolons inside the
 * migration's own comments, so no database ever received it. These tests pin:
 *   1. the v5 SDK call shape (token, '60minute', from, to),
 *   2. candle storage + checkpoint + coverage updates,
 *   3. NSE session filtering for is_session_complete,
 *   4. resume-from-checkpoint behaviour,
 *   5. missing-table (42P01) errors propagating so the batch is marked failed.
 */

import type { KiteSession } from "@/lib/types";

// ─── Mock the Kite client factory (real v5 SDK shape) ───────────────────────

const getHistoricalData = jest.fn();

jest.mock("@/lib/kite-client", () => ({
  createKiteClient: jest.fn(() => ({ getHistoricalData })),
}));

// ─── Mock the database (in-memory hourly tables) ────────────────────────────
//
// `missingTables` simulates a database where a migration never applied —
// any query touching such a table rejects with the real Postgres 42P01 shape.

const hourlyCandles = new Map<string, any>();
const checkpoints = new Map<number, Date>();
const coverage = new Map<string, any>();
const missingTables = new Set<string>();
let firstStoredHourly: Date | string | null = null;

jest.mock("@/lib/db", () => ({
  getDb: () => {
    const sql = async (
      strings: TemplateStringsArray | string,
      ...values: unknown[]
    ) => {
      const query = Array.isArray(strings)
        ? (strings as TemplateStringsArray).join("?")
        : (strings as string);

      for (const table of missingTables) {
        if (query.includes(table)) {
          const err: any = new Error(`relation "${table}" does not exist`);
          err.code = "42P01";
          throw err;
        }
      }

      if (query.includes("hourly_ingestion_checkpoints")) {
        if (query.includes("SELECT")) {
          const cp = checkpoints.get(values[0] as number);
          return [{
            last_candle_ts: cp ?? null,
            first_candle_ts: firstStoredHourly,
          }];
        }
        // INSERT ... ON CONFLICT
        checkpoints.set(values[0] as number, values[1] as Date);
        return [];
      }
      // Order matters: the candle_coverage upsert SELECTs FROM hourly_candles,
      // so it must be matched before the plain hourly_candles insert.
      if (query.includes("candle_coverage")) {
        coverage.set(`${values[0]}:1H`, {
          instrumentId: values[0],
          timeframe: "1H",
        });
        return [];
      }
      if (query.includes("hourly_candles")) {
        const key = `${values[0]}:${(values[1] as Date).toISOString()}`;
        hourlyCandles.set(key, {
          instrumentId: values[0],
          candleTs: values[1],
          open: values[2],
          high: values[3],
          low: values[4],
          close: values[5],
          volume: values[6],
          isSessionComplete: values[7],
          // 'kite' is an inline SQL literal in the query, not a bound param.
          source: "kite",
        });
        return [];
      }
      return [];
    };

    (sql as any).query = async (text: string, params: unknown[]) => {
      for (const table of missingTables) {
        if (text.includes(table)) {
          const err: any = new Error(`relation "${table}" does not exist`);
          err.code = "42P01";
          throw err;
        }
      }
      if (text.includes("INSERT INTO hourly_candles")) {
        // 9 bind params per row.
        for (let i = 0; i + 8 < params.length; i += 9) {
          const key = `${params[i]}:${(params[i + 1] as Date).toISOString()}`;
          hourlyCandles.set(key, {
            instrumentId: params[i],
            candleTs: params[i + 1],
            open: params[i + 2],
            high: params[i + 3],
            low: params[i + 4],
            close: params[i + 5],
            volume: params[i + 6],
            isSessionComplete: params[i + 7],
            source: params[i + 8],
          });
        }
      }
      return [];
    };
    return sql;
  },
}));

// ─── Module under test (imported after mocks) ───────────────────────────────

import { ingestHourlyCandles } from "@/lib/scanner/hourly_ingest";

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
  hourlyCandles.clear();
  checkpoints.clear();
  coverage.clear();
  missingTables.clear();
  firstStoredHourly = null;
});

describe("ingestHourlyCandles — kiteconnect v5 getHistoricalData", () => {
  test("fetches 60-minute candles, stores them, and advances checkpoint + coverage", async () => {
    getHistoricalData.mockResolvedValue([
      sdkCandle("2024-01-02T09:15:00+05:30", 100, 110, 95, 108, 5000),
      sdkCandle("2024-01-02T10:15:00+05:30", 108, 112, 101, 104, 4200),
    ]);

    const from = new Date("2024-01-01T00:00:00Z");
    const to = new Date("2024-01-30T00:00:00Z");
    const inserted = await ingestHourlyCandles(session, INSTRUMENT_ID, from, to);

    expect(inserted).toBe(2);
    // Regression guard: v5 API is (token, interval, from, to) with '60minute'.
    expect(getHistoricalData).toHaveBeenCalledTimes(1);
    expect(getHistoricalData).toHaveBeenCalledWith(
      INSTRUMENT_ID,
      "60minute",
      "2024-01-01 09:15:00",
      "2024-01-30 15:30:00"
    );

    const stored = [...hourlyCandles.values()];
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
    // Checkpoint advanced to the last candle returned.
    expect(checkpoints.get(INSTRUMENT_ID)?.toISOString()).toBe(
      new Date("2024-01-02T10:15:00+05:30").toISOString()
    );
    // Coverage row upserted for the 1H timeframe.
    expect(coverage.has(`${INSTRUMENT_ID}:1H`)).toBe(true);
  });

  test("marks in-session candles complete and out-of-session candles incomplete", async () => {
    getHistoricalData.mockResolvedValue([
      sdkCandle("2024-01-02T08:45:00+05:30"), // pre-open — before 09:15 IST
      sdkCandle("2024-01-02T09:15:00+05:30"), // session open bar
      sdkCandle("2024-01-02T15:15:00+05:30"), // last full bar (covers 15:15–15:30)
    ]);

    await ingestHourlyCandles(
      session,
      INSTRUMENT_ID,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-02T00:00:00Z")
    );

    const flags = [...hourlyCandles.values()].map((c) => c.isSessionComplete);
    expect(flags).toEqual([false, true, true]);
  });

  test("returns 0 and stores nothing for an empty candle response", async () => {
    getHistoricalData.mockResolvedValue([]);

    const inserted = await ingestHourlyCandles(
      session,
      INSTRUMENT_ID,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-30T00:00:00Z")
    );

    expect(inserted).toBe(0);
    expect(hourlyCandles.size).toBe(0);
    expect(checkpoints.has(INSTRUMENT_ID)).toBe(false);
  });

  test("resumes from the checkpoint: next fetch starts the day after the last candle", async () => {
    // 2024-01-02T03:45:00Z == 09:15 IST on Jan 2 — the last stored candle.
    checkpoints.set(INSTRUMENT_ID, new Date("2024-01-02T03:45:00Z"));
    getHistoricalData.mockResolvedValue([sdkCandle("2024-01-03T09:15:00+05:30")]);

    await ingestHourlyCandles(
      session,
      INSTRUMENT_ID,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-30T00:00:00Z")
    );

    expect(getHistoricalData).toHaveBeenCalledTimes(1);
    expect(getHistoricalData).toHaveBeenCalledWith(
      INSTRUMENT_ID,
      "60minute",
      "2024-01-02 09:15:00",
      "2024-01-30 15:30:00"
    );
  });

  test("short-circuits with 0 when the checkpoint is already up to date", async () => {
    checkpoints.set(INSTRUMENT_ID, new Date("2024-06-01T00:00:00Z"));

    const inserted = await ingestHourlyCandles(
      session,
      INSTRUMENT_ID,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-30T00:00:00Z")
    );

    expect(inserted).toBe(0);
    expect(getHistoricalData).not.toHaveBeenCalled();
  });

  test("backfills hourly history older than the stored range instead of skipping it", async () => {
    checkpoints.set(INSTRUMENT_ID, new Date("2025-06-01T00:00:00Z"));
    firstStoredHourly = "2025-01-01T03:45:00Z"; // 09:15 IST
    getHistoricalData.mockResolvedValue([]);

    await ingestHourlyCandles(
      session,
      INSTRUMENT_ID,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2025-06-02T00:00:00Z")
    );

    // Seven 55-day backfill chunks for 2024, then one forward chunk.
    expect(getHistoricalData).toHaveBeenCalledTimes(8);
    expect(getHistoricalData.mock.calls[0][2]).toBe("2024-01-01 09:15:00");
    expect(getHistoricalData.mock.calls[6][3]).toBe("2024-12-31 15:30:00");
    expect(getHistoricalData.mock.calls[7][2]).toBe("2025-06-01 09:15:00");
    expect(checkpoints.get(INSTRUMENT_ID)?.toISOString()).toBe(
      new Date("2025-06-01T00:00:00Z").toISOString()
    );
  });

  test("propagates the real Postgres 42P01 missing-relation error (the production failure)", async () => {
    // Simulates a database where the v1 migration never fully applied:
    // hourly_ingestion_checkpoints does not exist.
    missingTables.add("hourly_ingestion_checkpoints");
    getHistoricalData.mockResolvedValue([sdkCandle("2024-01-02T09:15:00+05:30")]);

    await expect(
      ingestHourlyCandles(
        session,
        INSTRUMENT_ID,
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-30T00:00:00Z")
      )
    ).rejects.toMatchObject({
      message: 'relation "hourly_ingestion_checkpoints" does not exist',
      code: "42P01",
    });

    // Nothing was stored and the Kite API was never reached.
    expect(getHistoricalData).not.toHaveBeenCalled();
    expect(hourlyCandles.size).toBe(0);
  });

  test("retries on the real SDK rate-limit shape (Too many requests) then succeeds", async () => {
    getHistoricalData
      .mockRejectedValueOnce({
        error_type: "NetworkException",
        message: "Too many requests",
        data: null,
      })
      .mockResolvedValueOnce([sdkCandle("2024-01-02T09:15:00+05:30")]);

    const inserted = await ingestHourlyCandles(
      session,
      INSTRUMENT_ID,
      new Date("2024-01-01T00:00:00Z"),
      new Date("2024-01-02T00:00:00Z")
    );

    expect(getHistoricalData).toHaveBeenCalledTimes(2);
    expect(inserted).toBe(1);
    expect(hourlyCandles.size).toBe(1);
  }, 20000); // backoff delay (2^0 * 1000 + jitter) keeps this well under the limit
});
