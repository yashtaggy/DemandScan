/**
 * lib/scanner/batchRunner.ts
 *
 * Bounded, resumable scan worker for Vercel serverless.
 * Each invocation claims one job lease, processes one stage slice, then
 * persists the checkpoint. Work functions are the existing ingest/aggregate/
 * detect/upsert/lifecycle implementations.
 */

import { randomUUID } from 'crypto';
import type { KiteSession } from '@/lib/types';
import { DEFAULT_SCANNER_CONFIG } from './types';
import type { ScanJobRow, ScanJobStatus, ScanStage } from './jobs';
import {
  claimScanJob,
  completeScanBatch,
  failScanBatch,
  getScanJob,
  insertScanBatch,
  mapScanJobRow,
  persistScanJobCheckpoint,
} from './jobs';
import {
  listActiveInstrumentIds,
  resolveInstrumentIdsBySymbol,
  syncInstrumentMaster,
} from './instruments';
import {
  assertUniversePlayable,
  listNifty500InstrumentIds,
} from './universe';
import { getNifty500Count } from '@/lib/nifty500';
import { backoffMs, isPermanentError, sanitizeErrorMessage } from './retry';
import { ingestDailyCandles } from './candle_ingest';
import { ingestHourlyCandles } from './hourly_ingest';
import { aggregateInstrument } from './aggregation';
import { aggregate4HForInstrument } from './four_hour_agg';
import { detectAndUpsertZonesForInstrument } from './orchestrator';
import { buildLatestSnapshots, updateZoneLifecycles } from './lifecycle';
import { getSessionByIdHash } from '@/lib/kite-session';

export const SCAN_STAGE_ORDER: ScanStage[] = [
  'SYNC_INSTRUMENTS',
  'INGEST_DAILY',
  'INGEST_HOURLY',
  'AGGREGATE_DAILY',
  'AGGREGATE_4H',
  'DETECT_ZONES',
  'LIFECYCLE',
];

/**
 * Sequential work per 60s serverless invocation. Sizes are sized from the
 * persisted batch timings of the last successful full scan: the worst measured
 * batch was 3.8s for DETECT_ZONES (3 instruments), 2.7s for INGEST_HOURLY and
 * 2.1s for INGEST_DAILY, leaving >4x headroom at the new sizes. LIFECYCLE
 * stays at 40 because its worst batch measured ~35s.
 */
export const STAGE_BATCH_SIZES: Record<ScanStage, number> = {
  // SYNC_INSTRUMENTS is one master download per batch (not sliced).
  SYNC_INSTRUMENTS: 1,
  INGEST_DAILY: 6,
  INGEST_HOURLY: 2,
  AGGREGATE_DAILY: 24,
  AGGREGATE_4H: 16,
  DETECT_ZONES: 10,
  LIFECYCLE: 40,
};

const STAGE_PROGRESS: Record<ScanStage, { start: number; end: number }> = {
  SYNC_INSTRUMENTS: { start: 0, end: 5 },
  INGEST_DAILY: { start: 5, end: 20 },
  INGEST_HOURLY: { start: 20, end: 38 },
  AGGREGATE_DAILY: { start: 38, end: 48 },
  AGGREGATE_4H: { start: 48, end: 55 },
  DETECT_ZONES: { start: 55, end: 90 },
  LIFECYCLE: { start: 90, end: 99 },
};

export interface ScanBatchResult {
  claimed: boolean;
  jobId: string | null;
  status: ScanJobStatus | null;
  stage: ScanStage | null;
  progressPercent: number;
  moreRemaining: boolean;
  errorMessage: string | null;
  processedInBatch: number;
  /** Wall-clock time spent executing this batch (server-side). */
  durationMs: number;
  /** Suggested delay before the browser worker retries a transient failure. */
  retryAfterMs: number | null;
  /** Job row as persisted by this batch, so callers need not re-read it. */
  job: ScanJobRow | null;
}

