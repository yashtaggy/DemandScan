import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import { getDb } from '@/lib/db';
import type { Timeframe } from '@/lib/scanner/types';

/**
 * GET /api/scanner/coverage
 *
 * Returns candle_coverage rows showing the actual available history for
 * each instrument × timeframe combination.
 *
 * Query params (all optional):
 *   symbol      string  – filter by instrument symbol (case-insensitive)
 *   timeframe   string  – filter by timeframe (1H|4H|1D|1W|1M|3M|6M|1Y)
 *   limit       number  – max results (default 100)
 *   offset      number  – pagination offset (default 0)
 *
 * Returns:
 *   { coverage: CandleCoverage[], total: number }
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession(req.headers.get('cookie'));
  } catch {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const symbol    = searchParams.get('symbol') ?? undefined;
  const timeframe = (searchParams.get('timeframe') as Timeframe) ?? undefined;
  const limit     = Number(searchParams.get('limit')  ?? 100);
  const offset    = Number(searchParams.get('offset') ?? 0);

  const sql = getDb();

  const rows = await sql`
    SELECT
      c.instrument_id,
      i.symbol,
      c.timeframe,
      c.first_candle,
      c.last_candle,
      c.total_candles,
      c.missing_gaps,
      c.last_updated
    FROM candle_coverage c
    JOIN instruments i ON i.instrument_id = c.instrument_id
    WHERE
      (${symbol ?? null}::text IS NULL OR UPPER(i.symbol) = UPPER(${symbol ?? null}))
      AND (${timeframe ?? null}::text IS NULL OR c.timeframe = ${timeframe ?? null})
    ORDER BY i.symbol ASC, c.timeframe ASC
    LIMIT  ${limit}
    OFFSET ${offset}
  `;

  const countRows = await sql`
    SELECT COUNT(*) AS n
    FROM candle_coverage c
    JOIN instruments i ON i.instrument_id = c.instrument_id
    WHERE
      (${symbol ?? null}::text IS NULL OR UPPER(i.symbol) = UPPER(${symbol ?? null}))
      AND (${timeframe ?? null}::text IS NULL OR c.timeframe = ${timeframe ?? null})
  `;

  const coverage = rows.map((r: any) => ({
    instrumentId: Number(r.instrument_id),
    symbol: r.symbol as string,
    timeframe: r.timeframe as Timeframe,
    firstCandle: r.first_candle ? new Date(r.first_candle) : null,
    lastCandle:  r.last_candle  ? new Date(r.last_candle)  : null,
    totalCandles: Number(r.total_candles),
    missingGaps:  Number(r.missing_gaps),
    lastUpdated:  new Date(r.last_updated),
  }));

  return NextResponse.json({ coverage, total: Number(countRows[0].n) });
}
