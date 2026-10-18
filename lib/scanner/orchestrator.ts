/**
 * lib/scanner/orchestrator.ts
 *
 * Full scan pipeline orchestrator.
 *
 * Pipeline steps (in order):
 *  1. Sync instrument master from Kite.
 *  2. Ingest daily candles for each active instrument.
 *  3. Aggregate candles into higher timeframes.
 *  4. Detect patterns (DBR/RBR/RBD/DBD) across all timeframes.
 *  5. Create/score zones and persist to DB.
 *  6. Update zone lifecycles from latest price data.
 *
 * The orchestrator updates a `scan_jobs` record throughout for progress tracking.
 */

import type { KiteSession } from '@/lib/types';
import { getDb } from '@/lib/db';
import { syncInstruments } from './instruments';
import { ingestAllInstruments } from './ingest_all';
import { aggregateAllTimeframes } from './aggregation';
import { detectPatternsForInstrument } from './patterns';
import { upsertZone } from './zones';
import { updateZoneLifecycles, buildLatestSnapshots } from './lifecycle';
import { updateScanJob } from './jobs';
import { DEFAULT_SCANNER_CONFIG } from './types';
import type { ScannerConfig, Timeframe } from './types';

const SCAN_TIMEFRAMES: Timeframe[] = ['1D', '1W', '1M', '3M', '6M', '1Y'];

export interface OrchestratorOptions {
  jobId: string;
  session: KiteSession;
  fromDate: Date;
  toDate: Date;
  config?: ScannerConfig;
  concurrency?: number;
}

/**
 * Run the full scan pipeline.
 * Designed to be called fire-and-forget from an API route; job progress is
 * reflected in the `scan_jobs` table.
 */
export async function runFullScan(opts: OrchestratorOptions): Promise<void> {
  const {
    jobId,
    session,
    fromDate,
    toDate,
    config = DEFAULT_SCANNER_CONFIG,
    concurrency = 5,
  } = opts;

  const sql = getDb();

  try {
    // ── Step 1: Instrument sync ─────────────────────────────────────────────
    await updateScanJob(jobId, { status: 'RUNNING', progressPercent: 2 });
    await syncInstruments(session);
    await updateScanJob(jobId, { progressPercent: 5 });

    // ── Step 2: Candle ingestion ────────────────────────────────────────────
    await ingestAllInstruments(session, fromDate, toDate, concurrency);
    await updateScanJob(jobId, { progressPercent: 40 });

    // ── Step 3: Aggregation ─────────────────────────────────────────────────
    await aggregateAllTimeframes();
    await updateScanJob(jobId, { progressPercent: 55 });

    // ── Step 4 & 5: Pattern detection + zone upsert ─────────────────────────
    const instrumentRows = await sql`
      SELECT instrument_id FROM instruments WHERE active = true ORDER BY instrument_id
    `;
    const instrumentIds: number[] = instrumentRows.map((r: any) => Number(r.instrument_id));
    const total = instrumentIds.length;
    let processed = 0;

    for (const id of instrumentIds) {
      for (const tf of SCAN_TIMEFRAMES) {
        try {
          const matches = await detectPatternsForInstrument(id, tf, config);
          // We need the candles to score zones – fetch them.
          const candles = await fetchCandlesForZoneScoring(id, tf, sql);
          for (const match of matches) {
            await upsertZone(match, candles, config, config.version);
          }
        } catch (err) {
          console.error(`[orchestrator] pattern detection failed for ${id}/${tf}:`, err);
        }
      }

      processed++;
      // Progress spans 55→90 during pattern detection.
      const progress = 55 + Math.round((processed / total) * 35);
      if (processed % 10 === 0) {
        await updateScanJob(jobId, { progressPercent: progress });
      }
    }
    await updateScanJob(jobId, { progressPercent: 90 });

    // ── Step 6: Lifecycle update ────────────────────────────────────────────
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

// ─── Internal helper ─────────────────────────────────────────────────────────

/** Fetch candles needed for zone scoring (same source the pattern detector uses). */
async function fetchCandlesForZoneScoring(
  instrumentId: number,
  timeframe: Timeframe,
  sql: ReturnType<typeof getDb>
): Promise<import('./types').Candle[]> {
  let rows: any[];
  if (timeframe === '1D') {
    rows = await sql`
      SELECT instrument_id AS instrument_token,
             candle_date   AS period_start,
             open, high, low, close, volume
      FROM daily_candles
      WHERE instrument_id = ${instrumentId}
      ORDER BY candle_date ASC
      LIMIT 500
    `;
  } else {
    rows = await sql`
      SELECT instrument_token, period_start,
             open, high, low, close, volume
      FROM aggregated_candles
      WHERE instrument_token = ${instrumentId}
        AND timeframe = ${timeframe}
      ORDER BY period_start ASC
      LIMIT 500
    `;
  }
  return rows.map((r: any) => ({
    instrumentId: Number(r.instrument_token),
    date: new Date(r.period_start),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    source: 'db',
  }));
}
