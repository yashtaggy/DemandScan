import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import { getDb } from '@/lib/db';
import { runBackfill } from '@/lib/scanner/backfill';
import { DEFAULT_SCANNER_CONFIG } from '@/lib/scanner/types';
import type { Timeframe } from '@/lib/scanner/types';

/**
 * POST /api/scanner/backfill
 *
 * Starts a historical backfill / replay for one instrument + timeframe.
 * Returns immediately with a jobId; the backfill runs fire-and-forget.
 *
 * Body (JSON):
 *   {
 *     instrumentId: number,   -- required
 *     timeframe: string,      -- required  e.g. "1D"
 *     from: "2023-01-01",     -- optional, defaults to 1 year back
 *     to:   "2024-10-18",     -- optional, defaults to today
 *     resume: true            -- optional, default true
 *   }
 *
 * Returns: { jobId: string }
 *
 * GET /api/scanner/backfill?jobId=<uuid>
 *
 * Returns the status of a specific backfill job.
 * Returns: { job: BackfillJob }
 *
 * GET /api/scanner/backfill?instrumentId=<n>&timeframe=<tf>
 *
 * Returns all backfill jobs for the given instrument + timeframe.
 * Returns: { jobs: BackfillJob[] }
 */

export async function POST(req: NextRequest) {
  try {
    await requireSession(req.headers.get('cookie'));
  } catch {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* use defaults */ }

  const instrumentId = body.instrumentId ? Number(body.instrumentId) : null;
  const timeframe    = (body.timeframe as Timeframe) ?? null;

  if (!instrumentId || !timeframe) {
    return NextResponse.json(
      { error: 'Both instrumentId and timeframe are required.' },
      { status: 400 }
    );
  }

  const VALID_TFS: Timeframe[] = ['1H','4H','1D','1W','1M','3M','6M','1Y'];
  if (!VALID_TFS.includes(timeframe)) {
    return NextResponse.json(
      { error: `Invalid timeframe. Must be one of: ${VALID_TFS.join(', ')}` },
      { status: 400 }
    );
  }

  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setFullYear(defaultFrom.getFullYear() - 1);

  const fromDate = body.from ? new Date(body.from as string) : defaultFrom;
  const toDate   = body.to   ? new Date(body.to   as string) : now;
  const resume   = body.resume !== false; // default true

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return NextResponse.json({ error: 'Invalid date format.' }, { status: 400 });
  }

  // Fire-and-forget — return jobId immediately
  let jobId = '';
  runBackfill({
    instrumentId,
    timeframe,
    fromDate,
    toDate,
    config: DEFAULT_SCANNER_CONFIG,
    resume,
  })
    .then((result) => { jobId = result.jobId; })
    .catch((err) => console.error('[backfill API] error:', err));

  // Small delay to capture the jobId from the first DB write
  await new Promise((res) => setTimeout(res, 150));

  return NextResponse.json({ jobId: jobId || 'pending' });
}

export async function GET(req: NextRequest) {
  try {
    await requireSession(req.headers.get('cookie'));
  } catch {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const jobId        = searchParams.get('jobId') ?? undefined;
  const instrumentId = searchParams.get('instrumentId')
    ? Number(searchParams.get('instrumentId'))
    : undefined;
  const timeframe = (searchParams.get('timeframe') as Timeframe) ?? undefined;

  const sql = getDb();

  if (jobId) {
    const rows = await sql`SELECT * FROM backfill_jobs WHERE job_id = ${jobId} LIMIT 1`;
    if (!rows.length) return NextResponse.json({ error: 'Job not found.' }, { status: 404 });
    return NextResponse.json({ job: rows[0] });
  }

  if (instrumentId) {
    const rows = await sql`
      SELECT * FROM backfill_jobs
      WHERE instrument_id = ${instrumentId}
        ${timeframe ? sql`AND timeframe = ${timeframe}` : sql``}
      ORDER BY started_at DESC
      LIMIT 20
    `;
    return NextResponse.json({ jobs: rows });
  }

  // List recent backfill jobs
  const rows = await sql`
    SELECT b.*, i.symbol
    FROM backfill_jobs b
    JOIN instruments i ON i.instrument_id = b.instrument_id
    ORDER BY b.started_at DESC
    LIMIT 50
  `;
  return NextResponse.json({ jobs: rows });
}
