import { getDb } from "../db";
import { createKiteClient } from "../kite-client";
import type { KiteSession } from "../types";
import type { Candle } from "./types";
import { bulkUpsert } from "./bulk";
import {
  backoffMs,
  isPermanentError,
  isTransientError,
  throttleHistoricalRequests,
} from "./retry";

/**
 * Kite's documented maximum for the `day` interval is 2000 days per request.
 * 1800 keeps a safety margin while fetching a full year of history in ONE
 * call instead of the previous 30-day chunks (≈13 calls per instrument).
 */
const DAILY_CHUNK_DAYS = 1800;
const DAY_MS = 24 * 60 * 60 * 1000;

const MAX_REQUEST_ATTEMPTS = 5;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeChunkEnd(start: Date, to: Date, maxDays = DAILY_CHUNK_DAYS): Date {
  const max = new Date(start);
  max.setDate(max.getDate() + maxDays);
  return max > to ? to : max;
}

/**
 * Normalize a value returned by the Neon HTTP driver. DATE columns come back
 * as "YYYY-MM-DD" strings, not Date objects — calling .getTime() on them was
 * a latent warm-scan crash.
 */
function toDate(value: unknown): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

async function upsertCandles(candles: Candle[]): Promise<number> {
  if (candles.length === 0) return 0;
  return bulkUpsert({
    table: "daily_candles",
    columns: [
      "instrument_id",
      "candle_date",
      "open",
      "high",
      "low",
      "close",
      "volume",
      "source",
    ],
    rows: candles.map((c) => [
      c.instrumentId,
      c.date,
      c.open,
      c.high,
      c.low,
      c.close,
      c.volume,
      c.source,
    ]),
    conflictClause: `ON CONFLICT (instrument_id, candle_date) DO UPDATE SET
      open   = EXCLUDED.open,
      high   = EXCLUDED.high,
      low    = EXCLUDED.low,
      close  = EXCLUDED.close,
      volume = EXCLUDED.volume,
      source = EXCLUDED.source`,
  });
}

interface IngestBounds {
  /** Latest candle covered by the checkpoint (null on a cold start). */
  lastCandle: Date | null;
  /** Earliest daily candle already stored (null on a cold start). */
  firstCandle: Date | null;
}

async function getIngestBounds(instrumentId: number): Promise<IngestBounds> {
  const sql = getDb();
  const rows = await sql`
    SELECT
      (SELECT last_candle_date FROM ingestion_checkpoints
       WHERE instrument_id = ${instrumentId}) AS last_candle_date,
      (SELECT MIN(candle_date) FROM daily_candles
       WHERE instrument_id = ${instrumentId}) AS first_candle_date
  `;
  if (rows.length === 0) return { lastCandle: null, firstCandle: null };
  return {
    lastCandle: toDate(rows[0].last_candle_date),
    firstCandle: toDate(rows[0].first_candle_date),
  };
}

async function setCheckpoint(instrumentId: number, lastDate: Date): Promise<void> {
  const sql = getDb();
  // GREATEST keeps a historical backfill from moving the checkpoint backwards.
  await sql`
    INSERT INTO ingestion_checkpoints (instrument_id, last_candle_date, updated_at)
    VALUES (${instrumentId}, ${lastDate}, NOW())
    ON CONFLICT (instrument_id) DO UPDATE SET
      last_candle_date = GREATEST(ingestion_checkpoints.last_candle_date, EXCLUDED.last_candle_date),
      updated_at = NOW()
  `;
}

