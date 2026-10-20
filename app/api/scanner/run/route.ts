import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSessionIdFromCookies, requireSession } from '@/lib/kite-session';
import { hashSessionId } from '@/lib/crypto';
import { getOrCreateDefaultConfig } from '@/lib/scanner/config';
import { createScanJob, findActiveScanJob, getScanJob } from '@/lib/scanner/jobs';
import { processScanBatch } from '@/lib/scanner/batchRunner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/scanner/run
 *
 * Queues a resumable scan and immediately processes the first bounded batch.
 * Remaining work is continued by POST /api/scanner/batch (UI) and by Vercel
 * Cron GET /api/scanner/batch when CRON_SECRET is configured.
 *
 * Body (optional JSON):
 *  {
 *    "from": "2023-01-01",
 *    "to": "2024-10-01",
 *    "concurrency": 5,
 *    "symbols": ["RELIANCE"],
 *    "instrumentIds": [408065]
 *  }
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

  const active = await findActiveScanJob(sessionIdHash);
  if (active) {
    return NextResponse.json(
      {
        error: 'SCAN_IN_PROGRESS',
        jobId: active.job_id,
        message: 'An active scan is already running. Resume it instead of starting another.',
      },
      { status: 409 }
    );
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // defaults
  }

  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setFullYear(defaultFrom.getFullYear() - 1);

  const fromDate = body.from ? new Date(body.from) : defaultFrom;
  const toDate = body.to ? new Date(body.to) : now;

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return NextResponse.json(
      { error: 'Invalid date format', code: 'INVALID_DATES' },
      { status: 400 }
    );
  }
  if (fromDate > toDate) {
    return NextResponse.json(
      { error: '`from` must be before `to`', code: 'INVALID_RANGE' },
      { status: 400 }
    );
  }

  const concurrency = Number(body.concurrency) || 5;
  const instrumentIds = Array.isArray(body.instrumentIds)
    ? body.instrumentIds.map(Number).filter((n: number) => Number.isFinite(n))
    : undefined;
  const symbols = Array.isArray(body.symbols)
    ? body.symbols.map((s: unknown) => String(s).trim().toUpperCase()).filter(Boolean)
    : undefined;

  const configId = await getOrCreateDefaultConfig();
  const jobId = await createScanJob(configId, {
    sessionIdHash,
    fromDate,
    toDate,
    concurrency,
    instrumentIds: instrumentIds && instrumentIds.length > 0 ? instrumentIds : undefined,
    requestedSymbols: symbols && symbols.length > 0 ? symbols : undefined,
  });

  const batch = await processScanBatch({
    jobId,
    sessionIdHash,
    session,
  });

  const job = await getScanJob(jobId);
  return NextResponse.json({
    jobId,
    moreRemaining: batch.moreRemaining,
    job,
  });
}
