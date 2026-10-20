import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { authorizeScanWorker } from '@/lib/scanner/scanAuth';
import { processScanBatch } from '@/lib/scanner/batchRunner';
import { getScanJob } from '@/lib/scanner/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Process one bounded scan batch.
 *
 * POST — authenticated UI worker (`ds_sid` session cookie). Optional `{ jobId }`.
 * GET  — Vercel Cron (`Authorization: Bearer CRON_SECRET`). Picks the next leased job.
 *
 * Cron requests do not have the user's session cookie; the worker loads the
 * encrypted Kite token via the job's stored session_id_hash.
 */
async function handle(req: NextRequest) {
  const auth = await authorizeScanWorker(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let jobId: string | undefined;
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      if (typeof body?.jobId === 'string' && body.jobId.trim()) {
        jobId = body.jobId.trim();
      }
    } catch {
      // empty body is fine
    }
  }

  const result = await processScanBatch({
    jobId,
    sessionIdHash: auth.mode === 'session' ? auth.sessionIdHash : null,
    session: auth.mode === 'session' ? auth.session : null,
  });

  const job = result.jobId ? await getScanJob(result.jobId) : null;

  return NextResponse.json({
    claimed: result.claimed,
    jobId: result.jobId,
    moreRemaining: result.moreRemaining,
    processedInBatch: result.processedInBatch,
    errorMessage: result.errorMessage,
    job,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