export interface ScanWorkers {
  syncMaster: typeof syncInstrumentMaster;
  listActiveIds: typeof listActiveInstrumentIds;
  resolveNifty500: typeof listNifty500InstrumentIds;
  resolveSymbols: typeof resolveInstrumentIdsBySymbol;
  ingestDaily: typeof ingestDailyCandles;
  ingestHourly: typeof ingestHourlyCandles;
  aggregateDaily: typeof aggregateInstrument;
  aggregate4H: typeof aggregate4HForInstrument;
  detectZones: typeof detectAndUpsertZonesForInstrument;
  snapshots: typeof buildLatestSnapshots;
  lifecycles: typeof updateZoneLifecycles;
  loadSession: typeof getSessionByIdHash;
}

export interface ScanJobStore {
  claim: typeof claimScanJob;
  insertBatch: typeof insertScanBatch;
  completeBatch: typeof completeScanBatch;
  failBatch: typeof failScanBatch;
  persist: typeof persistScanJobCheckpoint;
  getJob: typeof getScanJob;
}

const defaultWorkers: ScanWorkers = {
  syncMaster: syncInstrumentMaster,
  listActiveIds: listActiveInstrumentIds,
  resolveNifty500: listNifty500InstrumentIds,
  resolveSymbols: resolveInstrumentIdsBySymbol,
  ingestDaily: ingestDailyCandles,
  ingestHourly: ingestHourlyCandles,
  aggregateDaily: aggregateInstrument,
  aggregate4H: aggregate4HForInstrument,
  detectZones: detectAndUpsertZonesForInstrument,
  snapshots: buildLatestSnapshots,
  lifecycles: updateZoneLifecycles,
  loadSession: getSessionByIdHash,
};

const defaultStore: ScanJobStore = {
  claim: claimScanJob,
  insertBatch: insertScanBatch,
  completeBatch: completeScanBatch,
  failBatch: failScanBatch,
  persist: persistScanJobCheckpoint,
  getJob: getScanJob,
};

export function selectNextInstrumentBatch(
  ids: number[],
  cursorInstrumentId: number,
  batchSize: number
): { batch: number[]; nextCursor: number; done: boolean } {
  const remaining = ids.filter((id) => id > cursorInstrumentId);
  const batch = remaining.slice(0, batchSize);
  const nextCursor = batch.length > 0 ? batch[batch.length - 1] : cursorInstrumentId;
  return {
    batch,
    nextCursor,
    done: remaining.length <= batchSize,
  };
}

export function progressForStage(
  stage: ScanStage,
  processed: number,
  total: number
): number {
  const band = STAGE_PROGRESS[stage];
  if (total <= 0) return band.start;
  const ratio = Math.min(1, Math.max(0, processed / total));
  return band.start + Math.round((band.end - band.start) * ratio);
}

export function nextStage(stage: ScanStage): ScanStage | null {
  const idx = SCAN_STAGE_ORDER.indexOf(stage);
  if (idx < 0 || idx >= SCAN_STAGE_ORDER.length - 1) return null;
  return SCAN_STAGE_ORDER[idx + 1];
}

