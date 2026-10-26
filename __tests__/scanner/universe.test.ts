/**
 * Unit tests for explicit Nifty 500 universe resolution and strict seeding.
 *
 * These guard the core V1 rule: a full scan runs the persisted official Nifty
 * 500 membership and NEVER falls back to every active NSE instrument.
 */

const mockQueryLog: Array<{ text: string; values?: unknown[] }> = [];
let mockInstrumentRows: any[] = [];
let mockInsertRows: any[] = [];
let mockUpdateRows: any[] = [];
let mockMembershipRows: any[] = [];

jest.mock('@/lib/db', () => ({
  getDb: () => {
    const sql: any = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = Array.isArray(strings)
        ? (strings as TemplateStringsArray).join('?')
        : String(strings);
      mockQueryLog.push({ text, values });
      if (text.includes('FROM nifty500_membership')) return mockMembershipRows;
      if (text.includes('INSERT INTO nifty500_membership')) return mockInsertRows;
      if (text.includes('UPDATE nifty500_membership')) return mockUpdateRows;
      return [];
    };
    sql.query = async (text: string, values: unknown[]) => {
      mockQueryLog.push({ text, values });
      if (text.includes('SELECT instrument_id, symbol, active FROM instruments')) {
        return mockInstrumentRows;
      }
      return [];
    };
    return sql;
  },
}));

import {
  assertUniversePlayable,
  listNifty500InstrumentIds,
  mapConstituentsToInstruments,
  seedNifty500Membership,
} from '@/lib/scanner/universe';
import {
  NIFTY500_MIN_EXPECTED,
  getNifty500Constituents,
  getNifty500Count,
  resolveNifty500Candidates,
  validateNifty500Source,
  type Nifty500Constituent,
} from '@/lib/nifty500';

function constituent(symbol: string): Nifty500Constituent {
  const found = getNifty500Constituents().find((c) => c.symbol === symbol);
  if (!found) throw new Error(`test fixture missing ${symbol}`);
  return found;
}

function instrumentRowsForAllConstituents(): any[] {
  return getNifty500Constituents().map((c, index) => ({
    instrument_id: 100000 + index,
    symbol: resolveNifty500Candidates(c)[0],
    active: true,
  }));
}

beforeEach(() => {
  mockQueryLog.length = 0;
  mockInstrumentRows = [];
  mockInsertRows = [];
  mockUpdateRows = [];
  mockMembershipRows = [];
});

describe('assertUniversePlayable', () => {
  const expected = getNifty500Count();

  test('refuses an empty universe and states there is no fallback', () => {
    expect(() => assertUniversePlayable(0, expected)).toThrow(
      /will not fall back to all NSE instruments/i
    );
    try {
      assertUniversePlayable(0, expected);
    } catch (err: any) {
      expect(err.permanent).toBe(true);
    }
  });

  test('refuses a universe below the official constituent count', () => {
    expect(() => assertUniversePlayable(expected - 1, expected)).toThrow(
      /Refusing to run a full scan on a partial universe/i
    );
  });

  test('accepts the complete universe', () => {
    expect(() => assertUniversePlayable(expected, expected)).not.toThrow();
  });

  test('does not reject extra manual members or assume exactly 500', () => {
    expect(() => assertUniversePlayable(expected + 1, expected)).not.toThrow();
    expect(() => assertUniversePlayable(650, expected)).not.toThrow();
  });
});

describe('validateNifty500Source', () => {
  test('accepts the official snapshot', () => {
    expect(() => validateNifty500Source()).not.toThrow();
    expect(getNifty500Count()).toBe(500);
  });

  test('rejects a partial source snapshot', () => {
    const partial = getNifty500Constituents().slice(0, NIFTY500_MIN_EXPECTED - 1);
    expect(() => validateNifty500Source(partial)).toThrow(/expected at least 500/);
  });

  test('rejects duplicate symbols', () => {
    const list = [...getNifty500Constituents()];
    list[1] = { ...list[1], symbol: list[0].symbol };
    expect(() => validateNifty500Source(list)).toThrow(/duplicate symbol/);
  });

  test('rejects duplicate ISINs', () => {
    const list = [...getNifty500Constituents()];
    list[1] = { ...list[1], isin: list[0].isin };
    expect(() => validateNifty500Source(list)).toThrow(/duplicate ISIN/);
  });

  test('rejects the NSE dummy placeholder', () => {
    const list = [
      ...getNifty500Constituents(),
      { symbol: 'DUMMYHEG', series: 'EQ' as const, isin: 'DUM545A01024', companyName: 'Dummy' },
    ];
    expect(() => validateNifty500Source(list)).toThrow(/placeholder DUMMYHEG/);
  });

  test('rejects malformed ISINs', () => {
    const list = [...getNifty500Constituents()];
    list[0] = { ...list[0], isin: 'BAD' };
    expect(() => validateNifty500Source(list)).toThrow(/invalid ISIN/);
  });
});

