/**
 * lib/scanner/jobs.ts
 *
 * Scan job record management — create, update, retrieve.
 * Progress percentage is updated by the orchestrator as work progresses.
 */

import { getDb } from '../db';
import { randomUUID } from 'crypto';
import type { KiteSession } from '../types';
import { ingestAllInstruments } from './ingest_all';

export type ScanJobStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED';

/**
 * Create a new scan job record in `scan_jobs`.
 * Returns the generated jobId (UUID).
 */
export async function createScanJob(configId: string): Promise<string> {
  const sql = getDb();
  const jobId = randomUUID();
  await sql`
    INSERT INTO scan_jobs (job_id, started_at, status, progress_percent, config_id)
    VALUES (${jobId}, NOW(), ${'PENDING'}, 0, ${configId})
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

  // Neon's tagged-template driver enforces parameterised queries per clause.
  // We apply each field update only if it is present in the updates object.
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

/**
 * Retrieve a scan job record by ID.
 */
export async function getScanJob(jobId: string): Promise<any> {
  const sql = getDb();
  const rows = await sql`SELECT * FROM scan_jobs WHERE job_id = ${jobId}`;
  return rows.length ? rows[0] : null;
}

/**
 * Run a simple ingestion-only job (used by /api/scanner/ingest).
 * For the full scan pipeline, use the orchestrator instead.
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
