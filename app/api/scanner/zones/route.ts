import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import { getDb } from '@/lib/db';
import type { Timeframe, ZoneSide } from '@/lib/scanner/types';

/**
 * GET /api/scanner/zones
 *
 * Query params (all optional):
 *   instrumentId      number   – filter by instrument token
 *   symbol            string   – filter by symbol (case-insensitive)
 *   timeframe         string   – 1H|4H|1D|1W|1M|3M|6M|1Y
 *   side              string   – DEMAND|SUPPLY
 *   lifecycle         string   – CONFIRMED_FRESH|TOUCHED_ONCE|RETESTED|BROKEN
 *   minScore          number   – minimum formation score (0–100)
 *   minCompositeScore number   – minimum composite score (0–100)
 *   maxDistancePct    number   – max distance from current price (%)
 *   minConfluence     number   – minimum confluence score (0–100)
 *   maxOppositionRisk number   – max opposition risk (0–100)
 *   formationFrom     string   – formation date >= YYYY-MM-DD
 *   formationTo       string   – formation date <= YYYY-MM-DD
 *   limit             number   – max results (default 50)
 *   offset            number   – pagination offset (default 0)
 *   sort              string   – score|composite_score|formation_ts|distance_pct (default: composite_score)
 *   dir               string   – asc|desc (default: desc)
 *
 * Returns: { zones: Zone[], count: number }
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession(req.headers.get('cookie'));
  } catch {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);

  const instrumentId      = searchParams.get('instrumentId')      ? Number(searchParams.get('instrumentId'))      : null;
  const symbol            = searchParams.get('symbol')            ?? null;
  const timeframe         = searchParams.get('timeframe')         as Timeframe ?? null;
  const side              = searchParams.get('side')              as ZoneSide  ?? null;
  const lifecycle         = searchParams.get('lifecycle')         ?? null;
  const minScore          = searchParams.get('minScore')          ? Number(searchParams.get('minScore'))          : null;
  const minCompositeScore = searchParams.get('minCompositeScore') ? Number(searchParams.get('minCompositeScore')) : null;
  const maxDistancePct    = searchParams.get('maxDistancePct')    ? Number(searchParams.get('maxDistancePct'))    : null;
  const minConfluence     = searchParams.get('minConfluence')     ? Number(searchParams.get('minConfluence'))     : null;
  const maxOppositionRisk = searchParams.get('maxOppositionRisk') ? Number(searchParams.get('maxOppositionRisk')) : null;
  const formationFrom     = searchParams.get('formationFrom')     ?? null;
  const formationTo       = searchParams.get('formationTo')       ?? null;
  const limit             = Math.min(Number(searchParams.get('limit')  ?? 50), 500);
  const offset            = Number(searchParams.get('offset') ?? 0);

  const allowedSorts: Record<string, string> = {
    score:            'z.score',
    composite_score:  'z.composite_score',
    formation_ts:     'z.formation_ts',
    distance_pct:     'z.distance_pct',
  };
  const sortCol = allowedSorts[searchParams.get('sort') ?? ''] ?? 'z.composite_score';
  const sortDir = searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';

  const sql = getDb();

  // Build data rows
  const rows = await sql`
    SELECT
      z.zone_id, z.instrument_id, i.symbol,
      z.timeframe, z.pattern, z.side,
      z.base_start, z.base_end, z.leg_in_ts, z.leg_out_ts,
      z.zone_low, z.zone_high, z.proximal, z.distal,
      z.formation_ts, z.config_version,
      z.score, z.composite_score, z.score_components,
      z.distance_pct, z.confluence_score, z.opposition_risk, z.data_quality_score,
      z.lifecycle_state, z.last_touch_ts, z.touch_count, z.created_at
    FROM zones z
    JOIN instruments i ON i.instrument_id = z.instrument_id
    WHERE
      (${instrumentId}::bigint IS NULL OR z.instrument_id = ${instrumentId})
      AND (${symbol}::text IS NULL OR UPPER(i.symbol) = UPPER(${symbol}))
      AND (${timeframe}::text IS NULL OR z.timeframe = ${timeframe})
      AND (${side}::text IS NULL OR z.side = ${side})
      AND (${lifecycle}::text IS NULL OR z.lifecycle_state = ${lifecycle})
      AND (${minScore}::int IS NULL OR z.score >= ${minScore})
      AND (${minCompositeScore}::int IS NULL OR z.composite_score >= ${minCompositeScore})
      AND (${maxDistancePct}::numeric IS NULL OR z.distance_pct <= ${maxDistancePct})
      AND (${minConfluence}::int IS NULL OR z.confluence_score >= ${minConfluence})
      AND (${maxOppositionRisk}::int IS NULL OR z.opposition_risk <= ${maxOppositionRisk})
      AND (${formationFrom}::date IS NULL OR z.formation_ts::date >= ${formationFrom}::date)
      AND (${formationTo}::date IS NULL OR z.formation_ts::date <= ${formationTo}::date)
    ORDER BY ${sql.unsafe(sortCol)} ${sql.unsafe(sortDir)} NULLS LAST
    LIMIT  ${limit}
    OFFSET ${offset}
  `;

  // Count for pagination
  const countRows = await sql`
    SELECT COUNT(*) AS n
    FROM zones z
    JOIN instruments i ON i.instrument_id = z.instrument_id
    WHERE
      (${instrumentId}::bigint IS NULL OR z.instrument_id = ${instrumentId})
      AND (${symbol}::text IS NULL OR UPPER(i.symbol) = UPPER(${symbol}))
      AND (${timeframe}::text IS NULL OR z.timeframe = ${timeframe})
      AND (${side}::text IS NULL OR z.side = ${side})
      AND (${lifecycle}::text IS NULL OR z.lifecycle_state = ${lifecycle})
      AND (${minScore}::int IS NULL OR z.score >= ${minScore})
      AND (${minCompositeScore}::int IS NULL OR z.composite_score >= ${minCompositeScore})
      AND (${maxDistancePct}::numeric IS NULL OR z.distance_pct <= ${maxDistancePct})
      AND (${minConfluence}::int IS NULL OR z.confluence_score >= ${minConfluence})
      AND (${maxOppositionRisk}::int IS NULL OR z.opposition_risk <= ${maxOppositionRisk})
      AND (${formationFrom}::date IS NULL OR z.formation_ts::date >= ${formationFrom}::date)
      AND (${formationTo}::date IS NULL OR z.formation_ts::date <= ${formationTo}::date)
  `;

  const zones = rows.map((r: any) => ({
    zoneId: r.zone_id,
    instrumentId: Number(r.instrument_id),
    symbol: r.symbol as string,
    timeframe: r.timeframe,
    pattern: r.pattern,
    side: r.side,
    baseStart: new Date(r.base_start),
    baseEnd: new Date(r.base_end),
    legInTs: new Date(r.leg_in_ts),
    legOutTs: new Date(r.leg_out_ts),
    zoneLow: Number(r.zone_low),
    zoneHigh: Number(r.zone_high),
    proximal: Number(r.proximal),
    distal: Number(r.distal),
    formationTs: new Date(r.formation_ts),
    configVersion: Number(r.config_version),
    score: Number(r.score),
    compositeScore: r.composite_score != null ? Number(r.composite_score) : null,
    scoreComponents: r.score_components ?? null,
    distancePct: r.distance_pct != null ? Number(r.distance_pct) : null,
    confluenceScore: Number(r.confluence_score ?? 0),
    oppositionRisk: Number(r.opposition_risk ?? 0),
    dataQualityScore: Number(r.data_quality_score ?? 5),
    lifecycleState: r.lifecycle_state,
    lastTouchTs: r.last_touch_ts ? new Date(r.last_touch_ts) : undefined,
    touchCount: Number(r.touch_count),
    createdAt: new Date(r.created_at),
  }));

  return NextResponse.json({ zones, count: Number(countRows[0].n) });
}
