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
  syncNseInstrumentsChunk,
} from './instruments';
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

/** Conservative sizes so a batch finishes inside a 60s serverless function. */
export const STAGE_BATCH_SIZES: Record<ScanStage, number> = {
  SYNC_INSTRUMENTS: 120,
  INGEST_DAILY: 3,
  INGEST_HOURLY: 1,
  AGGREGATE_DAILY: 12,
  AGGREGATE_4H: 8,
  DETECT_ZONES: 3,
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
}

export interface ScanWorkers {
  syncChunk: typeof syncNseInstrumentsChunk;
  listActiveIds: typeof listActiveInstrumentIds;
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
  syncChunk: syncNseInstrumentsChunk,
  listActiveIds: listActiveInstrumentIds,
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
  const claimed = await store.claim({
    jobId: opts.jobId,
    sessionIdHash: opts.sessionIdHash,
    leaseOwner,
  });

  if (!claimed) {
    return unclaimedResult(opts.jobId, opts.sessionIdHash ?? null, store);
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
  };

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

    await store.completeBatch(batchId);
    await store.persist({
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

    return {
      claimed: true,
      jobId: claimed.job_id,
      status: result.status,
      stage: result.stage,
      progressPercent: result.progressPercent,
      moreRemaining: result.status === 'RUNNING' || result.status === 'PENDING',
      errorMessage: result.errorMessage,
      processedInBatch: result.processedInBatch,
    };
  } catch (err: any) {
    const message = err?.message ?? 'Unknown batch error';
    await store.failBatch(batchId, message);
    const retries = claimed.retry_count + 1;
    const exhausted = retries >= claimed.max_retries;
    await store.persist({
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

async function runSyncStage(
  job: ScanJobRow,
  session: KiteSession,
  workers: ScanWorkers
): Promise<InternalAdvance> {
  const alreadyResolved = await tryResolveUniverseWithoutSync(job, workers);
  if (alreadyResolved) {
    return {
      status: 'RUNNING',
      stage: 'INGEST_DAILY',
      cursorInstrumentId: 0,
      processedInstruments: 0,
      totalInstruments: alreadyResolved.length,
      progressPercent: 5,
      instrumentIds: alreadyResolved,
      errorMessage: null,
      processedInBatch: 0,
    };
  }

  const chunk = await workers.syncChunk(
    session,
    job.cursor_instrument_id,
    STAGE_BATCH_SIZES.SYNC_INSTRUMENTS
  );

  if (!chunk.done) {
    return {
      status: 'RUNNING',
      stage: 'SYNC_INSTRUMENTS',
      cursorInstrumentId: chunk.lastId,
      processedInstruments: job.processed_instruments + chunk.upserted,
      totalInstruments: job.total_instruments,
      progressPercent: 2,
      instrumentIds: job.instrument_ids,
      errorMessage: null,
      processedInBatch: chunk.upserted,
    };
  }

  const ids = await resolveUniverseAfterSync(job, workers);
  return {
    status: 'RUNNING',
    stage: 'INGEST_DAILY',
    cursorInstrumentId: 0,
    processedInstruments: 0,
    totalInstruments: ids.length,
    progressPercent: 5,
    instrumentIds: ids,
    errorMessage: null,
    processedInBatch: chunk.upserted,
  };
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
  return workers.listActiveIds();
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
  const snapshots = await workers.snapshots(batch);
  await workers.lifecycles(snapshots, DEFAULT_SCANNER_CONFIG);

  if (!done) {
    const processed = ids.filter((id) => id <= nextCursor).length;
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
