/**
 * Incremental aggregation guards.
 *
 * Warm scans must only rebuild the latest stored period(s), but a historical
 * backfill that adds daily bars before the oldest aggregate must trigger one
 * full rebuild so backfilled history is never silently left out.
 */

const calls: Array<{ text: string; values: unknown[] }> = [];

jest.mock('@/lib/db', () => ({
  getDb: () => {
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return [];
    };
    (sql as any).query = async (text: string) => {
      calls.push({ text, values: [] });
      return [];
    };
    (sql as any).unsafe = (text: string) => ({ unsafe: text });
    return sql;
  },
}));

import { aggregateInstrument } from '@/lib/scanner/aggregation';

beforeEach(() => {
  calls.length = 0;
});

describe('aggregateInstrument', () => {
  test('re-aggregates all five daily-derived timeframes', async () => {
    await aggregateInstrument(408065);

    expect(calls).toHaveLength(5);
    // One chained INSERT per timeframe; no per-period round trips.
    for (const call of calls) {
      expect(call.text).toContain('INSERT INTO aggregated_candles');
      expect(call.text).toContain('ON CONFLICT (instrument_token, timeframe, period_start)');
      expect(call.values).toContain(408065);
    }
    const timeframes = calls.map((c) => c.values.find((v) => typeof v === 'string'));
    expect(timeframes).toEqual(['1W', '1M', '3M', '6M', '1Y']);
  });

  test('uses MAX(period_start) for warm runs and rebuilds when a backfill predates it', async () => {
    await aggregateInstrument(408065);

    for (const call of calls) {
      // Conditional cutoff: full rebuild only when the earliest daily candle is
      // older than the earliest stored aggregate.
      expect(call.text).toContain('SELECT MIN(candle_date)');
      expect(call.text).toContain('SELECT MIN(period_start)');
      expect(call.text).toContain('WHEN');
      expect(call.text).toContain('THEN DATE \'1900-01-01\'');
      expect(call.text).toContain('SELECT MAX(period_start)');
      expect(call.text).toContain('ELSE COALESCE');
    }
  });
});
