/**
 * lib/scanner/hourly_ingest.ts
 *
 * Fetches 60-minute (1H) historical candles from Kite and stores them in the
 * `hourly_candles` table. Uses per-instrument checkpoints for incremental
 * (resumable) ingestion.
 *
 * Kite API details for 60-minute interval:
 *   - Endpoint param: "60minute"
 *   - Max date range per request: 60 days
 *   - Timestamps returned in IST (Asia/Kolkata)
 *   - Data available from ~2010 for NSE EQ instruments
 *
 * Session filtering:
 *   NSE trading session: 09:15 – 15:30 IST.
 *   Candles outside this window (e.g. pre-open) are stored but flagged
 *   is_session_complete = false so they are excluded from zone formation.
 */

import { getDb } from '../db';
import { createKiteClient } from '../kite-client';
import type { KiteSession } from '../types';
import { bulkUpsert } from './bulk';
import {
  backoffMs,
  isPermanentError,
  isTransientError,
  sanitizeErrorMessage,
  throttleHistoricalRequests,
} from './retry';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Kite max range for 60-minute interval is 60 days per request. */
const CHUNK_DAYS = 55; // conservative

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const MAX_REQUEST_ATTEMPTS = 5;

/** NSE session boundaries in IST (hours:minutes, 24h) */
const SESSION_START_H = 9;
const SESSION_START_M = 15;
const SESSION_END_H = 15;
const SESSION_END_M = 30;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function computeChunkEnd(start: Date, to: Date): Date {
  const max = new Date(start);
  max.setDate(max.getDate() + CHUNK_DAYS);
  return max > to ? to : max;
}

/**
 * Returns true if a candle timestamp (IST) falls within the NSE trading session.
 * Candle ts represents the bar OPEN time; a 15:15 bar covers 15:15–15:30 and is valid.
 * Any bar opening before 09:15 or at/after 15:30 is outside session.
 */
function isWithinSession(ts: Date): boolean {
  // Convert to IST offset manually: IST = UTC + 5:30
  const istMs = ts.getTime() + 5.5 * 60 * 60 * 1000;
  const istDate = new Date(istMs);
  const h = istDate.getUTCHours();
  const m = istDate.getUTCMinutes();
  const totalMin = h * 60 + m;
  const startMin = SESSION_START_H * 60 + SESSION_START_M; // 555
  const endMin   = SESSION_END_H   * 60 + SESSION_END_M;   // 930
  return totalMin >= startMin && totalMin < endMin;
}

/** Format a Date as "YYYY-MM-DD HH:MM:SS" in IST for Kite API. */
function toKiteDateStr(d: Date, endOfDay = false): string {
  // Kite expects IST dates without timezone suffix
  const istMs = d.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const yyyy = ist.getUTCFullYear();
  const mm   = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(ist.getUTCDate()).padStart(2, '0');
  const time = endOfDay ? '15:30:00' : '09:15:00';
  return `${yyyy}-${mm}-${dd} ${time}`;
}

// ─── Checkpoint helpers ───────────────────────────────────────────────────────

interface IngestBounds {
  /** Latest candle covered by the checkpoint (null on a cold start). */
  lastCandle: Date | null;
  /** Earliest hourly candle already stored (null on a cold start). */
  firstCandle: Date | null;
}

async function getIngestBounds(instrumentId: number): Promise<IngestBounds> {
  const sql = getDb();
  const rows = await sql`
    SELECT
      (SELECT last_candle_ts FROM hourly_ingestion_checkpoints
       WHERE instrument_id = ${instrumentId}) AS last_candle_ts,
      (SELECT MIN(candle_ts) FROM hourly_candles
       WHERE instrument_id = ${instrumentId}) AS first_candle_ts
  `;
  if (!rows.length) return { lastCandle: null, firstCandle: null };
  return {
    lastCandle: toDate(rows[0].last_candle_ts),
    firstCandle: toDate(rows[0].first_candle_ts),
  };
}

async function setCheckpoint(instrumentId: number, lastTs: Date): Promise<void> {
  const sql = getDb();
  // GREATEST keeps a historical backfill from moving the checkpoint backwards.
  await sql`
    INSERT INTO hourly_ingestion_checkpoints (instrument_id, last_candle_ts, updated_at)
    VALUES (${instrumentId}, ${lastTs}, NOW())
    ON CONFLICT (instrument_id) DO UPDATE SET
      last_candle_ts = GREATEST(hourly_ingestion_checkpoints.last_candle_ts, EXCLUDED.last_candle_ts),
      updated_at = NOW()
  `;
}

// ─── Coverage update ─────────────────────────────────────────────────────────