function asDate(value: Date | string | null | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function isRunnableStatus(status: ScanJobStatus): boolean {
  return status === 'PENDING' || status === 'RUNNING';
}

/**
 * A legitimate Nifty 500 scan cannot exceed a few hundred instruments. Any
 * full-scan job carrying more than this was produced by the older
 * all-instruments resolution and must be re-resolved.
 */
const MAX_FULL_SCAN_UNIVERSE = 1000;

function isLegacyFullScanUniverse(job: ScanJobRow): boolean {
  if (job.requested_symbols && job.requested_symbols.length > 0) return false;
  const ids = job.instrument_ids;
  return !!ids && ids.length > MAX_FULL_SCAN_UNIVERSE;
}

async function unclaimedResult(
  jobId: string | undefined,
  sessionIdHash: string | null,
  store: ScanJobStore
): Promise<ScanBatchResult> {
  const empty: ScanBatchResult = {
    claimed: false,
    jobId: jobId ?? null,
    status: null,
    stage: null,
    progressPercent: 0,
    moreRemaining: false,
    errorMessage: null,
    processedInBatch: 0,
    durationMs: 0,
    retryAfterMs: null,
    job: null,
  };

  if (!jobId) return empty;

  const raw = await store.getJob(jobId);
  if (!raw) return empty;
  const job = mapScanJobRow(raw);
  if (sessionIdHash && job.session_id_hash && job.session_id_hash !== sessionIdHash) {
    return empty;
  }

  return {
    ...empty,
    jobId: job.job_id,
    status: job.status,
    stage: job.current_stage,
    progressPercent: job.progress_percent,
    moreRemaining: isRunnableStatus(job.status),
    errorMessage: job.error_message,
    job,
  };
}

export async function processScanBatch(
  opts: {
    jobId?: string;
    sessionIdHash?: string | null;
    session?: KiteSession | null;
    leaseOwner?: string;
  },
  store: ScanJobStore = defaultStore,
  workers: ScanWorkers = defaultWorkers
): Promise<ScanBatchResult> {
  const leaseOwner = opts.leaseOwner ?? randomUUID();
  let claimed = await store.claim({
    jobId: opts.jobId,
    sessionIdHash: opts.sessionIdHash,
    leaseOwner,
  });

  if (!claimed) {
    return unclaimedResult(opts.jobId, opts.sessionIdHash ?? null, store);
  }

  // Jobs persisted by the pre-V1 code resolved a full scan to every active
  // NSE instrument (~10k). Re-resolve the intended Nifty 500 universe instead
  // of silently continuing with thousands of instruments.
  if (isLegacyFullScanUniverse(claimed)) {
    console.warn(
      `[scanner] job ${claimed.job_id} has ${claimed.instrument_ids!.length} instruments ` +
        'for a full scan; re-resolving the Nifty 500 universe before continuing'
    );
    claimed = {
      ...claimed,
      current_stage: 'SYNC_INSTRUMENTS',
      cursor_instrument_id: 0,
      processed_instruments: 0,
      total_instruments: 0,
      progress_percent: 0,
      instrument_ids: null,
    };
  }

  const empty: ScanBatchResult = {
    claimed: true,
    jobId: claimed.job_id,
    status: claimed.status,
    stage: claimed.current_stage,
    progressPercent: claimed.progress_percent,
    moreRemaining: claimed.status === 'PENDING' || claimed.status === 'RUNNING',
    errorMessage: claimed.error_message,
    processedInBatch: 0,
    durationMs: 0,
    retryAfterMs: null,
    job: claimed,
  };

  const batchStartedAt = Date.now();
  const batchId = await store.insertBatch({
    jobId: claimed.job_id,
    stage: claimed.current_stage,
    cursorStart: claimed.cursor_instrument_id,
    cursorEnd: claimed.cursor_instrument_id,
    instrumentIds: [],
    attempt: claimed.retry_count + 1,
    leaseOwner,
  });

  try {
    const result = await executeClaimedBatch(claimed, opts.session ?? null, workers);
    const durationMs = Date.now() - batchStartedAt;

    await store.completeBatch(batchId);
    const persisted = await store.persist({
      jobId: claimed.job_id,
      status: result.status,
      stage: result.stage,
      cursorInstrumentId: result.cursorInstrumentId,
      processedInstruments: result.processedInstruments,
      totalInstruments: result.totalInstruments,
      progressPercent: result.progressPercent,
      retryCount: 0,
      instrumentIds: result.instrumentIds,
      errorMessage: result.errorMessage,
      completedAt: result.status === 'SUCCESS' || result.status === 'FAILED' ? new Date() : null,
    });

    console.info(
      `[scanner] batch complete: jobId=${claimed.job_id} batchId=${batchId} ` +
        `stage=${claimed.current_stage} status=${result.status} ` +
        `processed=${result.processedInBatch} total=${result.totalInstruments} durationMs=${durationMs}`
    );

    return {
      claimed: true,
      jobId: claimed.job_id,
      status: result.status,
      stage: result.stage,
      progressPercent: result.progressPercent,
      moreRemaining: result.status === 'RUNNING' || result.status === 'PENDING',
      errorMessage: result.errorMessage,
      processedInBatch: result.processedInBatch,
      durationMs,
      retryAfterMs: null,
      job: persisted ?? claimed,
    };
  } catch (err: any) {
    const message = sanitizeErrorMessage(err);
    const durationMs = Date.now() - batchStartedAt;
    await store.failBatch(batchId, message);
    const retries = claimed.retry_count + 1;
    const permanent = isPermanentError(err);
    const exhausted = permanent || retries >= claimed.max_retries;
    const reason = permanent
      ? ' (permanent error; job FAILED without retry)'
      : exhausted
        ? ' (retry budget exhausted; job FAILED)'
        : '';
    console.error(
      `[scanner] batch failed: jobId=${claimed.job_id} batchId=${batchId} ` +
        `stage=${claimed.current_stage} attempt=${retries}/${claimed.max_retries}` +
        ` durationMs=${durationMs}${reason} error=${message}`
    );
    const persisted = await store.persist({
      jobId: claimed.job_id,
      status: exhausted ? 'FAILED' : 'RUNNING',
      stage: claimed.current_stage,
      cursorInstrumentId: claimed.cursor_instrument_id,
      processedInstruments: claimed.processed_instruments,
      totalInstruments: claimed.total_instruments,
      progressPercent: claimed.progress_percent,
      retryCount: retries,
      instrumentIds: claimed.instrument_ids,
      errorMessage: message,
      completedAt: exhausted ? new Date() : null,
    });

    return {
      ...empty,
      status: exhausted ? 'FAILED' : 'RUNNING',
      moreRemaining: !exhausted,
      errorMessage: message,
      durationMs,
      retryAfterMs: exhausted ? null : backoffMs(retries),
      job: persisted ?? claimed,
    };
  }
}

interface InternalAdvance {
  status: ScanJobStatus;
  stage: ScanStage;
  cursorInstrumentId: number;
  processedInstruments: number;
  totalInstruments: number;
  progressPercent: number;
  instrumentIds: number[] | null;
  errorMessage: string | null;
  processedInBatch: number;
}

async function executeClaimedBatch(
  job: ScanJobRow,
  providedSession: KiteSession | null,
  workers: ScanWorkers
): Promise<InternalAdvance> {
  const session =
    providedSession ??
    (job.session_id_hash ? await workers.loadSession(job.session_id_hash) : null);

  const needsSession =
    job.current_stage === 'SYNC_INSTRUMENTS' ||
    job.current_stage === 'INGEST_DAILY' ||
    job.current_stage === 'INGEST_HOURLY';

  if (needsSession && !session) {
    throw new Error('Kite session expired or missing; reconnect Zerodha and resume the scan.');
  }

  const now = new Date();
  const fromDate = asDate(job.from_date, new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()));
  const toDate = asDate(job.to_date, now);

  if (job.current_stage === 'SYNC_INSTRUMENTS') {
    return runSyncStage(job, session!, workers);
  }

  const ids = await ensureInstrumentUniverse(job, workers);
  if (ids.length === 0) {
    throw new Error('No instruments available to scan. Sync the instrument master or pass a valid symbol.');
  }

  if (job.current_stage === 'LIFECYCLE') {
    return runLifecycleStage(job, ids, workers);
  }

  const batchSize = STAGE_BATCH_SIZES[job.current_stage];
  const { batch, nextCursor, done } = selectNextInstrumentBatch(
    ids,
    job.cursor_instrument_id,
    batchSize
  );

  const stageStartedAt = Date.now();
  for (const id of batch) {
    switch (job.current_stage) {
      case 'INGEST_DAILY':
        await workers.ingestDaily(session!, id, fromDate, toDate);
        break;
      case 'INGEST_HOURLY':
        await workers.ingestHourly(session!, id, fromDate, toDate);
        break;
      case 'AGGREGATE_DAILY':
        await workers.aggregateDaily(id);
        break;
      case 'AGGREGATE_4H':
        await workers.aggregate4H(id);
        break;
      case 'DETECT_ZONES':
        await workers.detectZones(id, DEFAULT_SCANNER_CONFIG);
        break;
      default:
        break;
    }
  }
  console.info(
    `[scanner] stage=${job.current_stage} instruments=${batch.length} ` +
      `cursor=${job.cursor_instrument_id}->${nextCursor} durationMs=${Date.now() - stageStartedAt}`
  );

  return advanceAfterInstrumentBatch(job, ids, nextCursor, done, batch.length);
}

