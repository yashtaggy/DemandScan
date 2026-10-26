import {
  parseZoneQuery,
  buildZoneWhere,
  DEFAULT_ZONE_LIMIT,
  MAX_ZONE_LIMIT,
  ZONE_SORT_COLUMNS,
} from '@/lib/scanner/zone-query';

function parse(qs: string) {
  return parseZoneQuery(new URLSearchParams(qs));
}

function expectOk(qs: string) {
  const result = parse(qs);
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.query;
}

function expectError(qs: string) {
  const result = parse(qs);
  if (result.ok) throw new Error(`expected error for ${qs}`);
  return result.error;
}

describe('parseZoneQuery defaults', () => {
  it('applies documented defaults for an empty query', () => {
    const q = expectOk('');
    expect(q.limit).toBe(DEFAULT_ZONE_LIMIT);
    expect(q.offset).toBe(0);
    expect(q.sort).toBe('composite_score');
    expect(q.dir).toBe('DESC');
    expect(q.sortColumn).toBe('z.composite_score');
    expect(q.symbol).toBeNull();
    expect(q.timeframe).toBeNull();
    expect(q.side).toBeNull();
    expect(q.pattern).toBeNull();
    expect(q.lifecycle).toBeNull();
    expect(q.instrumentId).toBeNull();
  });

  it('accepts a fully populated valid query', () => {
    const q = expectOk(
      'instrumentId=42&symbol=reliance&timeframe=1D&side=DEMAND&pattern=DBR' +
        '&lifecycle=CONFIRMED_FRESH&minScore=0&minCompositeScore=100' +
        '&maxDistancePct=2.5&minConfluence=0&maxOppositionRisk=100' +
        '&formationFrom=2026-01-01&formationTo=2026-01-31&limit=500&offset=1000' +
        '&sort=distance_pct&dir=asc'
    );
    expect(q.instrumentId).toBe(42);
    expect(q.symbol).toBe('RELIANCE');
    expect(q.timeframe).toBe('1D');
    expect(q.side).toBe('DEMAND');
    expect(q.pattern).toBe('DBR');
    expect(q.lifecycle).toBe('CONFIRMED_FRESH');
    expect(q.minScore).toBe(0);
    expect(q.minCompositeScore).toBe(100);
    expect(q.maxDistancePct).toBe(2.5);
    expect(q.formationFrom).toBe('2026-01-01');
    expect(q.formationTo).toBe('2026-01-31');
    expect(q.limit).toBe(MAX_ZONE_LIMIT);
    expect(q.offset).toBe(1000);
    expect(q.sortColumn).toBe('z.distance_pct');
    expect(q.dir).toBe('ASC');
  });
});

describe('parseZoneQuery rejects malformed input (no NaN reaches SQL)', () => {
  it.each([
    ['limit=abc', 'limit'],
    ['limit=0', 'limit'],
    [`limit=${MAX_ZONE_LIMIT + 1}`, 'limit'],
    ['limit=1.5', 'limit'],
    ['offset=-1', 'offset'],
    ['offset=1e9', 'offset'],
    ['instrumentId=abc', 'instrumentId'],
    ['instrumentId=0', 'instrumentId'],
    ['minScore=abc', 'minScore'],
    ['minScore=101', 'minScore'],
    ['minCompositeScore=-1', 'minCompositeScore'],
    ['minConfluence=abc', 'minConfluence'],
    ['maxOppositionRisk=101', 'maxOppositionRisk'],
    ['maxDistancePct=abc', 'maxDistancePct'],
    ['maxDistancePct=Infinity', 'maxDistancePct'],
  ])('rejects %s', (qs, field) => {
    expect(expectError(qs)).toContain(field);
  });

  it.each([
    'timeframe=5M',
    'side=BOTH',
    'pattern=XYZ',
    'lifecycle=FRESH',
  ])('rejects invalid enum %s', (qs) => {
    expect(expectError(qs)).toMatch(/must be one of/);
  });

  it.each([
    'symbol=A B',
    'symbol=REL;DROP TABLE zones',
    'symbol=' + 'A'.repeat(33),
    "symbol=REL'--",
  ])('rejects unsafe symbol %s', (qs) => {
    expect(expectError(qs)).toContain('symbol');
  });

  it.each([
    'formationFrom=2026-13-01',
    'formationFrom=2026-02-30',
    'formationTo=01-01-2026',
    'formationFrom=2026-02-01&formationTo=2026-01-01',
  ])('rejects invalid date range %s', (qs) => {
    expect(expectError(qs)).toMatch(/formation/i);
  });
});

