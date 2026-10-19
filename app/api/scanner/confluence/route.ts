import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import {
  computeConfluenceForZone,
  getActiveZonesForInstrument,
  computeConfluence,
} from '@/lib/scanner/confluence';

/**
 * GET /api/scanner/confluence
 *
 * Query params (one of the following is required):
 *   zoneId        string – compute confluence for a specific zone
 *   instrumentId  number – compute confluence for all active zones of an instrument
 *
 * Returns:
 *   { results: ConfluenceResult[] }
 *
 * Example:
 *   GET /api/scanner/confluence?zoneId=<uuid>
 *   GET /api/scanner/confluence?instrumentId=256265
 */
export async function GET(req: NextRequest) {
  // --- Auth ---
  try {
    await requireSession(req.headers.get('cookie'));
  } catch {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const zoneId       = searchParams.get('zoneId') ?? undefined;
  const instrumentId = searchParams.get('instrumentId')
    ? Number(searchParams.get('instrumentId'))
    : undefined;

  if (!zoneId && !instrumentId) {
    return NextResponse.json(
      { error: 'Provide either `zoneId` or `instrumentId` as a query parameter.' },
      { status: 400 }
    );
  }

  try {
    if (zoneId) {
      const result = await computeConfluenceForZone(zoneId);
      if (!result) {
        return NextResponse.json({ error: 'Zone not found.' }, { status: 404 });
      }
      return NextResponse.json({ results: [result] });
    }

    // instrumentId path: compute for all active zones of the instrument.
    const allZones = await getActiveZonesForInstrument(instrumentId!);
    const results  = allZones.map((zone) => computeConfluence(zone, allZones));
    return NextResponse.json({ results });
  } catch (err: any) {
    console.error('[/api/scanner/confluence] error:', err);
    return NextResponse.json(
      { error: err?.message ?? 'Confluence computation failed' },
      { status: 500 }
    );
  }
}