async function tryResolveUniverseWithoutSync(
  job: ScanJobRow,
  workers: ScanWorkers
): Promise<number[] | null> {
  if (job.instrument_ids && job.instrument_ids.length > 0) {
    const ids = await workers.listActiveIds(job.instrument_ids);
    return ids.length === job.instrument_ids.length ? ids : null;
  }
  if (job.requested_symbols && job.requested_symbols.length > 0) {
    const resolved = await workers.resolveSymbols(job.requested_symbols);
    return resolved.length === job.requested_symbols.length ? resolved : null;
  }
  return null;
}

function advanceToIngest(ids: number[], processedInBatch: number): InternalAdvance {
  return {
    status: 'RUNNING',
    stage: 'INGEST_DAILY',
    cursorInstrumentId: 0,
    processedInstruments: 0,
    totalInstruments: ids.length,
    progressPercent: 5,
    instrumentIds: ids,
    errorMessage: null,
    processedInBatch,
  };
}

async function runSyncStage(
  job: ScanJobRow,
  session: KiteSession,
  workers: ScanWorkers
): Promise<InternalAdvance> {
  const alreadyResolved = await tryResolveUniverseWithoutSync(job, workers);
  if (alreadyResolved) {
    return advanceToIngest(alreadyResolved, 0);
  }

  const isFullScan =
    !(job.instrument_ids && job.instrument_ids.length > 0) &&
    !(job.requested_symbols && job.requested_symbols.length > 0);

  // Warm path: a previous sync seeded membership. Reuse it instead of
  // re-downloading the ~10k-row Kite instrument master on every scan. A
  // partial membership is NEVER reused: fall through to a full sync/reseed so
  // an outdated or truncated universe repairs itself instead of hard-failing.
  if (isFullScan) {
    const expected = getNifty500Count();
    const existing = await workers.resolveNifty500();
    if (expected > 0 && existing.length >= expected) {
      assertUniversePlayable(existing.length, expected);
      console.info(
        `[scanner] full scan universe: reusing ${existing.length} Nifty 500 instruments from membership`
      );
      return advanceToIngest(existing, 0);
    }
    if (existing.length > 0) {
      console.warn(
        `[scanner] full scan universe: membership has only ${existing.length}/${expected} instruments; ` +
          're-syncing the instrument master and reseeding membership before scanning'
      );
    }
  }

  const sync = await workers.syncMaster(session);
  const ids = await resolveUniverseAfterSync(job, workers);

  return advanceToIngest(ids, sync.upserted);
}