async function updateCoverage(instrumentId: number): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO candle_coverage (instrument_id, timeframe, first_candle, last_candle, total_candles, last_updated)
    SELECT
      instrument_id,
      '1D',
      MIN(candle_date),
      MAX(candle_date),
      COUNT(*),
      NOW()
    FROM daily_candles
    WHERE instrument_id = ${instrumentId}
    GROUP BY instrument_id
    ON CONFLICT (instrument_id, timeframe) DO UPDATE SET
      first_candle  = EXCLUDED.first_candle,
      last_candle   = EXCLUDED.last_candle,
      total_candles = EXCLUDED.total_candles,
      last_updated  = EXCLUDED.last_updated
  `;
}

/**
 * Ingest historical daily OHLCV candles for a single instrument.
 *
 * Incremental and idempotent: the `ingestion_checkpoints` row decides where to
 * resume, candles are bulk-upserted, and transient Kite/network failures are
 * retried with bounded backoff. Permanent errors (auth, schema) fail fast.
 *
 * @returns number of candles fetched and upserted
 */
export async function ingestDailyCandles(
  session: KiteSession,
  instrumentId: number,
  fromDate: Date,
  toDate: Date
): Promise<number> {
  if (fromDate > toDate) throw new Error("fromDate must be <= toDate");

  const startedAt = Date.now();
  const { lastCandle, firstCandle } = await getIngestBounds(instrumentId);

  // Forward (incremental) range: resume after the checkpoint.
  const forwardStart = lastCandle
    ? new Date(Math.max(lastCandle.getTime() + DAY_MS, fromDate.getTime()))
    : firstCandle
      ? new Date(Math.max(firstCandle.getTime(), fromDate.getTime()))
      : fromDate;

  const ranges: Array<{ start: Date; end: Date; advanceCheckpoint: boolean }> = [];

  // Historical backfill: a requested range older than the stored history.
  // Without this, an existing checkpoint silently skipped everything the job
  // asked for before the earliest stored candle.
  if (firstCandle) {
    const firstStoredDay = new Date(
      Date.UTC(firstCandle.getUTCFullYear(), firstCandle.getUTCMonth(), firstCandle.getUTCDate())
    );
    const requestedDay = new Date(
      Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate())
    );
    if (firstStoredDay > requestedDay) {
      const backfillEnd = new Date(
        Math.min(toDate.getTime(), firstStoredDay.getTime() - DAY_MS)
      );
      ranges.push({ start: fromDate, end: backfillEnd, advanceCheckpoint: false });
    }
  }

  if (forwardStart <= toDate) {
    ranges.push({ start: forwardStart, end: toDate, advanceCheckpoint: true });
  }

  if (ranges.length === 0) return 0;

  const kc = createKiteClient(session.accessToken);

  let totalUpserted = 0;
  let requests = 0;

  for (const range of ranges) {
    let fetchStart = range.start;
    let attempt = 0;

    while (fetchStart <= range.end) {
      const chunkEnd = computeChunkEnd(fetchStart, range.end);
      const fromStr = fetchStart.toISOString().split("T")[0] + " 09:15:00";
      const toStr = chunkEnd.toISOString().split("T")[0] + " 15:30:00";

      await throttleHistoricalRequests();
      requests++;

      let raw: Awaited<ReturnType<typeof kc.getHistoricalData>>;
      try {
        // kiteconnect v5: getHistoricalData(token, interval, from, to).
        raw = await kc.getHistoricalData(instrumentId, "day", fromStr, toStr);
      } catch (err) {
        if (isPermanentError(err) || !isTransientError(err) || attempt >= MAX_REQUEST_ATTEMPTS) {
          throw err;
        }
        await delay(backoffMs(attempt));
        attempt++;
        continue;
      }

      const candles: Candle[] = raw.map((row) => ({
        instrumentId,
        date: new Date(row.date),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
        source: "kite",
      }));

      totalUpserted += await upsertCandles(candles);

      // Backfill chunks must not touch the forward checkpoint.
      if (range.advanceCheckpoint && candles.length > 0) {
        await setCheckpoint(instrumentId, candles[candles.length - 1].date);
      }

      fetchStart = new Date(chunkEnd.getTime() + DAY_MS);
      attempt = 0;
    }
  }

  await updateCoverage(instrumentId);

  console.info(
    `[candle_ingest] 1D instrument=${instrumentId} requests=${requests} ` +
      `candles=${totalUpserted} backfill=${ranges.some((r) => !r.advanceCheckpoint)} ` +
      `durationMs=${Date.now() - startedAt}`
  );

  return totalUpserted;
}
