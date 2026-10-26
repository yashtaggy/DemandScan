/**
 * Route-level tests for GET /api/scanner/zones.
 *
 * These assert the contract the UI depends on: validated filters, server-side
 * sorting/pagination against the FULL matching set, a total count independent
 * of the page, and no scan side effects.
 */

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

jest.mock('@/lib/kite-session', () => ({
  requireSession: jest.fn(async () => ({})),
}));

const mockQuery = jest.fn();

jest.mock('@/lib/db', () => ({
  getDb: jest.fn(() => ({ query: mockQuery })),
}));

import { GET } from '@/app/api/scanner/zones/route';
import { requireSession } from '@/lib/kite-session';

const requireSessionMock = requireSession as jest.Mock;

function request(qs: string) {
  return {
    url: `https://app.test/api/scanner/zones${qs ? `?${qs}` : ''}`,
    headers: new Headers(),
  } as any;
}

async function call(qs: string) {
  const res = await GET(request(qs));
  return { status: res.status, body: await res.json() };
}

function firstSql() {
  return mockQuery.mock.calls[0] as unknown as [string, unknown[]];
}
function secondSql() {
  return mockQuery.mock.calls[1] as unknown as [string, unknown[]];
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ n: 0 }]);
  requireSessionMock.mockReset();
  requireSessionMock.mockResolvedValue({});
});

describe('GET /api/scanner/zones', () => {
  test('returns 401 without a session and never queries', async () => {
    requireSessionMock.mockRejectedValue(new Error('no session'));
    const { status, body } = await call('');
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'UNAUTHENTICATED' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('returns 400 for malformed query parameters (no NaN limit)', async () => {
    const { status, body } = await call('limit=abc');
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_QUERY');
    expect(body.error).toContain('limit');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('applies default server pagination and separates page count from total count', async () => {
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce([{ ...zoneRow(1), zone_id: 1 }])
      .mockResolvedValueOnce([{ n: 250 }]);

    const { status, body } = await call('');

    expect(status).toBe(200);
    expect(body.count).toBe(250);
    expect(body.zones).toHaveLength(1);
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
    expect(body.hasMore).toBe(true);

    const [rowsSql, rowsParams] = firstSql();
    const [, countParams] = secondSql();
    expect(rowsSql).toContain('WHERE z.score >= $1');
    expect(rowsSql).toContain('ORDER BY z.score DESC NULLS LAST, z.zone_id ASC');
    expect(rowsSql).toContain('LIMIT $2');
    expect(rowsSql).toContain('OFFSET $3');
    expect(rowsParams).toEqual([50, 100, 0]);
    expect(countParams).toEqual([50]);
  });

  test('every explicit sort ends with the same zone_id tie-breaker', async () => {
    await call('sort=composite_score&dir=desc');

    const [rowsSql] = firstSql();
    expect(rowsSql).toContain(
      'ORDER BY z.composite_score DESC NULLS LAST, z.zone_id ASC'
    );
  });

  test('minScore=0 explicitly disables the default Formation Score floor', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ n: 0 }]);

    await call('minScore=0');

    const [rowsSql, rowsParams] = firstSql();
    expect(rowsSql).toContain('WHERE z.score >= $1');
    expect(rowsParams).toEqual([0, 100, 0]);
  });

  test('binds filters and pagination in order, and sorts on the whitelisted column', async () => {
    await call(
      'symbol=reliance&side=DEMAND&pattern=DBR&minScore=70&limit=50&offset=100&sort=score&dir=asc'
    );

    const [rowsSql, rowsParams] = firstSql();
    const [countSql, countParams] = secondSql();

    expect(rowsSql).toContain(
      'WHERE UPPER(i.symbol) = $1 AND z.side = $2 AND z.pattern = $3 AND z.score >= $4'
    );
    expect(rowsSql).toContain('ORDER BY z.score ASC NULLS LAST, z.zone_id ASC');
    expect(rowsParams).toEqual(['RELIANCE', 'DEMAND', 'DBR', 70, 50, 100]);

    expect(countSql).toContain('WHERE UPPER(i.symbol) = $1');
    expect(countParams).toEqual(['RELIANCE', 'DEMAND', 'DBR', 70]);
  });

  test('an unknown sort key is rejected with 400 and never reaches SQL', async () => {
    const { status, body } = await call('sort=score;DROP TABLE zones&dir=asc');
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_QUERY');
    expect(body.error).toContain('sort must be one of');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('maps persisted rows into the zone DTO', async () => {
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce([zoneRow(7)])
      .mockResolvedValueOnce([{ n: 1 }]);

    const { body } = await call('instrumentId=42');

    expect(body.zones[0]).toMatchObject({
      zoneId: 7,
      instrumentId: 42,
      symbol: 'RELIANCE',
      timeframe: '1D',
      pattern: 'DBR',
      side: 'DEMAND',
      zoneLow: 98.5,
      zoneHigh: 101.5,
      score: 78,
      compositeScore: 81,
      distancePct: 1.25,
      lifecycleState: 'CONFIRMED_FRESH',
      touchCount: 0,
    });
    expect(body.zones[0].formationTs).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(body.hasMore).toBe(false);
  });

  test('is a read-only list endpoint: two SELECTs, no scan or mutation', async () => {
    await call('');
    expect(mockQuery).toHaveBeenCalledTimes(2);
    for (const [sql] of mockQuery.mock.calls as unknown as Array<[string, unknown[]]>) {
      expect(sql.trimStart().startsWith('SELECT')).toBe(true);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
    }
  });
});

function zoneRow(zoneId: number) {
  return {
    zone_id: zoneId,
    instrument_id: 42,
    symbol: 'RELIANCE',
    timeframe: '1D',
    pattern: 'DBR',
    side: 'DEMAND',
    base_start: '2026-08-28',
    base_end: '2026-08-29',
    leg_in_ts: '2026-08-27T00:00:00Z',
    leg_out_ts: '2026-09-01T00:00:00Z',
    zone_low: '98.5',
    zone_high: '101.5',
    proximal: '101.5',
    distal: '98.5',
    formation_ts: '2026-09-01T00:00:00Z',
    config_version: 1,
    score: '78',
    composite_score: '81',
    score_components: { base: 20 },
    distance_pct: '1.25',
    confluence_score: '60',
    opposition_risk: '20',
    data_quality_score: '5',
    lifecycle_state: 'CONFIRMED_FRESH',
    last_touch_ts: null,
    touch_count: 0,
    created_at: '2026-09-01T00:00:00Z',
  };
}