async function updateCoverage(instrumentId: number): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO candle_coverage (instrument_id, timeframe, first_candle, last_candle, total_candles, last_updated)
    SELECT
      instrument_id,
      '1H',
      MIN(candle_ts::date),
      MAX(candle_ts::date),
      COUNT(*),
      NOW()
    FROM hourly_candles
    WHERE instrument_id = ${instrumentId}
    GROUP BY instrument_id
    ON CONFLICT (instrument_id, timeframe) DO UPDATE SET
      first_candle  = EXCLUDED.first_candle,
      last_candle   = EXCLUDED.last_candle,
      total_candles = EXCLUDED.total_candles,
      last_updated  = EXCLUDED.last_updated
  `;
}

// ─── Main ingest function ─────────────────────────────────────────────────────

/**
 * Ingest 60-minute historical candles for a single instrument.
 * Idempotent — uses checkpoints; only fetches missing windows, bulk-upserts
 * rows, retries transient failures with bounded backoff, and fails fast on
 * permanent errors.
 *
 * @returns number of candles fetched and upserted
 */
export async function ingestHourlyCandles(
  session: KiteSession,
  instrumentId: number,
  fromDate: Date,
  toDate: Date
): Promise<number> {
  if (fromDate > toDate) throw new Error('fromDate must be <= toDate');

  const startedAt = Date.now();
  const { lastCandle, firstCandle } = await getIngestBounds(instrumentId);

  const forwardStart = lastCandle
    ? new Date(Math.max(lastCandle.getTime() + HOUR_MS, fromDate.getTime()))
    : firstCandle
      ? new Date(Math.max(firstCandle.getTime(), fromDate.getTime()))
      : fromDate;

  const ranges: Array<{ start: Date; end: Date; advanceCheckpoint: boolean }> = [];

  // Historical backfill: a requested range starting before the stored hourly
  // history. Compare IST calendar days because Kite windows are IST-based.
  if (firstCandle) {
    const requestedDay = toKiteDateStr(fromDate).slice(0, 10);
    const firstStoredDay = toKiteDateStr(firstCandle).slice(0, 10);
    if (requestedDay < firstStoredDay) {
      const backfillEnd = new Date(
        Math.min(toDate.getTime(), firstCandle.getTime() - DAY_MS)
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
      const fromStr = toKiteDateStr(fetchStart, false);
      const toStr   = toKiteDateStr(chunkEnd, true);

      await throttleHistoricalRequests();
      requests++;

      let raw: Awaited<ReturnType<typeof kc.getHistoricalData>>;
      try {
        // kiteconnect v5: getHistoricalData(token, interval, from, to).
        raw = await kc.getHistoricalData(instrumentId, '60minute', fromStr, toStr);
      } catch (err) {
        if (isPermanentError(err) || !isTransientError(err) || attempt >= MAX_REQUEST_ATTEMPTS) {
          throw err;
        }
        await delay(backoffMs(attempt));
        attempt++;
        continue;
      }

      const rows = raw.map((row) => {
        const candleTs = new Date(row.date);
        return [
          instrumentId,
          candleTs,
          Number(row.open),
          Number(row.high),
          Number(row.low),
          Number(row.close),
          Number(row.volume),
          isWithinSession(candleTs),
          'kite',
        ];
      });

      totalUpserted += await bulkUpsert({
        table: 'hourly_candles',
        columns: [
          'instrument_id',
          'candle_ts',
          'open',
          'high',
          'low',
          'close',
          'volume',
          'is_session_complete',
          'source',
        ],
        rows,
        conflictClause: `ON CONFLICT (instrument_id, candle_ts) DO UPDATE SET
        open  = EXCLUDED.open,
        high  = EXCLUDED.high,
        low   = EXCLUDED.low,
        close  = EXCLUDED.close,
        volume = EXCLUDED.volume,
        is_session_complete = EXCLUDED.is_session_complete,
        source = EXCLUDED.source`,
      });

      // Backfill chunks must not touch the forward checkpoint.
      if (range.advanceCheckpoint && raw.length > 0) {
        await setCheckpoint(instrumentId, new Date(raw[raw.length - 1].date));
      }

      fetchStart = new Date(chunkEnd.getTime() + DAY_MS);
      attempt = 0;
    }
  }

  await updateCoverage(instrumentId);

  console.info(
    `[hourly_ingest] 1H instrument=${instrumentId} requests=${requests} ` +
      `candles=${totalUpserted} backfill=${ranges.some((r) => !r.advanceCheckpoint)} ` +
      `durationMs=${Date.now() - startedAt}`
  );

  return totalUpserted;
}

/**
 * Ingest 1H candles for all active instruments.
 */
export async function ingestAllHourlyCandles(
  session: KiteSession,
  fromDate: Date,
  toDate: Date,
  concurrency = 3 // lower than daily — intraday is more rate-limit sensitive
): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    SELECT instrument_id FROM instruments WHERE active = true ORDER BY instrument_id
  `;
  const ids: number[] = rows.map((r: any) => Number(r.instrument_id));

  let total = 0;
  const failures: Array<{ instrumentId: number; message: string }> = [];
  let permanentFailure: unknown = null;
  const pool = new Set<Promise<void>>();

  for (const id of ids) {
    const p: Promise<void> = (async () => {
      if (permanentFailure) return;
      try {
        total += await ingestHourlyCandles(session, id, fromDate, toDate);
      } catch (err) {
        failures.push({ instrumentId: id, message: sanitizeErrorMessage(err) });
        if (isPermanentError(err) && permanentFailure == null) permanentFailure = err;
      }
    })()
      .finally(() => pool.delete(p));
    pool.add(p);
    if (pool.size >= concurrency) await Promise.race(pool);
  }
  await Promise.all(pool);

  // A partial hourly ingest must not be reported as success.
  if (permanentFailure) throw permanentFailure;
  if (failures.length > 0) {
    const sample = failures
      .slice(0, 5)
      .map((f) => `${f.instrumentId}: ${f.message}`)
      .join('; ');
    throw new Error(
      `${failures.length}/${ids.length} instrument(s) failed hourly ingestion: ${sample}`
    );
  }

  return total;
}
