// app/api/scanner/export/route.ts

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import { getZones } from '@/lib/scanner/zones';
import { zonesToCsv } from '@/lib/scanner/export';
import type { Timeframe, ZoneSide } from '@/lib/scanner/types';

/**
 * GET /api/scanner/export
 *
 * Query params are identical to the /zones endpoint.
 * The response format is determined by the Accept header:
 *   - application/json → JSON { zones, count }
 *   - text/csv        → CSV string download
 */
export async function GET(req: NextRequest) {
  // Authentication – return 401 if not logged in
  try {
    await requireSession(req.headers.get('cookie'));
  } catch (e) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

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

  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/csv')) {
    const csv = zonesToCsv(zones);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="zones.csv"',
      },
    });
  }

  return NextResponse.json({ zones, count: zones.length });
}
