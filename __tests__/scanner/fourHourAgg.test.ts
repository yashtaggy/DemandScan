const mockQuery = jest.fn(async () => []);

jest.mock('@/lib/db', () => ({
  getDb: jest.fn(() => {
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('SELECT MAX(session_ts)')) {
        return [{
          last_ts: mockLastTs,
          first_session_ts: mockFirstSessionTs,
          first_hourly_ts: mockFirstHourlyTs,
        }];
      }
      if (text.includes('FROM hourly_candles')) {
        mockHourlyValues.push(values);
        mockHourlyTexts.push(text);
        return mockHourlyRows;
      }
      if (text.includes('candle_coverage')) {
        return [];
      }
      return [];
    };
    (sql as any).query = mockQuery;
    return sql;
  }),
}));

let mockLastTs: Date | null = null;
let mockFirstSessionTs: Date | null = null;
let mockFirstHourlyTs: Date | null = null;
let mockHourlyRows: any[] = [];
const mockHourlyValues: unknown[][] = [];
const mockHourlyTexts: string[] = [];

import { aggregate4HForInstrument } from '@/lib/scanner/four_hour_agg';

const INSTRUMENT_ID = 408065;

// IST 09:15 / 10:15 / 11:15 / 12:15 on 2024-01-15 in UTC.
function amBar(utcHour: number, o: number, h: number, l: number, c: number) {
  return {
    instrument_id: INSTRUMENT_ID,
    candle_ts: new Date(Date.UTC(2024, 0, 15, utcHour, 45, 0)),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1000,
  };
}

// IST 13:15 / 14:15 / 15:15 on 2024-01-15 in UTC (PM session, 3 bars).
function pmBar(utcHour: number) {
  return {
    instrument_id: INSTRUMENT_ID,
    candle_ts: new Date(Date.UTC(2024, 0, 15, utcHour, 45, 0)),
    open: 110,
    high: 111,
    low: 109,
    close: 110,
    volume: 500,
  };
}

beforeEach(() => {
  mockQuery.mockClear();
  mockHourlyValues.length = 0;
  mockHourlyTexts.length = 0;
  mockLastTs = null;
  mockFirstSessionTs = null;
  mockFirstHourlyTs = null;
  mockHourlyRows = [];
});

describe('aggregate4HForInstrument', () => {
  test('cold run reads all complete hourly candles', async () => {
    mockHourlyRows = [amBar(3, 100, 105, 99, 104)];

    await aggregate4HForInstrument(INSTRUMENT_ID);

    expect(mockHourlyTexts[0]).not.toContain('candle_ts >=');
    expect(mockHourlyTexts[0]).toContain('is_session_complete = TRUE');
    expect(mockHourlyValues[0]).toEqual([INSTRUMENT_ID]);
  });

  test('warm run starts at the last stored session (incremental)', async () => {
    mockLastTs = new Date('2024-01-15T03:45:00Z');
    mockFirstSessionTs = new Date('2024-01-15T03:45:00Z');
    mockFirstHourlyTs = new Date('2024-01-15T03:45:00Z');
    mockHourlyRows = [amBar(3, 100, 105, 99, 104)];

    await aggregate4HForInstrument(INSTRUMENT_ID);

    expect(mockHourlyTexts[0]).toContain('candle_ts >=');
    expect(mockHourlyValues[0][0]).toBe(INSTRUMENT_ID);
    expect(mockHourlyValues[0][1]).toEqual(new Date('2024-01-15T03:45:00Z'));
  });

  test('rebuilds from the start when a backfill added older hourly bars', async () => {
    mockLastTs = new Date('2024-01-15T03:45:00Z');
    mockFirstSessionTs = new Date('2024-01-15T03:45:00Z');
    mockFirstHourlyTs = new Date('2023-06-01T03:45:00Z'); // older than first session
    mockHourlyRows = [amBar(3, 100, 105, 99, 104)];

    await aggregate4HForInstrument(INSTRUMENT_ID);

    expect(mockHourlyTexts[0]).not.toContain('candle_ts >=');
  });

  test('accepts a string MAX(session_ts) from the Neon driver', async () => {
    mockLastTs = '2024-01-10T03:45:00Z' as any;
    mockHourlyRows = [amBar(3, 100, 105, 99, 104)];

    await aggregate4HForInstrument(INSTRUMENT_ID);

    expect(mockHourlyValues[0][1]).toEqual(new Date('2024-01-10T03:45:00Z'));
  });

  test('aggregates AM and PM sessions and writes them in ONE batched statement', async () => {
    mockHourlyRows = [
      amBar(3, 100, 105, 99, 104),
      amBar(4, 104, 110, 103, 109),
      amBar(5, 109, 112, 107, 108),
      amBar(6, 108, 111, 106, 111),
      pmBar(7),
      pmBar(8),
      pmBar(9),
    ];

    const written = await aggregate4HForInstrument(INSTRUMENT_ID);

    // Two groups (AM + PM) → one INSERT, not one per group or per candle.
    expect(written).toBe(2);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [text, params] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(text).toContain('INSERT INTO four_hour_candles');
    expect(text).toContain('ON CONFLICT (instrument_id, session_ts)');

    // 10 columns × 2 rows.
    expect(params).toHaveLength(20);

    const am = params.slice(0, 10);
    expect(am).toEqual([
      INSTRUMENT_ID,
      new Date('2024-01-15T03:45:00Z'),
      'AM',
      100,
      112,
      99,
      111,
      4000,
      4,
      true,
    ]);

    const pm = params.slice(10);
    expect(pm).toEqual([
      INSTRUMENT_ID,
      new Date('2024-01-15T07:45:00Z'),
      'PM',
      110,
      111,
      109,
      110,
      1500,
      3,
      false,
    ]);
  });

  test('does not bulk-write when there are no complete hourly candles', async () => {
    const written = await aggregate4HForInstrument(INSTRUMENT_ID);
    expect(written).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
