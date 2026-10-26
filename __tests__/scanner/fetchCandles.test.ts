/**
 * Regression tests for the candle window used by zone detection.
 *
 * The previous implementation selected the OLDEST `LIMIT` rows (ORDER BY ts
 * ASC LIMIT n) and then detected patterns on them, so a long-history
 * instrument was scanned on stale candles. The window must now select the
 * NEWEST n rows and re-sort them ascending for detection.
 */

const calls: Array<{ text: string; values: unknown[] }> = [];

jest.mock('@/lib/db', () => ({
  getDb: jest.fn(() => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    return [];
  }),
}));

import { fetchCandlesForTimeframe } from '@/lib/scanner/patterns';
import type { Timeframe } from '@/lib/scanner/types';

const INSTRUMENT_ID = 408065;

beforeEach(() => {
  calls.length = 0;
});

function lastQuery() {
  expect(calls.length).toBe(1);
  return calls[0];
}

describe('fetchCandlesForTimeframe — newest window in ascending order', () => {
  test.each([
    ['1H', 'hourly_candles', 'candle_ts'],
    ['4H', 'four_hour_candles', 'session_ts'],
    ['1D', 'daily_candles', 'candle_date'],
  ] as Array<[Timeframe, string, string]>)(
    '%s reads %s newest-first inside the subquery and ascending outside',
    async (timeframe, table, tsColumn) => {
      calls.length = 0;
      await fetchCandlesForTimeframe(INSTRUMENT_ID, timeframe, 500);

      const { text, values } = lastQuery();
      expect(text).toContain(`FROM ${table}`);
      expect(text).toContain(`ORDER BY ${tsColumn} DESC`);
      expect(text).toContain('LIMIT ?');
      expect(text).toContain(') recent');
      expect(text).toContain('ORDER BY period_start ASC');
      // Instrument id and window size are bound, never interpolated.
      expect(values).toContain(INSTRUMENT_ID);
      expect(values).toContain(500);
      expect(text).not.toContain(String(INSTRUMENT_ID));
    }
  );

  test('1H excludes incomplete sessions', async () => {
    await fetchCandlesForTimeframe(INSTRUMENT_ID, '1H', 10);
    expect(lastQuery().text).toContain('is_session_complete = TRUE');
  });

  test('4H excludes incomplete (PM) sessions', async () => {
    await fetchCandlesForTimeframe(INSTRUMENT_ID, '4H', 10);
    expect(lastQuery().text).toContain('is_complete   = TRUE');
  });

  test.each(['1W', '1M', '3M', '6M', '1Y'] as Timeframe[])(
    '%s reads aggregated_candles for that timeframe',
    async (timeframe) => {
      calls.length = 0;
      await fetchCandlesForTimeframe(INSTRUMENT_ID, timeframe, 250);

      const { text, values } = lastQuery();
      expect(text).toContain('FROM aggregated_candles');
      expect(text).toContain('timeframe        = ?');
      expect(text).toContain('ORDER BY period_start DESC');
      expect(text).toContain('ORDER BY period_start ASC');
      expect(values).toEqual([INSTRUMENT_ID, timeframe, 250]);
    }
  );

  test('maps rows into Candle objects', async () => {
    const { getDb } = jest.requireMock('@/lib/db') as { getDb: jest.Mock };
    getDb.mockImplementationOnce(
      () => async () => [
        {
          instrument_token: 42,
          period_start: '2024-01-02',
          open: '100',
          high: '105',
          low: '99',
          close: '104',
          volume: '1000',
        },
      ]
    );

    const candles = await fetchCandlesForTimeframe(42, '1D');
    expect(candles).toEqual([
      {
        instrumentId: 42,
        date: new Date('2024-01-02'),
        open: 100,
        high: 105,
        low: 99,
        close: 104,
        volume: 1000,
        source: 'db',
        isComplete: true,
      },
    ]);
  });
});
