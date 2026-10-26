/**
 * lib/scanner/jobs.ts
 *
 * Scan job record management — create, update, retrieve, and lease batches.
 * Progress percentage is updated only after a batch succeeds.
 */

import { getDb } from '../db';
import { randomUUID } from 'crypto';
import type { KiteSession } from '../types';
import { ingestAllInstruments } from './ingest_all';

export type ScanJobStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export type ScanStage =
  | 'SYNC_INSTRUMENTS'
  | 'INGEST_DAILY'
  | 'INGEST_HOURLY'
  | 'AGGREGATE_DAILY'
  | 'AGGREGATE_4H'
  | 'DETECT_ZONES'
  | 'LIFECYCLE';

export interface CreateScanJobOptions {
  sessionIdHash?: string;
  fromDate?: Date;
  toDate?: Date;
  concurrency?: number;
  instrumentIds?: number[];
  requestedSymbols?: string[];
}

export interface ScanJobRow {
  job_id: string;
  started_at: Date | string;
  completed_at: Date | string | null;
  status: ScanJobStatus;
  progress_percent: number;
  error_message: string | null;
  config_id: string;
  session_id_hash: string | null;
  from_date: Date | string | null;
  to_date: Date | string | null;
  concurrency: number;
  current_stage: ScanStage;
  cursor_instrument_id: number;
  instrument_ids: number[] | null;
  requested_symbols: string[] | null;
  retry_count: number;
  max_retries: number;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  total_instruments: number;
  processed_instruments: number;
}

