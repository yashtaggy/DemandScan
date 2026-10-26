import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSessionIdFromCookies, requireSession } from '@/lib/kite-session';
import { hashSessionId } from '@/lib/crypto';
import { processScanBatch } from '@/lib/scanner/batchRunner';
import { getScanBatchStats, getScanJob } from '@/lib/scanner/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Process one bounded scan batch for the authenticated user's active job.
 *
 * POST — authenticated UI worker (`ds_sid` session cookie). Optional `{ jobId }`.
 * The browser keeps requesting batches until the job reaches a terminal state
 * (SUCCESS or FAILED).
 */
export async function POST(req: NextRequest) {
  const cookie = req.headers.get('cookie');
  let session;
  try {
    session = await requireSession(cookie);
  } catch {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const sessionId = getSessionIdFromCookies(cookie);
  if (!sessionId) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const sessionIdHash = hashSessionId(sessionId);

  let jobId: string | undefined;
  try {
    const body = await req.json();
    if (typeof body?.jobId === 'string' && body.jobId.trim()) {
      jobId = body.jobId.trim();
    }
  } catch {
    // empty body is fine
  }

  const result = await processScanBatch({
    jobId,
    sessionIdHash,
    session,
  });

  const job = result.jobId ? await getScanJob(result.jobId) : null;

  return NextResponse.json({
    claimed: result.claimed,
    jobId: result.jobId,
    moreRemaining: result.moreRemaining,
    processedInBatch: result.processedInBatch,
    durationMs: result.durationMs,
    errorMessage: result.errorMessage,
    retryAfterMs: result.retryAfterMs,
    job,
    batches: result.jobId ? await getScanBatchStats(result.jobId) : null,
  });
}