async function resolveUniverseAfterSync(
  job: ScanJobRow,
  workers: ScanWorkers
): Promise<number[]> {
  if (job.instrument_ids && job.instrument_ids.length > 0) {
    return workers.listActiveIds(job.instrument_ids);
  }
  if (job.requested_symbols && job.requested_symbols.length > 0) {
    const resolved = await workers.resolveSymbols(job.requested_symbols);
    if (resolved.length === 0) {
      throw new Error(
        `None of the requested symbols were found after instrument sync: ${job.requested_symbols.join(', ')}`
      );
    }
    if (resolved.length < job.requested_symbols.length) {
      throw new Error(
        `Some requested symbols were not found after instrument sync (${resolved.length}/${job.requested_symbols.length}). Scan was not marked complete.`
      );
    }
    return resolved;
  }

  // Full scan: ONLY the persisted Nifty 500 membership. Never fall back to
  // every active NSE instrument.
  const ids = await workers.resolveNifty500();
  assertUniversePlayable(ids.length, getNifty500Count());
  console.info(`[scanner] full scan universe: resolved ${ids.length} Nifty 500 instruments`);
  return ids;
}

async function ensureInstrumentUniverse(
  job: ScanJobRow,
  workers: ScanWorkers
): Promise<number[]> {
  if (job.instrument_ids && job.instrument_ids.length > 0) return job.instrument_ids;
  return resolveUniverseAfterSync(job, workers);
}

