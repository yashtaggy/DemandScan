const mockQuery = jest.fn(async () => []);

jest.mock('@/lib/db', () => ({
  getDb: jest.fn(() => {
    const sql = async () => [];
    (sql as any).query = mockQuery;
    return sql;
  }),
}));

import { bulkUpsert } from '@/lib/scanner/bulk';

beforeEach(() => {
  mockQuery.mockClear();
});

describe('bulkUpsert', () => {
  test('does nothing for an empty row set', async () => {
    const written = await bulkUpsert({
      table: 'daily_candles',
      columns: ['a', 'b'],
      rows: [],
      conflictClause: 'ON CONFLICT DO NOTHING',
    });
    expect(written).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('binds every value with numbered placeholders and chunks rows', async () => {
    const written = await bulkUpsert({
      table: 'daily_candles',
      columns: ['instrument_id', 'candle_date', 'close'],
      rows: [
        [1, '2024-01-01', 100],
        [1, '2024-01-02', 101],
        [2, '2024-01-01', 50],
      ],
      conflictClause: 'ON CONFLICT (instrument_id, candle_date) DO NOTHING',
      chunkSize: 2,
    });

    expect(written).toBe(3);
    expect(mockQuery).toHaveBeenCalledTimes(2);

    const [firstText, firstParams] = mockQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(firstText).toBe(
      'INSERT INTO daily_candles (instrument_id, candle_date, close) VALUES ' +
        '($1, $2, $3), ($4, $5, $6) ' +
        'ON CONFLICT (instrument_id, candle_date) DO NOTHING'
    );
    expect(firstParams).toEqual([1, '2024-01-01', 100, 1, '2024-01-02', 101]);

    const [secondText, secondParams] = mockQuery.mock.calls[1] as unknown as [string, unknown[]];
    expect(secondText).toContain('VALUES ($1, $2, $3)');
    expect(secondParams).toEqual([2, '2024-01-01', 50]);
  });

  test('rejects rows whose width does not match the column list', async () => {
    await expect(
      bulkUpsert({
        table: 'daily_candles',
        columns: ['a', 'b'],
        rows: [[1, 2, 3]],
        conflictClause: 'ON CONFLICT DO NOTHING',
      })
    ).rejects.toThrow('row has 3 values, expected 2');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
