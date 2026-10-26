/**
 * `persistDetectedZones` replaced one existence SELECT + one INSERT per zone
 * with one identity read per instrument batch plus a chunked multi-row insert.
 * These tests pin idempotence: existing identities and duplicates inside the
 * same batch must never be inserted twice.
 */

const mockTagged = jest.fn();
const mockQuery = jest.fn();

jest.mock('@/lib/db', () => ({
  getDb: jest.fn(() => {
    const sql: any = (...args: unknown[]) => mockTagged(...args);
    sql.query = (...args: unknown[]) => mockQuery(...args);
    return sql;
  }),
}));

import { persistDetectedZones, type DetectedZoneInput } from '@/lib/scanner/zones';
import type { Candle, PatternMatch } from '@/lib/scanner/types';
import { DEFAULT_SCANNER_CONFIG } from '@/lib/scanner/types';

const CANDLES: Candle[] = [
  {
    instrumentId: 1,
    date: new Date('2024-01-01T00:00:00.000Z'),
    open: 115,
    high: 116,
    low: 100,
    close: 101,
    volume: 500_000,
    source: 'test',
  },
  {
    instrumentId: 1,
    date: new Date('2024-01-02T00:00:00.000Z'),
    open: 105,
    high: 106,
    low: 104,
    close: 105.3,
    volume: 50_000,
    source: 'test',
  },
  {
    instrumentId: 1,
    date: new Date('2024-01-03T00:00:00.000Z'),
    open: 100,
    high: 115,
    low: 99,
    close: 114,
    volume: 1_000_000,
    source: 'test',
  },
];

function makeInput(overrides: Partial<PatternMatch> = {}): DetectedZoneInput {
  return {
    match: {
      instrumentId: 1,
      timeframe: '1D',
      pattern: 'DBR',
      side: 'DEMAND',
      legInIndex: 0,
      baseStartIndex: 1,
      baseEndIndex: 1,
      legOutIndex: 2,
      zoneLow: 104,
      zoneHigh: 106,
      ...overrides,
    },
    candles: CANDLES,
  };
}

function existingRow(match: PatternMatch) {
  return {
    instrument_id: match.instrumentId,
    timeframe: match.timeframe,
    pattern: match.pattern,
    base_start: CANDLES[match.baseStartIndex].date,
    base_end: CANDLES[match.baseEndIndex].date,
  };
}

beforeEach(() => {
  mockTagged.mockReset();
  mockQuery.mockReset();
  mockTagged.mockResolvedValue([]);
  mockQuery.mockResolvedValue([]);
});

describe('persistDetectedZones', () => {
  test('writes a new zone in one identity read and one multi-row insert', async () => {
    const input = makeInput();
    const result = await persistDetectedZones([input], DEFAULT_SCANNER_CONFIG, 1);

    expect(result).toEqual({ inserted: 1, skipped: 0 });

    // One scoped read of existing identities for the batch's instruments.
    expect(mockTagged).toHaveBeenCalledTimes(1);
    const readStrings = mockTagged.mock.calls[0][0] as string[];
    expect(readStrings.join('?')).toContain('FROM zones');
    expect(readStrings.join('?')).toContain('instrument_id = ANY(');
    expect(mockTagged.mock.calls[0][1]).toEqual([1]);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [text, params] = mockQuery.mock.calls[0];
    expect(text).toContain('INSERT INTO zones');
    expect(text).toContain('ON CONFLICT DO NOTHING');
    // 17 bound columns, one row.
    expect(params).toHaveLength(17);
    expect(params).toEqual(
      expect.arrayContaining([1, '1D', 'DBR', 'DEMAND', 104, 106, 1, 'CONFIRMED_FRESH', 0])
    );
    expect(params[4]).toEqual(CANDLES[1].date);
    expect(params[5]).toEqual(CANDLES[1].date);
    // Formation score is computed, not passed through.
    expect(typeof params[14]).toBe('number');
    expect(params[14]).toBeGreaterThan(0);
  });

  test('skips an already persisted identity without issuing an insert', async () => {
    const input = makeInput();
    mockTagged.mockResolvedValue([existingRow(input.match)]);

    const result = await persistDetectedZones([input], DEFAULT_SCANNER_CONFIG, 1);

    expect(result).toEqual({ inserted: 0, skipped: 1 });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('collapses duplicate identities within the same batch', async () => {
    const result = await persistDetectedZones(
      [makeInput(), makeInput(), makeInput({ pattern: 'RBR' })],
      DEFAULT_SCANNER_CONFIG,
      1
    );

    // DBR twice + RBR once → only two rows written, one duplicate skipped.
    expect(result).toEqual({ inserted: 2, skipped: 1 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toHaveLength(34);
  });

  test('mixes existing and new identities in one batch', async () => {
    const existing = makeInput({ pattern: 'RBD', side: 'SUPPLY' });
    mockTagged.mockResolvedValue([existingRow(existing.match)]);

    const result = await persistDetectedZones(
      [existing, makeInput({ pattern: 'DBD', side: 'SUPPLY' })],
      DEFAULT_SCANNER_CONFIG,
      2
    );

    expect(result).toEqual({ inserted: 1, skipped: 1 });
    const [text, params] = mockQuery.mock.calls[0];
    expect(text).toContain('INSERT INTO zones');
    expect(params).toHaveLength(17);
    expect(params).toContain('DBD');
    expect(params).not.toContain('RBD');
    expect(params).toContain(2); // config_version
  });

  test('does nothing for an empty input list', async () => {
    const result = await persistDetectedZones([], DEFAULT_SCANNER_CONFIG, 1);

    expect(result).toEqual({ inserted: 0, skipped: 0 });
    expect(mockTagged).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
