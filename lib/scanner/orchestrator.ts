/**
 * lib/scanner/orchestrator.ts
 *
 * Full scan pipeline orchestrator — DemandScan v1
 *
 * Pipeline steps:
 *  1. Sync instrument master from Kite.
 *  2a. Ingest daily candles for all active instruments.
 *  2b. Ingest hourly (1H) candles for all active instruments.
 *  3a. Aggregate daily → weekly/monthly/quarterly/half-yearly/yearly.
 *  3b. Aggregate hourly → 4H (session-aware, AM only).
 *  4. Detect patterns across all 8 timeframes.
 *  5. Upsert zones with formation scores.
 *  6. Update zone lifecycles from latest price data.
 *
 * Progress is tracked in scan_jobs for UI polling.
 */

import type { KiteSession } from '@/lib/types';
import { getDb } from '@/lib/db';
import { syncInstruments } from './instruments';
import { ingestAllInstruments } from './ingest_all';
import { ingestAllHourlyCandles } from './hourly_ingest';
import { aggregate4HForAll } from './four_hour_agg';
import { aggregateAllTimeframes } from './aggregation';
import { detectPatternsForInstrument } from './patterns';
import { upsertZone } from './zones';
import { updateZoneLifecycles, buildLatestSnapshots } from './lifecycle';
import { updateScanJob } from './jobs';
import { DEFAULT_SCANNER_CONFIG } from './types';
import type { ScannerConfig, Timeframe, Candle } from './types';

/** All 8 supported timeframes in scan order */
const SCAN_TIMEFRAMES: Timeframe[] = ['1H', '4H', '1D', '1W', '1M', '3M', '6M', '1Y'];

export interface OrchestratorOptions {
  jobId: string;
  session: KiteSession;
  fromDate: Date;
  toDate: Date;
  config?: ScannerConfig;
  concurrency?: number;
  /** If provided, only scan these instrument IDs (for test runs). */
  instrumentIds?: number[];
}

/**
 * Run the full scan pipeline.
 * Fire-and-forget from the API route; progress reflected in scan_jobs table.
 */
export async function runFullScan(opts: OrchestratorOptions): Promise<void> {
  const {
    jobId,
    session,
    fromDate,
    toDate,
    config = DEFAULT_SCANNER_CONFIG,
    concurrency = 5,
    instrumentIds: limitToIds,
  } = opts;

  const sql = getDb();

  try {
    // ── Step 1: Instrument sync ───────────────────────────────────────────────
    await updateScanJob(jobId, { status: 'RUNNING', progressPercent: 2 });
    await syncInstruments(session);
    await updateScanJob(jobId, { progressPercent: 5 });

    // ── Step 2a: Daily candle ingestion ───────────────────────────────────────
    await ingestAllInstruments(session, fromDate, toDate, concurrency);
    await updateScanJob(jobId, { progressPercent: 20 });

    // ── Step 2b: Hourly (1H) candle ingestion ─────────────────────────────────
    await ingestAllHourlyCandles(session, fromDate, toDate, Math.min(concurrency, 3));
    await updateScanJob(jobId, { progressPercent: 38 });

    // ── Step 3a: Daily → weekly/monthly/... aggregation ───────────────────────
    await aggregateAllTimeframes();
    await updateScanJob(jobId, { progressPercent: 48 });

    // ── Step 3b: Hourly → 4H aggregation (session-aware) ─────────────────────
    await aggregate4HForAll();
    await updateScanJob(jobId, { progressPercent: 55 });

    // ── Step 4 & 5: Pattern detection + zone upsert ───────────────────────────
    let instrumentRows;
    if (limitToIds && limitToIds.length > 0) {
      instrumentRows = await sql`
        SELECT instrument_id FROM instruments
        WHERE active = true AND instrument_id = ANY(${limitToIds}::bigint[])
        ORDER BY instrument_id
      `;
    } else {
      instrumentRows = await sql`
        SELECT instrument_id FROM instruments WHERE active = true ORDER BY instrument_id
      `;
    }

    const ids: number[] = instrumentRows.map((r: any) => Number(r.instrument_id));
    const total = ids.length;
    let processed = 0;

    for (const id of ids) {
      for (const tf of SCAN_TIMEFRAMES) {
        try {
          const matches = await detectPatternsForInstrument(id, tf, config);
          const candles = await fetchCandlesForZoneScoring(id, tf, sql);
          for (const match of matches) {
            await upsertZone(match, candles, config, config.version);
          }
        } catch (err) {
          console.error(`[orchestrator] pattern detection failed for ${id}/${tf}:`, err);
        }
      }

      processed++;
      // Progress spans 55 → 90 during pattern detection
      const progress = 55 + Math.round((processed / total) * 35);
      if (processed % 10 === 0) {
        await updateScanJob(jobId, { progressPercent: progress });
      }
    }
    await updateScanJob(jobId, { progressPercent: 90 });

    // ── Step 6: Lifecycle update ──────────────────────────────────────────────
    const snapshots = await buildLatestSnapshots();
    await updateZoneLifecycles(snapshots, config);
    await updateScanJob(jobId, {
      status: 'SUCCESS',
      progressPercent: 100,
      completedAt: new Date(),
    });
  } catch (err: any) {
    console.error('[orchestrator] full scan failed:', err);
    await updateScanJob(jobId, {
      status: 'FAILED',
      errorMessage: err?.message ?? 'Unknown error',
      completedAt: new Date(),
    });
  }
}

// ─── Internal candle fetch helper ─────────────────────────────────────────────

/** Fetch candles for zone scoring — all 8 timeframes. */
async function fetchCandlesForZoneScoring(
  instrumentId: number,
  timeframe: Timeframe,
  sql: ReturnType<typeof getDb>
): Promise<Candle[]> {
  let rows: any[];

  if (timeframe === '1H') {
    rows = await sql`
      SELECT instrument_id AS instrument_token,
             candle_ts     AS period_start,
             open, high, low, close, volume
      FROM hourly_candles
      WHERE instrument_id       = ${instrumentId}
        AND is_session_complete = TRUE
      ORDER BY candle_ts ASC LIMIT 500
    `;
  } else if (timeframe === '4H') {
    rows = await sql`
      SELECT instrument_id AS instrument_token,
             session_ts    AS period_start,
             open, high, low, close, volume
      FROM four_hour_candles
      WHERE instrument_id = ${instrumentId}
        AND is_complete   = TRUE
      ORDER BY session_ts ASC LIMIT 500
    `;
  } else if (timeframe === '1D') {
    rows = await sql`
      SELECT instrument_id AS instrument_token,
             candle_date   AS period_start,
             open, high, low, close, volume
      FROM daily_candles
      WHERE instrument_id = ${instrumentId}
      ORDER BY candle_date ASC LIMIT 500
    `;
  } else {
    rows = await sql`
      SELECT instrument_token, period_start,
             open, high, low, close, volume
      FROM aggregated_candles
      WHERE instrument_token = ${instrumentId}
        AND timeframe        = ${timeframe}
      ORDER BY period_start ASC LIMIT 500
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
