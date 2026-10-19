/**
 * lib/scanner/backfill.ts
 *
 * Historical backfill and replay engine — DemandScan v1.
 *
 * DESIGN PRINCIPLES
 * ─────────────────
 * 1. No look-ahead bias: when replaying candle N, only candles 1…N are visible.
 * 2. Idempotent: calling this twice on the same instrument/timeframe is safe.
 * 3. Resumable: stores the last processed candle timestamp so partial runs
 *    can be continued without reprocessing completed work.
 * 4. Same rule version: uses the SAME detectPatterns + upsertZone + updateZoneLifecycles
 *    as the live scanner — no separate implementation.
 * 5. Historical events: zone_events written from replay carry is_historical=TRUE.
 * 6. Broken zones preserved: lifecycle can reach BROKEN and stays there.
 * 7. Separate dates: formation_ts = when zone was first detected in replay;
 *    created_at = when the DB row was written (now).
 *
 * WHAT IS BACKFILLED
 * ──────────────────
 * For a given instrument + timeframe:
 *   1. Walk candles chronologically from from_date to to_date.
 *   2. At each new candle, run detectPatterns on [candle_0 … candle_n].
 *   3. Upsert any new zones (idempotent by base_start/base_end fingerprint).
 *   4. Run updateZoneLifecycles with the current candle as the price snapshot.
 *   5. Record progress in backfill_jobs.
 *
 * HISTORICAL COVERAGE NOTE
 * ─────────────────────────
 * Intraday (1H, 4H) history available from ~2010 on Kite.
 * Daily history available from ~2010.
 * Coverage differs per symbol — check candle_coverage table after ingest.
 * Results are labelled "historical analysis of current Nifty 500 constituents."
 */

import { getDb } from '../db';
import { detectPatterns } from './patterns';
import { upsertZone } from './zones';
import { updateZoneLifecycles } from './lifecycle';
import { DEFAULT_SCANNER_CONFIG } from './types';
import type { ScannerConfig, Candle, Timeframe } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BackfillOptions {
  instrumentId: number;
  timeframe: Timeframe;
  fromDate: Date;
  toDate: Date;
  config?: ScannerConfig;
  /** If true, allows resuming a previous partial run from its checkpoint */
  resume?: boolean;
}

export interface BackfillResult {
  jobId: string;
  candlesProcessed: number;
  zonesFormed: number;
}

// ─── Job helpers ──────────────────────────────────────────────────────────────

async function createBackfillJob(
  instrumentId: number,
  timeframe: Timeframe,
  fromDate: Date,
  toDate: Date
): Promise<string> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO backfill_jobs (instrument_id, timeframe, from_date, to_date, status)
    VALUES (${instrumentId}, ${timeframe}, ${fromDate}, ${toDate}, 'RUNNING')
    RETURNING job_id
  `;
  return rows[0].job_id as string;
}

async function findExistingJob(
  instrumentId: number,
  timeframe: Timeframe,
  fromDate: Date,
  toDate: Date
): Promise<{ jobId: string; lastProcessedTs: Date | null } | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT job_id, last_processed_ts
    FROM backfill_jobs
    WHERE instrument_id = ${instrumentId}
      AND timeframe     = ${timeframe}
      AND from_date     = ${fromDate}::date
      AND to_date       = ${toDate}::date
      AND status IN ('RUNNING', 'PENDING')
    ORDER BY started_at DESC
    LIMIT 1
  `;
  if (!rows.length) return null;
  return {
    jobId: rows[0].job_id as string,
    lastProcessedTs: rows[0].last_processed_ts ? new Date(rows[0].last_processed_ts as string) : null,
  };
}