describe('parseZoneQuery sorting cannot inject SQL', () => {
  it('rejects unknown sort keys instead of interpolating them', () => {
    expect(expectError('sort=z.score;DROP TABLE zones')).toContain('sort must be one of');
    expect(expectError('sort=scores')).toContain('sort must be one of');
  });

  it('only ever returns columns from the whitelist', () => {
    for (const key of Object.keys(ZONE_SORT_COLUMNS)) {
      const q = expectOk(`sort=${key}`);
      expect(Object.values(ZONE_SORT_COLUMNS)).toContain(q.sortColumn);
    }
  });

  it('rejects arbitrary directions and accepts case-insensitive asc/desc', () => {
    expect(expectOk('dir=asc').dir).toBe('ASC');
    expect(expectOk('dir=DESC').dir).toBe('DESC');
    expect(expectError('dir=ASC; DROP')).toContain('dir must be one of');
  });
});

describe('parseZoneQuery distinction between blank and invalid', () => {
  it('treats blank optional values as absent', () => {
    const q = expectOk('symbol=&timeframe=&side=&limit=&offset=&minScore=');
    expect(q.symbol).toBeNull();
    expect(q.timeframe).toBeNull();
    expect(q.side).toBeNull();
    expect(q.limit).toBe(DEFAULT_ZONE_LIMIT);
    expect(q.offset).toBe(0);
    expect(q.minScore).toBeNull();
  });
});

describe('buildZoneWhere', () => {
  it('emits no WHERE clause when no filters are set', () => {
    const where = buildZoneWhere(expectOk(''));
    expect(where.clause).toBe('');
    expect(where.params).toEqual([]);
  });

  it('emits only provided filters, in bind order, as $n parameters', () => {
    const where = buildZoneWhere(
      expectOk(
        'instrumentId=42&symbol=reliance&timeframe=4H&side=SUPPLY&pattern=RBD' +
          '&lifecycle=RETESTED&minScore=60&minCompositeScore=70&maxDistancePct=5' +
          '&minConfluence=30&maxOppositionRisk=40' +
          '&formationFrom=2026-01-01&formationTo=2026-03-01'
      )
    );

    expect(where.params).toEqual([
      42,
      'RELIANCE',
      '4H',
      'SUPPLY',
      'RBD',
      'RETESTED',
      60,
      70,
      5,
      30,
      40,
      '2026-01-01',
      '2026-03-01',
    ]);
    expect(where.clause).toContain('z.instrument_id = $1');
    expect(where.clause).toContain('UPPER(i.symbol) = $2');
    expect(where.clause).toContain('z.timeframe = $3');
    expect(where.clause).toContain('z.side = $4');
    expect(where.clause).toContain('z.pattern = $5');
    expect(where.clause).toContain('z.lifecycle_state = $6');
    expect(where.clause).toContain('z.score >= $7');
    expect(where.clause).toContain('z.composite_score >= $8');
    expect(where.clause).toContain('z.distance_pct <= $9');
    expect(where.clause).toContain('z.confluence_score >= $10');
    expect(where.clause).toContain('z.opposition_risk <= $11');
    expect(where.clause).toContain('z.formation_ts::date >= $12::date');
    expect(where.clause).toContain('z.formation_ts::date <= $13::date');
    expect(where.clause.startsWith('WHERE ')).toBe(true);
  });

  it('never interpolates values into the SQL text, even hostile ones', () => {
    const q = expectOk('instrumentId=1');
    q.symbol = "X' OR 1=1 --";
    const where = buildZoneWhere(q);
    expect(where.params).toContain("X' OR 1=1 --");
    expect(where.clause).not.toContain('OR 1=1');
    expect(where.clause).not.toContain("X'");
  });

  it('omits the OR-null preambles that block index use', () => {
    const { clause } = buildZoneWhere(expectOk('instrumentId=42&timeframe=1D'));
    expect(clause).not.toContain('IS NULL');
    expect(clause).toContain('AND');
  });
});
