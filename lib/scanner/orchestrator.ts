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
import { detectPatterns, fetchCandlesForAllTimeframes } from './patterns';
import { persistDetectedZones, type DetectedZoneInput } from './zones';
import { updateZoneLifecycles, buildLatestSnapshots } from './lifecycle';
import { updateScanJob } from './jobs';
import { assertUniversePlayable, listNifty500InstrumentIds } from './universe';
import { getNifty500Count } from '@/lib/nifty500';
import { sanitizeErrorMessage } from './retry';
import { DEFAULT_SCANNER_CONFIG } from './types';
import type { Candle, ScannerConfig, Timeframe } from './types';

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

const SCAN_TIMEFRAMES: Timeframe[] = ['1H', '4H', '1D', '1W', '1M', '3M', '6M', '1Y'];

export type TimeframeDetectionStatus = 'OK' | 'NO_DATA' | 'FAILED';

export interface TimeframeDetectionOutcome {
  timeframe: Timeframe;
  status: TimeframeDetectionStatus;
  candles: number;
  matches: number;
  durationMs: number;
  /** Sanitized failure detail; present only when status is FAILED. */
  errorMessage?: string;
}

export interface InstrumentDetectionResult {
  instrumentId: number;
  outcomes: TimeframeDetectionOutcome[];
  failedTimeframes: Timeframe[];
  durationMs: number;
}

/**
 * Detect patterns and upsert zones for one instrument across all 8 timeframes.
 * Preserves existing detection, scoring, and upsert behaviour.
 *
 * Every timeframe is attempted and reported as OK, NO_DATA, or FAILED. The
 * whole instrument is reported as failed if any timeframe failed, so callers
 * cannot mark a scan SUCCESS while a timeframe was never processed.
 */
export async function detectAndUpsertZonesForInstrument(
  instrumentId: number,
  config: ScannerConfig = DEFAULT_SCANNER_CONFIG
): Promise<InstrumentDetectionResult> {
  const startedAt = Date.now();
  const outcomes: TimeframeDetectionOutcome[] = [];
  const pending: DetectedZoneInput[] = [];

  // One round trip for all timeframes instead of eight. On failure every
  // timeframe is reported FAILED, so the instrument cannot be marked OK.
  let candlesByTimeframe: Map<Timeframe, Candle[]> | null = null;
  let fetchError: string | null = null;
  try {
    candlesByTimeframe = await fetchCandlesForAllTimeframes(
      instrumentId,
      SCAN_TIMEFRAMES
    );
  } catch (err) {
    fetchError = sanitizeErrorMessage(err);
    console.error(
      `[orchestrator] candle fetch failed instrument=${instrumentId} error=${fetchError}`
    );
  }

  for (const tf of SCAN_TIMEFRAMES) {
    const timeframeStartedAt = Date.now();
    if (fetchError) {
      outcomes.push({
        timeframe: tf,
        status: 'FAILED',
        candles: 0,
        matches: 0,
        durationMs: 0,
        errorMessage: fetchError,
      });
      continue;
    }

    try {
      // Detection and zone scoring must use the exact same candle window.
      const candles = candlesByTimeframe?.get(tf) ?? [];
      if (candles.length === 0) {
        outcomes.push({
          timeframe: tf,
          status: 'NO_DATA',
          candles: 0,
          matches: 0,
          durationMs: Date.now() - timeframeStartedAt,
        });
        continue;
      }

      const matches = detectPatterns(candles, instrumentId, tf, config);
      for (const match of matches) {
        pending.push({ match, candles });
      }
      outcomes.push({
        timeframe: tf,
        status: 'OK',
        candles: candles.length,
        matches: matches.length,
        durationMs: Date.now() - timeframeStartedAt,
      });
    } catch (err) {
      const errorMessage = sanitizeErrorMessage(err);
      outcomes.push({
        timeframe: tf,
        status: 'FAILED',
        candles: 0,
        matches: 0,
        durationMs: Date.now() - timeframeStartedAt,
        errorMessage,
      });
      console.error(
        `[orchestrator] detection failed instrument=${instrumentId} timeframe=${tf} error=${errorMessage}`
      );
    }
  }

  // Persist every successfully detected zone in one batch (idempotent).
  let persistError: string | null = null;
  if (pending.length > 0) {
    try {
      const { inserted, skipped } = await persistDetectedZones(
        pending,
        config,
        config.version
      );
      console.info(
        `[orchestrator] zones instrument=${instrumentId} detected=${pending.length} ` +
          `inserted=${inserted} existing=${skipped}`
      );
    } catch (err) {
      persistError = sanitizeErrorMessage(err);
      console.error(
        `[orchestrator] zone persistence failed instrument=${instrumentId} error=${persistError}`
      );
    }
  }

  const failedTimeframes = outcomes
    .filter((o) => o.status === 'FAILED')
    .map((o) => o.timeframe);
  const result: InstrumentDetectionResult = {
    instrumentId,
    outcomes,
    failedTimeframes,
    durationMs: Date.now() - startedAt,
  };

  // Explicit per-instrument summary. Sanitized: no candle values or secrets.
  console.info(
    `[orchestrator] detect instrument=${instrumentId} ` +
      `timeframes=${outcomes.map((o) => `${o.timeframe}:${o.status}`).join(',')} ` +
      `matches=${outcomes.reduce((sum, o) => sum + o.matches, 0)} ` +
      `failed=${failedTimeframes.length} durationMs=${result.durationMs}`
  );

  if (failedTimeframes.length > 0 || persistError) {
    const details = outcomes
      .filter((o) => o.status === 'FAILED')
      .map((o) => `${o.timeframe}=${o.errorMessage}`)
      .join('; ');
    const persistDetail = persistError ? `persist=${persistError}` : '';
    throw new Error(
      `Pattern detection failed for instrument ${instrumentId} on ${failedTimeframes.join(', ')}` +
        `${details ? `: ${details}` : ''}${persistDetail ? `; ${persistDetail}` : ''}`
    );
  }

  return result;
}

/**
 * In-process full pipeline. Not used by serverless API routes — those run
 * bounded batches via `processScanBatch`. Kept for local/long-running callers.
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
    let ids: number[];
    if (limitToIds && limitToIds.length > 0) {
      const instrumentRows = await sql`
        SELECT instrument_id FROM instruments
        WHERE active = true AND instrument_id = ANY(${limitToIds}::bigint[])
        ORDER BY instrument_id
      `;
      ids = instrumentRows.map((r: any) => Number(r.instrument_id));
    } else {
      // A full scan is membership-only. Never use every active instrument.
      ids = await listNifty500InstrumentIds();
      assertUniversePlayable(ids.length, getNifty500Count());
    }
    const total = ids.length;
    let processed = 0;

    for (const id of ids) {
      await detectAndUpsertZonesForInstrument(id, config);

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
    const message = sanitizeErrorMessage(err);
    console.error(`[orchestrator] full scan failed: jobId=${jobId} error=${message}`);
    await updateScanJob(jobId, {
      status: 'FAILED',
      errorMessage: message,
      completedAt: new Date(),
    });
  }
}
