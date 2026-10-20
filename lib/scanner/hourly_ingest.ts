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

// ─── Constants ────────────────────────────────────────────────────────────────

/** Kite max range for 60-minute interval is 60 days per request. */
const CHUNK_DAYS = 55; // conservative

/** NSE session boundaries in IST (hours:minutes, 24h) */
const SESSION_START_H = 9;
const SESSION_START_M = 15;
const SESSION_END_H = 15;
const SESSION_END_M = 30;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
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

async function getCheckpoint(instrumentId: number): Promise<Date | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT last_candle_ts FROM hourly_ingestion_checkpoints
    WHERE instrument_id = ${instrumentId}
  `;
  return rows.length ? new Date(rows[0].last_candle_ts as string) : null;
}

async function setCheckpoint(instrumentId: number, lastTs: Date): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO hourly_ingestion_checkpoints (instrument_id, last_candle_ts, updated_at)
    VALUES (${instrumentId}, ${lastTs}, NOW())
    ON CONFLICT (instrument_id) DO UPDATE SET
      last_candle_ts = EXCLUDED.last_candle_ts,
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
 * Idempotent — uses checkpoints; only fetches missing dates.
 *
 * @returns number of newly inserted candles
 */
export async function ingestHourlyCandles(
  session: KiteSession,
  instrumentId: number,
  fromDate: Date,
  toDate: Date
): Promise<number> {
  if (fromDate > toDate) throw new Error('fromDate must be <= toDate');

  const checkpoint = await getCheckpoint(instrumentId);
  // Start from day after last checkpoint, or fromDate, whichever is later
  let fetchStart = checkpoint
    ? new Date(Math.max(checkpoint.getTime() + 60 * 60 * 1000, fromDate.getTime()))
    : fromDate;

  if (fetchStart > toDate) return 0;

  const kc = createKiteClient(session.accessToken);
  const sql = getDb();
  let totalInserted = 0;
  let attempt = 0;
  const maxAttempts = 5;

  while (fetchStart <= toDate) {
    const chunkEnd = computeChunkEnd(fetchStart, toDate);
    const fromStr = toKiteDateStr(fetchStart, false);
    const toStr   = toKiteDateStr(chunkEnd, true);

    try {
      // kiteconnect v5 API: getHistoricalData(token, interval, from, to).
      // Returns HistoricalData[] — objects with named fields, not arrays.
      const raw = await kc.getHistoricalData(instrumentId, '60minute', fromStr, toStr);

      const sql2 = getDb();
      let chunkInserted = 0;

      for (const row of raw) {
        const candleTs = new Date(row.date);
        const withinSession = isWithinSession(candleTs);

        await sql2`
          INSERT INTO hourly_candles (
            instrument_id, candle_ts, open, high, low, close, volume,
            is_session_complete, source
          ) VALUES (
            ${instrumentId},
            ${candleTs},
            ${Number(row.open)}, ${Number(row.high)}, ${Number(row.low)}, ${Number(row.close)},
            ${Number(row.volume)},
            ${withinSession},
            'kite'
          )
          ON CONFLICT (instrument_id, candle_ts) DO UPDATE SET
            open  = EXCLUDED.open,
            high  = EXCLUDED.high,
            low   = EXCLUDED.low,
            close = EXCLUDED.close,
            volume = EXCLUDED.volume,
            is_session_complete = EXCLUDED.is_session_complete,
            source = EXCLUDED.source
        `;
        chunkInserted++;
      }

      totalInserted += chunkInserted;

      if (raw.length > 0) {
        await setCheckpoint(instrumentId, new Date(raw[raw.length - 1].date));
      }

      fetchStart = new Date(chunkEnd.getTime() + 24 * 60 * 60 * 1000);
      attempt = 0;
    } catch (err: any) {
      const message = String(err?.message ?? "");
      const isRateLimit =
        err?.statusCode === 429 ||
        /rate limit|too many requests/i.test(message);
      if (isRateLimit && attempt < maxAttempts) {
        const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        attempt++;
        await delay(backoff);
        continue;
      }
      throw err;
    }
  }

  await updateCoverage(instrumentId);
  return totalInserted;
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
  const pool = new Set<Promise<void>>();

  for (const id of ids) {
    const p: Promise<void> = ingestHourlyCandles(session, id, fromDate, toDate)
      .then((n) => { total += n; })
      .catch((err) => console.error(`[hourly_ingest] ${id} failed:`, err))
      .finally(() => pool.delete(p));
    pool.add(p);
    if (pool.size >= concurrency) await Promise.race(pool);
  }
  await Promise.all(pool);
  return total;
}
