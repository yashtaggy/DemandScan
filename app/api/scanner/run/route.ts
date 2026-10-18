import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import { getOrCreateDefaultConfig } from '@/lib/scanner/config';
import { createScanJob } from '@/lib/scanner/jobs';
import { runFullScan } from '@/lib/scanner/orchestrator';

/**
 * POST /api/scanner/run
 *
 * Triggers a full supply/demand zone scan pipeline:
 *  1. Instrument sync
 *  2. Daily candle ingestion
 *  3. Timeframe aggregation
 *  4. Pattern detection + zone scoring
 *  5. Lifecycle update
 *
 * Body (optional JSON):
 *  { "from": "2023-01-01", "to": "2024-10-01", "concurrency": 5 }
 *
 * Returns: { jobId: string }
 */
export async function POST(req: NextRequest) {
  let session;
  try {
    session = await requireSession(req.headers.get('cookie'));
  } catch (e) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // use defaults
  }

  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setFullYear(defaultFrom.getFullYear() - 1); // 1 year back by default

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
  const configId = await getOrCreateDefaultConfig();
  const jobId = await createScanJob(configId);

  // Fire-and-forget
  runFullScan({ jobId, session, fromDate, toDate, concurrency }).catch(console.error);

  return NextResponse.json({ jobId });
}