describe('mapConstituentsToInstruments', () => {
  test('maps a non-EQ series through the Kite suffix', () => {
    const mapping = mapConstituentsToInstruments(
      [constituent('HFCL')],
      [{ instrument_id: 5620225, symbol: 'HFCL-BE', active: true }]
    );
    expect(mapping.matched).toHaveLength(1);
    expect(mapping.matched[0].dbSymbol).toBe('HFCL-BE');
  });

  test('maps a renamed NSE symbol through the alias table', () => {
    const mapping = mapConstituentsToInstruments(
      [constituent('ICICIPRULI')],
      [{ instrument_id: 4774913, symbol: 'ICICILIFE', active: true }]
    );
    expect(mapping.matched).toHaveLength(1);
    expect(mapping.matched[0].instrumentId).toBe(4774913);
  });

  test('reports a missing instrument instead of guessing', () => {
    const mapping = mapConstituentsToInstruments([constituent('RELIANCE')], []);
    expect(mapping.missing.map((c) => c.symbol)).toEqual(['RELIANCE']);
    expect(mapping.matched).toHaveLength(0);
  });

  test('reports an inactive-only match', () => {
    const mapping = mapConstituentsToInstruments(
      [constituent('RELIANCE')],
      [{ instrument_id: 738561, symbol: 'RELIANCE', active: false }]
    );
    expect(mapping.inactive.map((c) => c.symbol)).toEqual(['RELIANCE']);
  });

  test('prefers the active instrument over an inactive symbol reuse', () => {
    const mapping = mapConstituentsToInstruments(
      [constituent('RELIANCE')],
      [
        { instrument_id: 1, symbol: 'RELIANCE', active: false },
        { instrument_id: 2, symbol: 'RELIANCE', active: true },
      ]
    );
    expect(mapping.matched).toHaveLength(1);
    expect(mapping.matched[0].instrumentId).toBe(2);
  });

  test('reports ambiguity when two active instruments match', () => {
    const mapping = mapConstituentsToInstruments(
      [constituent('ICICIPRULI')],
      [
        { instrument_id: 1, symbol: 'ICICIPRULI', active: true },
        { instrument_id: 2, symbol: 'ICICILIFE', active: true },
      ]
    );
    expect(mapping.ambiguous.map((a) => a.constituent.symbol)).toEqual(['ICICIPRULI']);
    expect(mapping.matched).toHaveLength(0);
  });
});

describe('seedNifty500Membership', () => {
  test('seeds all 500 mapped constituents and is idempotent', async () => {
    mockInstrumentRows = instrumentRowsForAllConstituents();
    mockInsertRows = [{ instrument_id: 1 }];

    const first = await seedNifty500Membership();

    expect(first.seeded).toBe(1);
    expect(first.curated).toBe(500);
    expect(first.matched).toBe(500);
    expect(first.removed).toBe(0);
    expect(first.missingSymbols).toEqual([]);
    expect(first.inactiveSymbols).toEqual([]);
    expect(first.ambiguousSymbols).toEqual([]);
    expect(
      mockQueryLog.some((q) =>
        q.text.includes('ON CONFLICT (instrument_id, effective_from) DO NOTHING')
      )
    ).toBe(true);

    // Second run: insert conflicts, removed set empty.
    mockQueryLog.length = 0;
    mockInsertRows = [];
    mockUpdateRows = [];

    const second = await seedNifty500Membership();

    expect(second.seeded).toBe(0);
    expect(second.matched).toBe(500);
    expect(second.removed).toBe(0);
  });

  test('writes nothing when any constituent is missing', async () => {
    mockInstrumentRows = instrumentRowsForAllConstituents().slice(0, -1);

    await expect(seedNifty500Membership()).rejects.toThrow(/cannot be seeded: missing 1/);

    expect(mockQueryLog.some((q) => q.text.includes('INSERT INTO nifty500_membership'))).toBe(false);
    expect(mockQueryLog.some((q) => q.text.includes('UPDATE nifty500_membership'))).toBe(false);
  });

  test('writes nothing when a constituent is inactive', async () => {
    mockInstrumentRows = instrumentRowsForAllConstituents();
    mockInstrumentRows[0] = { ...mockInstrumentRows[0], active: false };

    await expect(seedNifty500Membership()).rejects.toThrow(/inactive 1/);
    expect(mockQueryLog.some((q) => q.text.includes('INSERT INTO nifty500_membership'))).toBe(false);
  });

  test('writes nothing when a constituent is ambiguous', async () => {
    mockInstrumentRows = [
      ...instrumentRowsForAllConstituents(),
      { instrument_id: 999999, symbol: 'ICICIPRULI', active: true },
    ];

    await expect(seedNifty500Membership()).rejects.toThrow(/ambiguous 1/);
    expect(mockQueryLog.some((q) => q.text.includes('INSERT INTO nifty500_membership'))).toBe(false);
  });

  test('reports closed membership rows after an index refresh', async () => {
    mockInstrumentRows = instrumentRowsForAllConstituents();
    mockUpdateRows = [{ instrument_id: 42 }];

    const result = await seedNifty500Membership();

    expect(result.removed).toBe(1);
  });
});

describe('listNifty500InstrumentIds', () => {
  test('returns deduplicated numeric instrument ids', async () => {
    mockMembershipRows = [
      { instrument_id: '101' },
      { instrument_id: 102 },
      { instrument_id: '101' },
    ];

    const ids = await listNifty500InstrumentIds();

    expect(ids).toEqual([101, 102]);
    const query = mockQueryLog.find((q) => q.text.includes('FROM nifty500_membership'))?.text ?? '';
    expect(query).toContain('effective_to IS NULL');
    expect(query).toContain('i.active = TRUE');
  });
});
