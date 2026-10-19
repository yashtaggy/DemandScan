import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import { getOrCreateDefaultConfig } from '@/lib/scanner/config';
import { createScanJob, updateScanJob } from '@/lib/scanner/jobs';
import { syncInstruments } from '@/lib/scanner/instruments';
import { ingestAllInstruments } from '@/lib/scanner/ingest_all';
import { ingestAllHourlyCandles } from '@/lib/scanner/hourly_ingest';

/**
 * POST /api/scanner/ingest
 *
 * Instruments sync + incremental candle ingestion (daily + 1H).
 * Idempotent — per-instrument checkpoints skip already-fetched ranges.
 *
 * Body (optional JSON):
 *   {
 *     from: "2023-01-01",   -- defaults to 1 year back
 *     to:   "2024-10-18",   -- defaults to today
 *     concurrency: 5,       -- parallel Kite requests for daily
 *     includeHourly: true   -- also ingest 1H candles (default true)
 *   }
 *
 * Returns: { jobId: string }
 * Poll /api/scanner/job/:jobId for status.
 */
export async function POST(req: NextRequest) {
  let session;
  try {
    session = await requireSession(req.headers.get('cookie'));
  } catch {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* use defaults */ }

  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setFullYear(defaultFrom.getFullYear() - 1);

  const fromDate = body.from ? new Date(body.from as string) : defaultFrom;
  const toDate   = body.to   ? new Date(body.to   as string) : now;

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return NextResponse.json(
      { error: 'Invalid date format. Use ISO 8601 (YYYY-MM-DD).' },
      { status: 400 }
    );
  }
  if (fromDate > toDate) {
    return NextResponse.json({ error: '`from` must be before `to`.' }, { status: 400 });
  }

  const concurrency     = Number(body.concurrency)  || 5;
  const includeHourly   = body.includeHourly !== false; // default true

  const configId = await getOrCreateDefaultConfig();
  const jobId    = await createScanJob(configId);

  (async () => {
    try {
      await updateScanJob(jobId, { status: 'RUNNING', progressPercent: 2 });

      // Step 1 — Sync instrument master
      await syncInstruments(session);
      await updateScanJob(jobId, { progressPercent: 10 });

      // Step 2a — Ingest daily candles
      await ingestAllInstruments(session, fromDate, toDate, concurrency);
      await updateScanJob(jobId, { progressPercent: includeHourly ? 55 : 95 });

      // Step 2b — Ingest 1H hourly candles (rate-limit sensitive: concurrency ≤ 3)
      if (includeHourly) {
        await ingestAllHourlyCandles(session, fromDate, toDate, Math.min(concurrency, 3));
        await updateScanJob(jobId, { progressPercent: 95 });
      }

      await updateScanJob(jobId, { status: 'SUCCESS', progressPercent: 100, completedAt: new Date() });
    } catch (err: any) {
      console.error('[scanner/ingest] job failed:', err);
      await updateScanJob(jobId, { status: 'FAILED', errorMessage: err?.message ?? 'Unknown error', completedAt: new Date() });
    }
  })();

  return NextResponse.json({ jobId });
}
