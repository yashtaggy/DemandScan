/**
 * `fetchCandlesForAllTimeframes` replaces the per-timeframe N+1 read that
 * dominated the DETECT_ZONES stage. These tests pin the SQL shape (one round
 * trip, newest window per timeframe, bound parameters) and the grouping /
 * ordering contract the orchestrator relies on.
 */

const mockQuery = jest.fn();

jest.mock('@/lib/db', () => ({
  getDb: jest.fn(() => {
    const sql: any = jest.fn();
    sql.query = (...args: unknown[]) => mockQuery(...args);
    return sql;
  }),
}));

import { fetchCandlesForAllTimeframes } from '@/lib/scanner/patterns';
import type { Timeframe } from '@/lib/scanner/types';

const ALL: Timeframe[] = ['1H', '4H', '1D', '1W', '1M', '3M', '6M', '1Y'];

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue([]);
});

describe('fetchCandlesForAllTimeframes', () => {
  test('reads every timeframe in a single round trip with bound parameters', async () => {
    await fetchCandlesForAllTimeframes(42, ALL);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [text, params] = mockQuery.mock.calls[0];

    expect(text).toContain('UNION ALL');
    expect(text).toContain('FROM hourly_candles');
    expect(text).toContain('is_session_complete = TRUE');
    expect(text).toContain('FROM four_hour_candles');
    expect(text).toContain('is_complete = TRUE');
    expect(text).toContain('FROM daily_candles');
    expect(text).toContain('FROM aggregated_candles');
    expect(text).toContain('ORDER BY timeframe, period_start ASC');

    // Instrument id and window size are parameters, not interpolated.
    expect(params).toEqual([42, 500, '1W', '1M', '3M', '6M', '1Y']);
    expect(text).not.toContain('42');
  });

  test('keeps the newest-window rule for each branch', async () => {
    await fetchCandlesForAllTimeframes(7, ['1H', '4H', '1D', '1W'], 250);

    const [text, params] = mockQuery.mock.calls[0];
    expect(text).toContain('ORDER BY candle_ts DESC');
    expect(text).toContain('ORDER BY session_ts DESC');
    expect(text).toContain('ORDER BY candle_date DESC');
    expect(text).toContain('ORDER BY period_start DESC');
    // Four branch limits, all bound.
    expect(text.match(/LIMIT \$2/g)).toHaveLength(4);
    expect(params).toEqual([7, 250, '1W']);
  });

  test('pins DATE-backed branches to UTC and maps them to timezone-independent instants', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        timeframe: '1D',
        instrument_token: 42,
        period_start: '2024-03-01T00:00:00.000Z',
        open: '10',
        high: '12',
        low: '9',
        close: '11',
        volume: '100',
      },
      {
        timeframe: '1W',
        instrument_token: 42,
        period_start: '2024-02-26T00:00:00.000Z',
        open: '10',
        high: '12',
        low: '9',
        close: '11',
        volume: '100',
      },
    ]);

    const candles = await fetchCandlesForAllTimeframes(42, ['1D', '1W']);

    const [text] = mockQuery.mock.calls[0];
    // Both the daily_candles and aggregated_candles DATE branches are cast.
    expect(text.match(/period_start::timestamp AT TIME ZONE 'UTC'/g)).toHaveLength(2);
    // The cast wraps the projected value; the index-friendly inner sort stays raw.
    expect(text).toContain('ORDER BY candle_date DESC');
    expect(text).toContain('ORDER BY period_start DESC');
    expect(text).toContain('ORDER BY timeframe, period_start ASC');

    // Exact UTC epochs, independent of the process timezone.
    expect(candles.get('1D')![0].date.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    expect(candles.get('1D')![0].date.getTime()).toBe(Date.UTC(2024, 2, 1));
    expect(candles.get('1W')![0].date.toISOString()).toBe('2024-02-26T00:00:00.000Z');
    expect(candles.get('1W')![0].date.getTime()).toBe(Date.UTC(2024, 1, 26));
  });

  test('groups rows into ascending candles per timeframe and returns empty buckets', async () => {
    mockQuery.mockResolvedValue([
      {
        timeframe: '1D',
        instrument_token: 42,
        period_start: '2024-01-01',
        open: '10',
        high: '12',
        low: '9',
        close: '11',
        volume: '100',
      },
      {
        timeframe: '1D',
        instrument_token: 42,
        period_start: '2024-01-02',
        open: '11',
        high: '13',
        low: '10',
        close: '12',
        volume: '200',
      },
      {
        timeframe: '1H',
        instrument_token: 42,
        period_start: '2024-01-02T09:15:00.000Z',
        open: '12',
        high: '12.5',
        low: '11.5',
        close: '12.2',
        volume: '50',
      },
    ]);

    const candles = await fetchCandlesForAllTimeframes(42, ALL);

    expect([...candles.keys()]).toEqual(ALL);
    expect(candles.get('1D')).toEqual([
      {
        instrumentId: 42,
        date: new Date('2024-01-01'),
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 100,
        source: 'db',
        isComplete: true,
      },
      {
        instrumentId: 42,
        date: new Date('2024-01-02'),
        open: 11,
        high: 13,
        low: 10,
        close: 12,
        volume: 200,
        source: 'db',
        isComplete: true,
      },
    ]);
    expect(candles.get('1H')).toHaveLength(1);
    expect(candles.get('1W')).toEqual([]);
    expect(candles.get('1Y')).toEqual([]);
  });

  test('returns empty buckets without querying when no timeframes are requested', async () => {
    const candles = await fetchCandlesForAllTimeframes(42, []);

    expect(mockQuery).not.toHaveBeenCalled();
    expect(candles.size).toBe(0);
  });
});
