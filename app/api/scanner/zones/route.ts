import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import { getDb } from '@/lib/db';
import { parseZoneQuery, buildZoneWhere } from '@/lib/scanner/zone-query';

/**
 * GET /api/scanner/zones
 *
 * Server-side filtering, sorting and pagination over persisted zones —
 * independent of scanning (no scan is started or resumed by this endpoint).
 *
 * Query params (all optional, validated; invalid values return 400):
 *   instrumentId      positive integer
 *   symbol            1–32 chars [A-Z0-9&.-], case-insensitive
 *   timeframe         1H|4H|1D|1W|1M|3M|6M|1Y
 *   side              DEMAND|SUPPLY
 *   pattern           DBR|RBR|RBD|DBD
 *   lifecycle         CONFIRMED_FRESH|TOUCHED_ONCE|RETESTED|BROKEN
 *   minScore          0–100
 *   minCompositeScore 0–100
 *   maxDistancePct    0–100
 *   minConfluence     0–100
 *   maxOppositionRisk 0–100
 *   formationFrom     YYYY-MM-DD
 *   formationTo       YYYY-MM-DD
 *   limit             1–500 (default 100)
 *   offset            >= 0 (default 0)
 *   sort              score|composite_score|formation_ts|distance_pct
 *   dir               asc|desc
 *
 * Returns: { zones, count, limit, offset, hasMore }.
 * `count` is the total number of matching zones, not the page size.
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession(req.headers.get('cookie'));
  } catch {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const parsed = parseZoneQuery(searchParams);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.error, code: 'INVALID_QUERY' },
      { status: 400 }
    );
  }
  const q = parsed.query;
  const sql = getDb();
  const where = buildZoneWhere(q);

  // Data rows
  const rows = await sql.query(
    `SELECT
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
    ${where.clause}
    ORDER BY ${q.sortColumn} ${q.dir} NULLS LAST
    LIMIT $${where.params.length + 1}
    OFFSET $${where.params.length + 2}`,
    [...where.params, q.limit, q.offset]
  );

  // Total matching count (independent of the page)
  const countRows = await sql.query(
    `SELECT COUNT(*) AS n
    FROM zones z
    JOIN instruments i ON i.instrument_id = z.instrument_id
    ${where.clause}`,
    where.params
  );

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

  const count = Number(countRows[0]?.n ?? 0);
  return NextResponse.json({
    zones,
    count,
    limit: q.limit,
    offset: q.offset,
    hasMore: q.offset + zones.length < count,
  });
}
