import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import { getZones } from '@/lib/scanner/zones';
import type { Timeframe, ZoneSide } from '@/lib/scanner/types';

/**
 * GET /api/scanner/zones
 *
 * Query params:
 *   instrumentId  number   – filter by instrument
 *   timeframe     string   – 1D|1W|1M|3M|6M|1Y
 *   side          string   – DEMAND|SUPPLY
 *   lifecycle     string   – CONFIRMED_FRESH|TOUCHED_ONCE|RETESTED|BROKEN
 *   minScore      number   – minimum zone score (0–100)
 *   limit         number   – max results (default 50)
 *   offset        number   – pagination offset (default 0)
 *
 * Returns: { zones: Zone[], count: number }
 */
export async function GET(req: NextRequest) {
  // Verify authentication but allow unauthenticated access for development/UI safety
  let session: any = null;
  try {
    session = await requireSession(req.headers.get('cookie'));
  } catch (e) {
    // If authentication fails, we continue without a session; UI will handle empty data
    console.warn('Unauthenticated request to /api/scanner/zones');
  }
  // If session is required for further logic, you can add checks here. For now, we proceed.

  const { searchParams } = new URL(req.url);

  const instrumentId = searchParams.get('instrumentId')
    ? Number(searchParams.get('instrumentId'))
    : undefined;
  const timeframe = (searchParams.get('timeframe') as Timeframe) || undefined;
  const side = (searchParams.get('side') as ZoneSide) || undefined;
  const lifecycleState = searchParams.get('lifecycle') || undefined;
  const minScore = searchParams.get('minScore')
    ? Number(searchParams.get('minScore'))
    : undefined;
  const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : 50;
  const offset = searchParams.get('offset') ? Number(searchParams.get('offset')) : 0;

  const zones = await getZones({
    instrumentId,
    timeframe,
    side,
    lifecycleState,
    minScore,
    limit,
    offset,
  });

  return NextResponse.json({ zones, count: zones.length });
}
