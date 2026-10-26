/**
 * Regression guards for bulk ingestion: per-instrument failures must reject
 * the whole run instead of being swallowed and reported as success.
 */

const mockIngestDaily = jest.fn();

jest.mock('@/lib/db', () => ({
  getDb: () => {
    const sql = async () => [{ instrument_id: 1 }, { instrument_id: 2 }];
    (sql as any).query = async () => [];
    return sql;
  },
}));

jest.mock('@/lib/kite-client', () => ({ createKiteClient: jest.fn() }));

jest.mock('@/lib/scanner/candle_ingest', () => ({
  ingestDailyCandles: (...args: unknown[]) => mockIngestDaily(...args),
}));

import { ingestAllInstruments } from '@/lib/scanner/ingest_all';
import type { KiteSession } from '@/lib/types';

const session: KiteSession = {
  accessToken: 'token',
  userId: 'user',
  userName: 'User',
  email: 'u@example.com',
  loginTime: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ingestAllInstruments', () => {
  test('rejects when one instrument fails instead of returning a partial total', async () => {
    mockIngestDaily.mockImplementation(async (_s: unknown, id: number) => {
      if (id === 2) throw new Error('Too many requests');
      return 10;
    });

    await expect(
      ingestAllInstruments(session, new Date('2025-01-01'), new Date('2025-02-01'))
    ).rejects.toThrow(/1\/2 instrument\(s\) failed daily ingestion.*Too many requests/);
  });

  test('propagates a permanent error (auth/schema) as-is', async () => {
    const permanent: any = new Error('relation "daily_candles" does not exist');
    permanent.code = '42P01';
    mockIngestDaily.mockRejectedValue(permanent);

    await expect(
      ingestAllInstruments(session, new Date('2025-01-01'), new Date('2025-02-01'))
    ).rejects.toMatchObject({ code: '42P01' });
  });

  test('returns the total only when every instrument succeeded', async () => {
    mockIngestDaily.mockResolvedValue(10);

    const total = await ingestAllInstruments(
      session,
      new Date('2025-01-01'),
      new Date('2025-02-01')
    );

    expect(total).toBe(20);
  });
});