async function updateBackfillJob(
  jobId: string,
  updates: {
    status?: string;
    lastProcessedTs?: Date;
    candlesProcessed?: number;
    zonesFormed?: number;
    errorMessage?: string;
    completedAt?: Date;
  }
): Promise<void> {
  const sql = getDb();
  if (updates.status !== undefined) {
    await sql`UPDATE backfill_jobs SET status = ${updates.status} WHERE job_id = ${jobId}`;
  }
  if (updates.lastProcessedTs !== undefined) {
    await sql`UPDATE backfill_jobs SET last_processed_ts = ${updates.lastProcessedTs} WHERE job_id = ${jobId}`;
  }
  if (updates.candlesProcessed !== undefined) {
    await sql`UPDATE backfill_jobs SET candles_processed = ${updates.candlesProcessed} WHERE job_id = ${jobId}`;
  }
  if (updates.zonesFormed !== undefined) {
    await sql`UPDATE backfill_jobs SET zones_formed = ${updates.zonesFormed} WHERE job_id = ${jobId}`;
  }
  if (updates.errorMessage !== undefined) {
    await sql`UPDATE backfill_jobs SET error_message = ${updates.errorMessage} WHERE job_id = ${jobId}`;
  }
  if (updates.completedAt !== undefined) {
    await sql`UPDATE backfill_jobs SET completed_at = ${updates.completedAt} WHERE job_id = ${jobId}`;
  }
}

// ─── Candle fetchers ──────────────────────────────────────────────────────────

async function fetchCandlesForTimeframe(
  instrumentId: number,
  timeframe: Timeframe,
  upToTs: Date
): Promise<Candle[]> {
  const sql = getDb();
  let rows: any[];

  if (timeframe === '1H') {
    rows = await sql`
      SELECT instrument_id AS instrument_token, candle_ts AS period_start,
             open, high, low, close, volume
      FROM hourly_candles
      WHERE instrument_id       = ${instrumentId}
        AND is_session_complete = TRUE
        AND candle_ts           <= ${upToTs}
      ORDER BY candle_ts ASC
      LIMIT 2000
    `;
  } else if (timeframe === '4H') {
    rows = await sql`
      SELECT instrument_id AS instrument_token, session_ts AS period_start,
             open, high, low, close, volume
      FROM four_hour_candles
      WHERE instrument_id = ${instrumentId}
        AND is_complete   = TRUE
        AND session_ts    <= ${upToTs}
      ORDER BY session_ts ASC
      LIMIT 2000
    `;
  } else if (timeframe === '1D') {
    rows = await sql`
      SELECT instrument_id AS instrument_token, candle_date AS period_start,
             open, high, low, close, volume
      FROM daily_candles
      WHERE instrument_id = ${instrumentId}
        AND candle_date   <= ${upToTs}::date
      ORDER BY candle_date ASC
      LIMIT 2000
    `;
  } else {
    rows = await sql`
      SELECT instrument_token, period_start, open, high, low, close, volume
      FROM aggregated_candles
      WHERE instrument_token = ${instrumentId}
        AND timeframe        = ${timeframe}
        AND period_start     <= ${upToTs}::date
      ORDER BY period_start ASC
      LIMIT 2000
    `;
  }

  return rows.map((r: any): Candle => ({
    instrumentId: Number(r.instrument_token),
    date: new Date(r.period_start),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    source: 'db',
    isComplete: true,
  }));
}

/** Fetch all candle timestamps for a given instrument+timeframe in ascending order */
async function fetchCandleTimestamps(
  instrumentId: number,
  timeframe: Timeframe,
  fromDate: Date,
  toDate: Date
): Promise<Date[]> {
  const sql = getDb();
  let rows: any[];

  if (timeframe === '1H') {
    rows = await sql`
      SELECT candle_ts AS ts FROM hourly_candles
      WHERE instrument_id = ${instrumentId}
        AND is_session_complete = TRUE
        AND candle_ts BETWEEN ${fromDate} AND ${toDate}
      ORDER BY candle_ts ASC
    `;
  } else if (timeframe === '4H') {
    rows = await sql`
      SELECT session_ts AS ts FROM four_hour_candles
      WHERE instrument_id = ${instrumentId}
        AND is_complete = TRUE
        AND session_ts BETWEEN ${fromDate} AND ${toDate}
      ORDER BY session_ts ASC
    `;
  } else if (timeframe === '1D') {
    rows = await sql`
      SELECT candle_date AS ts FROM daily_candles
      WHERE instrument_id = ${instrumentId}
        AND candle_date BETWEEN ${fromDate}::date AND ${toDate}::date
      ORDER BY candle_date ASC
    `;
  } else {
    rows = await sql`
      SELECT period_start AS ts FROM aggregated_candles
      WHERE instrument_token = ${instrumentId}
        AND timeframe = ${timeframe}
        AND period_start BETWEEN ${fromDate}::date AND ${toDate}::date
      ORDER BY period_start ASC
    `;
  }

  return rows.map((r: any) => new Date(r.ts));
}

