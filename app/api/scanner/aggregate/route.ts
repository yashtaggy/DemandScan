import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import { aggregateAllTimeframes } from '@/lib/scanner/aggregation';

/**
 * POST /api/scanner/aggregate
 *
 * Runs Phase 3 of the scan pipeline independently:
 *  Aggregates all daily candles in `daily_candles` into the
 *  `aggregated_candles` table across timeframes 1W, 1M, 3M, 6M, 1Y.
 *
 * Idempotent — uses ON CONFLICT DO UPDATE so safe to re-run after each
 * ingestion cycle. Typical runtime: a few seconds for Nifty 500.
 *
 * Returns:
 *   { ok: true, message: string }
 */
export async function POST(req: NextRequest) {
  // --- Auth ---
  try {
    await requireSession(req.headers.get('cookie'));
  } catch {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  try {
    await aggregateAllTimeframes();
    return NextResponse.json({
      ok: true,
      message: 'Aggregation complete for timeframes: 1W, 1M, 3M, 6M, 1Y',
    });
  } catch (err: any) {
    console.error('[/api/scanner/aggregate] error:', err);
    return NextResponse.json(
      { error: err?.message ?? 'Aggregation failed' },
      { status: 500 }
    );
  }
}
