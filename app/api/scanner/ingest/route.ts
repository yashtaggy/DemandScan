import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import { getOrCreateDefaultConfig } from '@/lib/scanner/config';
import { createScanJob, runIngestionJob } from '@/lib/scanner/jobs';

/**
 * POST /api/scanner/ingest
 *
 * Body (JSON):
 *   { "from": "2024-01-01", "to": "2024-01-31" }
 *   Dates are ISO strings (YYYY-MM-DD). If omitted defaults to last 30 days.
 *
 * Returns: { jobId: string }
 */
export async function POST(req: NextRequest) {
  // Authenticate user – requires a valid Kite session.
  const session = await requireSession(req.headers.get('cookie'));

  // Parse request body.
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // ignore – will use defaults.
  }

  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 30);

  const fromDate = body.from ? new Date(body.from) : defaultFrom;
  const toDate = body.to ? new Date(body.to) : now;

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return NextResponse.json({ error: 'Invalid date format', code: 'INVALID_DATES' }, { status: 400 });
  }
  if (fromDate > toDate) {
    return NextResponse.json({ error: '`from` must be before `to`', code: 'INVALID_RANGE' }, { status: 400 });
  }

  // Ensure we have a scanner config.
  const configId = await getOrCreateDefaultConfig();

  // Create job record.
  const jobId = await createScanJob(configId);

  // Fire‑and‑forget ingestion – do NOT await so the HTTP request returns quickly.
  // Errors are captured inside runIngestionJob and reflected in the job record.
  runIngestionJob(session, jobId, fromDate, toDate).catch((err) => {
    console.error('[scanner/ingest] job failed:', err);
    // Update job status to FAILED.
    import('@/lib/scanner/jobs').then((mod) => {
      mod.updateScanJob(jobId, { status: 'FAILED', errorMessage: err?.message ?? 'Unknown error' });
    });
  });

  return NextResponse.json({ jobId });
}
