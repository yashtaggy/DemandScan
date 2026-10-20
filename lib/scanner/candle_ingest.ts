import { getDb } from "../db";
import { createKiteClient } from "../kite-client";
import type { KiteSession } from "../types";
import type { Candle } from "./types";

/**
 * Simple async delay helper.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the next chunk end date for a request, respecting Kite's max range.
 * Daily interval allows up to ~30 days per request (conservative).
 */
function computeChunkEnd(start: Date, to: Date, maxDays = 30): Date {
  const max = new Date(start);
  max.setDate(max.getDate() + maxDays);
  return max > to ? to : max;
}

/**
 * Upsert a batch of daily candles into `daily_candles`.
 * Uses PostgreSQL INSERT … ON CONFLICT to avoid duplicates.
 */
async function upsertCandles(candles: Candle[]): Promise<void> {
  if (candles.length === 0) return;
  const sql = getDb();
  const values = candles.map((c) => [
    c.instrumentId,
    c.date,
    c.open,
    c.high,
    c.low,
    c.close,
    c.volume,
    c.source,
  ]);
  // INSERT rows individually — Neon tagged-template driver does not accept
  // a 2D array in the VALUES position; use per-row inserts instead.
  for (const [instrId, date, open, high, low, close, volume, source] of values) {
    await sql`
      INSERT INTO daily_candles (
        instrument_id, candle_date, open, high, low, close, volume, source
      ) VALUES (
        ${instrId as number}, ${date as Date}, ${open as number},
        ${high as number}, ${low as number}, ${close as number},
        ${volume as number}, ${source as string}
      )
      ON CONFLICT (instrument_id, candle_date) DO UPDATE SET
        open   = EXCLUDED.open,
        high   = EXCLUDED.high,
        low    = EXCLUDED.low,
        close  = EXCLUDED.close,
        volume = EXCLUDED.volume,
        source = EXCLUDED.source
    `;
  }
}

/**
 * Retrieve the last successfully ingested candle date for an instrument.
 * Returns null if no checkpoint exists.
 */
async function getCheckpoint(instrumentId: number): Promise<Date | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT last_candle_date FROM ingestion_checkpoints WHERE instrument_id = ${instrumentId}
  `;
  if (rows.length === 0) return null;
  return rows[0].last_candle_date as Date;
}

/**
 * Update the ingestion checkpoint for an instrument.
 */
async function setCheckpoint(instrumentId: number, lastDate: Date): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO ingestion_checkpoints (instrument_id, last_candle_date, updated_at)
    VALUES (${instrumentId}, ${lastDate}, NOW())
    ON CONFLICT (instrument_id) DO UPDATE SET
      last_candle_date = EXCLUDED.last_candle_date,
      updated_at = NOW()
  `;
}

/**
 * Ingest historical daily OHLCV candles for a single instrument.
 *
 * The function is idempotent – it will only fetch missing dates based on the
 * checkpoint stored in `ingestion_checkpoints`. It respects Kite rate limits by
 * retrying with exponential back‑off (max 5 attempts) when a 429 response is
 * encountered.
 *
 * @param session - Authenticated Kite session.
 * @param instrumentId - The numeric instrument token.
 * @param fromDate - Desired start date (inclusive). If earlier than the stored
 *   checkpoint, the checkpoint is used instead.
 * @param toDate - Desired end date (inclusive).
 * @returns number of newly inserted candles.
 */
export async function ingestDailyCandles(
  session: KiteSession,
  instrumentId: number,
  fromDate: Date,
  toDate: Date
): Promise<number> {
  // Ensure proper ordering
  if (fromDate > toDate) throw new Error("fromDate must be <= toDate");

  // Resolve checkpoint – we only need to fetch after the last stored candle.
  const checkpoint = await getCheckpoint(instrumentId);
  let fetchStart = checkpoint ? new Date(Math.max(checkpoint.getTime() + 24 * 60 * 60 * 1000, fromDate.getTime())) : fromDate;

  if (fetchStart > toDate) return 0; // nothing new

  const kc = createKiteClient(session.accessToken);

  let totalInserted = 0;
  let attempt = 0;
  const maxAttempts = 5;

  while (fetchStart <= toDate) {
    const chunkEnd = computeChunkEnd(fetchStart, toDate);
    const fromStr = fetchStart.toISOString().split("T")[0] + " 09:15:00"; // NSE open time (approx)
    const toStr = chunkEnd.toISOString().split("T")[0] + " 15:30:00";

    // Kite historical API expects dates in "YYYY-MM-DD HH:MM:SS" format.
    try {
      // kiteconnect v5 API: getHistoricalData(token, interval, from, to).
      // Returns HistoricalData[] — objects with named fields, not arrays.
      const raw = await kc.getHistoricalData(instrumentId, "day", fromStr, toStr);

      // Transform SDK rows to our Candle shape.
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

      await upsertCandles(candles);
      totalInserted += candles.length;

      // Update checkpoint to the last candle we just stored.
      if (candles.length > 0) {
        const lastDate = candles[candles.length - 1].date;
        await setCheckpoint(instrumentId, lastDate);
      }

      // Move to next chunk.
      fetchStart = new Date(chunkEnd.getTime() + 24 * 60 * 60 * 1000);
      attempt = 0; // reset back‑off after success
    } catch (err: any) {
      // Detect rate‑limit (429) or temporary network errors. The SDK rejects
      // with { error_type, message } (Kite 429s say "Too many requests").
      const message = String(err?.message ?? "");
      const isRateLimit =
        err?.statusCode === 429 ||
        /rate limit|too many requests/i.test(message);
      if (isRateLimit && attempt < maxAttempts) {
        const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500; // jitter
        attempt++;
        await delay(backoff);
        // retry same chunk without advancing fetchStart
        continue;
      }
      // For non‑recoverable errors, re‑throw so the caller can mark job failure.
      throw err;
    }
  }

  return totalInserted;
}