async function runLifecycleStage(
  job: ScanJobRow,
  ids: number[],
  workers: ScanWorkers
): Promise<InternalAdvance> {
  const { batch, nextCursor, done } = selectNextInstrumentBatch(
    ids,
    job.cursor_instrument_id,
    STAGE_BATCH_SIZES.LIFECYCLE
  );
  const startedAt = Date.now();
  const snapshots = await workers.snapshots(batch);
  await workers.lifecycles(snapshots, DEFAULT_SCANNER_CONFIG);

  // NO_DATA is a valid outcome (no daily candles yet), but it must be explicit
  // so a lifecycle stage never looks complete when nothing was evaluated.
  const snapshotIds = new Set(snapshots.map((s) => s.instrumentId));
  const missing = batch.filter((id) => !snapshotIds.has(id));
  if (missing.length > 0) {
    console.warn(
      `[scanner] lifecycle: ${missing.length}/${batch.length} instruments had no daily candles; ` +
        `no lifecycle update for ids=${missing.slice(0, 20).join(',')}${missing.length > 20 ? ',...' : ''}`
    );
  }
  const processed = done ? ids.length : ids.filter((id) => id <= nextCursor).length;
  console.info(
    `[scanner] stage=LIFECYCLE instruments=${batch.length} snapshots=${snapshots.length} ` +
      `noData=${missing.length} processed=${processed}/${ids.length} durationMs=${Date.now() - startedAt}`
  );

  if (!done) {
    return {
      status: 'RUNNING',
      stage: 'LIFECYCLE',
      cursorInstrumentId: nextCursor,
      processedInstruments: processed,
      totalInstruments: ids.length,
      progressPercent: progressForStage('LIFECYCLE', processed, ids.length),
      instrumentIds: ids,
      errorMessage: null,
      processedInBatch: batch.length,
    };
  }

  return {
    status: 'SUCCESS',
    stage: 'LIFECYCLE',
    cursorInstrumentId: nextCursor,
    processedInstruments: ids.length,
    totalInstruments: ids.length,
    progressPercent: 100,
    instrumentIds: ids,
    errorMessage: null,
    processedInBatch: batch.length,
  };
}

function advanceAfterInstrumentBatch(
  job: ScanJobRow,
  ids: number[],
  nextCursor: number,
  done: boolean,
  processedInBatch: number
): InternalAdvance {
  if (!done) {
    const processed = ids.filter((id) => id <= nextCursor).length;
    return {
      status: 'RUNNING',
      stage: job.current_stage,
      cursorInstrumentId: nextCursor,
      processedInstruments: processed,
      totalInstruments: ids.length,
      progressPercent: progressForStage(job.current_stage, processed, ids.length),
      instrumentIds: ids,
      errorMessage: null,
      processedInBatch,
    };
  }

  const nxt = nextStage(job.current_stage);
  if (!nxt) {
    return {
      status: 'SUCCESS',
      stage: job.current_stage,
      cursorInstrumentId: nextCursor,
      processedInstruments: ids.length,
      totalInstruments: ids.length,
      progressPercent: 100,
      instrumentIds: ids,
      errorMessage: null,
      processedInBatch,
    };
  }

  return {
    status: 'RUNNING',
    stage: nxt,
    cursorInstrumentId: 0,
    processedInstruments: 0,
    totalInstruments: ids.length,
    progressPercent: STAGE_PROGRESS[nxt].start,
    instrumentIds: ids,
    errorMessage: null,
    processedInBatch,
  };
}

export async function loadJobSnapshot(jobId: string): Promise<ScanJobRow | null> {
  const row = await getScanJob(jobId);
  return row ? mapScanJobRow(row) : null;
}