function parseJsonArray(value: unknown): number[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(Number) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseStringArray(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function mapScanJobRow(row: any): ScanJobRow {
  return {
    job_id: row.job_id as string,
    started_at: row.started_at,
    completed_at: row.completed_at ?? null,
    status: row.status as ScanJobStatus,
    progress_percent: Number(row.progress_percent ?? 0),
    error_message: (row.error_message as string) ?? null,
    config_id: row.config_id as string,
    session_id_hash: (row.session_id_hash as string) ?? null,
    from_date: row.from_date ?? null,
    to_date: row.to_date ?? null,
    concurrency: Number(row.concurrency ?? 5),
    current_stage: (row.current_stage as ScanStage) ?? 'SYNC_INSTRUMENTS',
    cursor_instrument_id: Number(row.cursor_instrument_id ?? 0),
    instrument_ids: parseJsonArray(row.instrument_ids),
    requested_symbols: parseStringArray(row.requested_symbols),
    retry_count: Number(row.retry_count ?? 0),
    max_retries: Number(row.max_retries ?? 5),
    lease_owner: (row.lease_owner as string) ?? null,
    lease_expires_at: row.lease_expires_at ?? null,
    total_instruments: Number(row.total_instruments ?? 0),
    processed_instruments: Number(row.processed_instruments ?? 0),
  };
}

/**
 * Create a new scan job record in `scan_jobs`.
 * Returns the generated jobId (UUID).
 */
export async function createScanJob(
  configId: string,
  extras: CreateScanJobOptions = {}
): Promise<string> {
  const sql = getDb();
  const jobId = randomUUID();
  const hasCheckpointFields =
    extras.sessionIdHash != null ||
    extras.fromDate != null ||
    extras.toDate != null ||
    extras.instrumentIds != null ||
    extras.requestedSymbols != null ||
    extras.concurrency != null;

  if (!hasCheckpointFields) {
    await sql`
      INSERT INTO scan_jobs (job_id, started_at, status, progress_percent, config_id)
      VALUES (${jobId}, NOW(), ${'PENDING'}, 0, ${configId})
    `;
    return jobId;
  }

  const instrumentJson = extras.instrumentIds
    ? JSON.stringify(extras.instrumentIds)
    : null;
  const symbolsJson = extras.requestedSymbols
    ? JSON.stringify(extras.requestedSymbols)
    : null;
  const fromDate = extras.fromDate ?? null;
  const toDate = extras.toDate ?? null;
  const concurrency = extras.concurrency ?? 5;
  const sessionIdHash = extras.sessionIdHash ?? null;
  const total = extras.instrumentIds?.length ?? 0;

  await sql`
    INSERT INTO scan_jobs (
      job_id, started_at, status, progress_percent, config_id,
      session_id_hash, from_date, to_date, concurrency,
      current_stage, cursor_instrument_id, instrument_ids, requested_symbols,
      retry_count, max_retries, total_instruments, processed_instruments
    )
    VALUES (
      ${jobId}, NOW(), ${'PENDING'}, 0, ${configId},
      ${sessionIdHash}, ${fromDate}, ${toDate}, ${concurrency},
      ${'SYNC_INSTRUMENTS'}, 0, ${instrumentJson}::jsonb, ${symbolsJson}::jsonb,
      0, 5, ${total}, 0
    )
  `;
  return jobId;
}

/**
 * Update a job's status, progress, and optional error/completion fields.
 */
export async function updateScanJob(
  jobId: string,
  updates: {
    status?: ScanJobStatus;
    progressPercent?: number;
    errorMessage?: string | null;
    completedAt?: Date | null;
  }
): Promise<void> {
  const sql = getDb();

  if (updates.status !== undefined) {
    await sql`UPDATE scan_jobs SET status = ${updates.status} WHERE job_id = ${jobId}`;
  }
  if (updates.progressPercent !== undefined) {
    await sql`UPDATE scan_jobs SET progress_percent = ${updates.progressPercent} WHERE job_id = ${jobId}`;
  }
  if (updates.errorMessage !== undefined) {
    await sql`UPDATE scan_jobs SET error_message = ${updates.errorMessage ?? null} WHERE job_id = ${jobId}`;
  }
  if (updates.completedAt !== undefined) {
    await sql`UPDATE scan_jobs SET completed_at = ${updates.completedAt ?? null} WHERE job_id = ${jobId}`;
  }
}

export async function getScanJob(jobId: string): Promise<any> {
  const sql = getDb();
  const rows = await sql`SELECT * FROM scan_jobs WHERE job_id = ${jobId}`;
  return rows.length ? rows[0] : null;
}

export interface ScanStageBatchStats {
  stage: ScanStage;
  total: number;
  completed: number;
  failed: number;
  avgDurationMs: number;
  maxDurationMs: number;
}

export interface ScanBatchStats {
  total: number;
  completed: number;
  failed: number;
  /** Mean wall-clock duration of finished batches, in milliseconds. */
  avgDurationMs: number;
  /** Longest finished batch, useful for spotting 60s budget overruns. */
  maxDurationMs: number;
  /** Same counters grouped by stage, for locating slow parts of a job. */
  byStage: ScanStageBatchStats[];
}

/** Persisted batch counters for progress reporting. */
export async function getScanBatchStats(jobId: string): Promise<ScanBatchStats> {
  const sql = getDb();
  // GROUPING SETS returns one overall row (stage NULL) plus one row per stage
  // in a single round trip, so progress polling does not add a second query.
  const rows = await sql`
    SELECT
      stage,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
      COALESCE(
        AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
          FILTER (WHERE completed_at IS NOT NULL),
        0
      )::int AS avg_duration_ms,
      COALESCE(
        MAX(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
          FILTER (WHERE completed_at IS NOT NULL),
        0
      )::int AS max_duration_ms
    FROM scan_job_batches
    WHERE job_id = ${jobId}
    GROUP BY GROUPING SETS ((), (stage))
    ORDER BY stage NULLS FIRST
  `;
  const overall = rows.find((r: any) => r.stage == null) ?? {};
  const byStage = rows
    .filter((r: any) => r.stage != null)
    .map((r: any) => ({
      stage: r.stage as ScanStage,
      total: Number(r.total ?? 0),
      completed: Number(r.completed ?? 0),
      failed: Number(r.failed ?? 0),
      avgDurationMs: Number(r.avg_duration_ms ?? 0),
      maxDurationMs: Number(r.max_duration_ms ?? 0),
    }));
  return {
    total: Number(overall.total ?? 0),
    completed: Number(overall.completed ?? 0),
    failed: Number(overall.failed ?? 0),
    avgDurationMs: Number(overall.avg_duration_ms ?? 0),
    maxDurationMs: Number(overall.max_duration_ms ?? 0),
    byStage,
  };
}

export async function findActiveScanJob(
  sessionIdHash?: string
): Promise<ScanJobRow | null> {
  const sql = getDb();
  let rows;
  if (sessionIdHash) {
    rows = await sql`
      SELECT * FROM scan_jobs
      WHERE status IN ('PENDING', 'RUNNING')
        AND session_id_hash = ${sessionIdHash}
      ORDER BY started_at DESC
      LIMIT 1
    `;
  } else {
    rows = await sql`
      SELECT * FROM scan_jobs
      WHERE status IN ('PENDING', 'RUNNING')
      ORDER BY started_at DESC
      LIMIT 1
    `;
  }
  return rows.length ? mapScanJobRow(rows[0]) : null;
}

/** Age after which an abandoned job (no live lease) is retired. */
export const STALE_JOB_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Mark abandoned scan jobs as FAILED so they cannot be resumed forever.
 *
 * A job is abandoned when it is still PENDING/RUNNING, no worker holds a live
 * lease, and it started more than 24h ago. Job rows from older deployments can
 * otherwise be picked up by the browser's auto-resume and run with an outdated
 * universe. Only job lifecycle columns are touched; zones and candles are
 * never modified.
 */
export async function retireStaleScanJobs(
  sessionIdHash?: string
): Promise<number> {
  const sql = getDb();
  const cutoff = new Date(Date.now() - STALE_JOB_AFTER_MS);
  const message =
    'Abandoned: no scan progress for over 24 hours. Start a new scan.';

  const rows = sessionIdHash
    ? await sql`
        UPDATE scan_jobs
        SET status          = 'FAILED',
            completed_at    = NOW(),
            error_message   = ${message},
            lease_owner     = NULL,
            lease_expires_at = NULL
        WHERE status IN ('PENDING', 'RUNNING')
          AND session_id_hash = ${sessionIdHash}
          AND started_at < ${cutoff}
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        RETURNING job_id
      `
    : await sql`
        UPDATE scan_jobs
        SET status          = 'FAILED',
            completed_at    = NOW(),
            error_message   = ${message},
            lease_owner     = NULL,
            lease_expires_at = NULL
        WHERE status IN ('PENDING', 'RUNNING')
          AND started_at < ${cutoff}
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        RETURNING job_id
      `;

  if (rows.length > 0) {
    console.warn(`[scanner] retired ${rows.length} abandoned scan job(s)`);
  }
  return rows.length;
}


/**
 * Atomically claim a job for one worker. Returns null if another worker holds
 * a live lease or the job is not runnable.
 */
export async function claimScanJob(opts: {
  jobId?: string;
  sessionIdHash?: string | null;
  leaseOwner: string;
  leaseMs?: number;
}): Promise<ScanJobRow | null> {
  const sql = getDb();
  const leaseMs = opts.leaseMs ?? 90_000;
  const leaseExpires = new Date(Date.now() + leaseMs);
  const leaseOwner = opts.leaseOwner;

  let rows;
  if (opts.jobId) {
    if (opts.sessionIdHash) {
      rows = await sql`
        UPDATE scan_jobs SET
          status = 'RUNNING',
          lease_owner = ${leaseOwner},
          lease_expires_at = ${leaseExpires}
        WHERE job_id = ${opts.jobId}
          AND status IN ('PENDING', 'RUNNING')
          AND (session_id_hash = ${opts.sessionIdHash} OR session_id_hash IS NULL)
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        RETURNING *
      `;
    } else {
      rows = await sql`
        UPDATE scan_jobs SET
          status = 'RUNNING',
          lease_owner = ${leaseOwner},
          lease_expires_at = ${leaseExpires}
        WHERE job_id = ${opts.jobId}
          AND status IN ('PENDING', 'RUNNING')
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        RETURNING *
      `;
    }
  } else if (opts.sessionIdHash) {
    rows = await sql`
      UPDATE scan_jobs AS s SET
        status = 'RUNNING',
        lease_owner = ${leaseOwner},
        lease_expires_at = ${leaseExpires}
      FROM (
        SELECT job_id FROM scan_jobs
        WHERE status IN ('PENDING', 'RUNNING')
          AND session_id_hash = ${opts.sessionIdHash}
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        ORDER BY started_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      ) AS next_job
      WHERE s.job_id = next_job.job_id
      RETURNING s.*
    `;
  } else {
    rows = await sql`
      UPDATE scan_jobs AS s SET
        status = 'RUNNING',
        lease_owner = ${leaseOwner},
        lease_expires_at = ${leaseExpires}
      FROM (
        SELECT job_id FROM scan_jobs
        WHERE status IN ('PENDING', 'RUNNING')
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        ORDER BY started_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      ) AS next_job
      WHERE s.job_id = next_job.job_id
      RETURNING s.*
    `;
  }

  return rows.length ? mapScanJobRow(rows[0]) : null;
}

export async function insertScanBatch(opts: {
  jobId: string;
  stage: ScanStage;
  cursorStart: number;
  cursorEnd: number;
  instrumentIds: number[];
  attempt: number;
  leaseOwner: string;
}): Promise<string> {
  const sql = getDb();
  const batchId = randomUUID();
  const idsJson = JSON.stringify(opts.instrumentIds);
  await sql`
    INSERT INTO scan_job_batches (
      batch_id, job_id, stage, cursor_start, cursor_end, instrument_ids,
      status, attempt, lease_owner, started_at
    ) VALUES (
      ${batchId}, ${opts.jobId}, ${opts.stage}, ${opts.cursorStart}, ${opts.cursorEnd},
      ${idsJson}::jsonb, ${'RUNNING'}, ${opts.attempt}, ${opts.leaseOwner}, NOW()
    )
  `;
  return batchId;
}

export async function completeScanBatch(batchId: string): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE scan_job_batches
    SET status = 'SUCCESS', completed_at = NOW(), error_message = NULL
    WHERE batch_id = ${batchId}
  `;
}

export async function failScanBatch(batchId: string, errorMessage: string): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE scan_job_batches
    SET status = 'FAILED', completed_at = NOW(), error_message = ${errorMessage}
    WHERE batch_id = ${batchId}
  `;
}

export async function persistScanJobCheckpoint(opts: {
  jobId: string;
  status: ScanJobStatus;
  stage: ScanStage;
  cursorInstrumentId: number;
  processedInstruments: number;
  totalInstruments: number;
  progressPercent: number;
  retryCount: number;
  instrumentIds?: number[] | null;
  errorMessage?: string | null;
  completedAt?: Date | null;
}): Promise<ScanJobRow | null> {
  const sql = getDb();
  const idsJson =
    opts.instrumentIds == null ? null : JSON.stringify(opts.instrumentIds);
  const completedAt = opts.completedAt ?? null;
  const errorMessage = opts.errorMessage ?? null;

  // RETURNING avoids a second round trip in the batch route just to re-read
  // the row that was just written.
  const rows = await sql`
    UPDATE scan_jobs SET
      status = ${opts.status},
      current_stage = ${opts.stage},
      cursor_instrument_id = ${opts.cursorInstrumentId},
      processed_instruments = ${opts.processedInstruments},
      total_instruments = ${opts.totalInstruments},
      progress_percent = ${opts.progressPercent},
      retry_count = ${opts.retryCount},
      error_message = ${errorMessage},
      instrument_ids = ${idsJson}::jsonb,
      completed_at = ${completedAt},
      lease_owner = NULL,
      lease_expires_at = NULL
    WHERE job_id = ${opts.jobId}
    RETURNING *
  `;
  return rows.length ? mapScanJobRow(rows[0]) : null;
}

/**
 * Run a simple ingestion-only job (used by /api/scanner/ingest).
 * For the full scan pipeline, use the batch runner instead.
 */
export async function runIngestionJob(
  session: KiteSession,
  jobId: string,
  fromDate: Date,
  toDate: Date,
  concurrency = 5
): Promise<void> {
  await updateScanJob(jobId, { status: 'RUNNING', progressPercent: 0 });
  try {
    await ingestAllInstruments(session, fromDate, toDate, concurrency);
    await updateScanJob(jobId, {
      status: 'SUCCESS',
      progressPercent: 100,
      completedAt: new Date(),
    });
  } catch (err: any) {
    await updateScanJob(jobId, {
      status: 'FAILED',
      errorMessage: err?.message ?? 'Unknown error',
      completedAt: new Date(),
    });
    throw err;
  }
}