// ─── Main replay function ─────────────────────────────────────────────────────

/**
 * Run a historical backfill for one instrument + timeframe.
 *
 * Algorithm:
 *   1. Fetch all candle timestamps in the requested range.
 *   2. Skip timestamps already processed (resume from checkpoint if opts.resume=true).
 *   3. For each timestamp t:
 *      a. Fetch all candles with date <= t (no look-ahead).
 *      b. Run detectPatterns on the full visible history.
 *      c. Upsert any new zones.
 *      d. Build a price snapshot from the current candle.
 *      e. Run updateZoneLifecycles with that snapshot + is_historical=true.
 *      f. Update checkpoint in backfill_jobs every 50 steps.
 */
export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const {
    instrumentId,
    timeframe,
    fromDate,
    toDate,
    config = DEFAULT_SCANNER_CONFIG,
    resume = true,
  } = opts;

  // ── Find or create job ────────────────────────────────────────────────────
  let jobId: string;
  let resumeFrom: Date | null = null;

  if (resume) {
    const existing = await findExistingJob(instrumentId, timeframe, fromDate, toDate);
    if (existing) {
      jobId = existing.jobId;
      resumeFrom = existing.lastProcessedTs;
    } else {
      jobId = await createBackfillJob(instrumentId, timeframe, fromDate, toDate);
    }
  } else {
    jobId = await createBackfillJob(instrumentId, timeframe, fromDate, toDate);
  }

  // ── Fetch all timestamps to replay ───────────────────────────────────────
  const timestamps = await fetchCandleTimestamps(instrumentId, timeframe, fromDate, toDate);

  // Skip already-processed timestamps when resuming
  const startIdx = resumeFrom
    ? timestamps.findIndex((t) => t > resumeFrom!) 
    : 0;

  const toProcess = startIdx >= 0 ? timestamps.slice(startIdx) : [];

  let candlesProcessed = 0;
  let zonesFormed = 0;

  try {
    for (let i = 0; i < toProcess.length; i++) {
      const currentTs = toProcess[i];

      // Fetch all candles visible at this point in time (no look-ahead)
      const visibleCandles = await fetchCandlesForTimeframe(instrumentId, timeframe, currentTs);

      if (visibleCandles.length < config.thresholds.minBaseCandles + 2) {
        candlesProcessed++;
        continue;
      }

      // Detect patterns on visible history
      const matches = detectPatterns(visibleCandles, instrumentId, timeframe, config);

      // Upsert new zones
      for (const match of matches) {
        const zoneId = await upsertZone(match, visibleCandles, config, config.version);
        if (zoneId) zonesFormed++;
      }

      // Build price snapshot from the current candle
      const currentCandle = visibleCandles[visibleCandles.length - 1];
      const snapshot = {
        instrumentId,
        close: currentCandle.close,
        high: currentCandle.high,
        low: currentCandle.low,
        date: currentCandle.date,
      };

      // Update zone lifecycles (mark events as historical)
      await updateZoneLifecycles([snapshot], config, true);

      candlesProcessed++;

      // Save checkpoint every 50 steps
      if (candlesProcessed % 50 === 0) {
        await updateBackfillJob(jobId, {
          lastProcessedTs: currentTs,
          candlesProcessed,
          zonesFormed,
        });
      }
    }

    await updateBackfillJob(jobId, {
      status: 'SUCCESS',
      candlesProcessed,
      zonesFormed,
      completedAt: new Date(),
    });
  } catch (err: any) {
    await updateBackfillJob(jobId, {
      status: 'FAILED',
      errorMessage: err?.message ?? 'Unknown error',
      completedAt: new Date(),
    });
    throw err;
  }

  return { jobId, candlesProcessed, zonesFormed };
}
