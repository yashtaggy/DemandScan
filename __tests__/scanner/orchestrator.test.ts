const mockFetchCandles = jest.fn();
const mockDetectPatterns = jest.fn();
const mockUpsertZone = jest.fn();
const mockListNifty500 = jest.fn();
const mockUpdateScanJob = jest.fn();

jest.mock('@/lib/db', () => ({ getDb: jest.fn() }));

jest.mock('@/lib/scanner/patterns', () => ({
  fetchCandlesForTimeframe: (...args: unknown[]) => mockFetchCandles(...args),
  detectPatterns: (...args: unknown[]) => mockDetectPatterns(...args),
}));

jest.mock('@/lib/scanner/zones', () => ({
  upsertZone: (...args: unknown[]) => mockUpsertZone(...args),
}));

jest.mock('@/lib/scanner/universe', () => ({
  listNifty500InstrumentIds: (...args: unknown[]) => mockListNifty500(...args),
  assertUniversePlayable: jest.fn(),
}));

jest.mock('@/lib/nifty500', () => ({ getNifty500Count: () => 500 }));

jest.mock('@/lib/scanner/instruments', () => ({ syncInstruments: jest.fn() }));
jest.mock('@/lib/scanner/ingest_all', () => ({ ingestAllInstruments: jest.fn() }));
jest.mock('@/lib/scanner/hourly_ingest', () => ({ ingestAllHourlyCandles: jest.fn() }));
jest.mock('@/lib/scanner/four_hour_agg', () => ({ aggregate4HForAll: jest.fn() }));
jest.mock('@/lib/scanner/aggregation', () => ({ aggregateAllTimeframes: jest.fn() }));
jest.mock('@/lib/scanner/lifecycle', () => ({
  updateZoneLifecycles: jest.fn(),
  buildLatestSnapshots: jest.fn(async () => []),
}));
jest.mock('@/lib/scanner/jobs', () => ({
  updateScanJob: (...args: unknown[]) => mockUpdateScanJob(...args),
}));

import {
  detectAndUpsertZonesForInstrument,
  runFullScan,
} from '@/lib/scanner/orchestrator';
import type { KiteSession } from '@/lib/types';
import type { Timeframe } from '@/lib/scanner/types';

const ALL: Timeframe[] = ['1H', '4H', '1D', '1W', '1M', '3M', '6M', '1Y'];
const CANDLES = [
  {
    instrumentId: 42,
    date: new Date('2026-09-01'),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    source: 'test',
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchCandles.mockImplementation(async (_id: number, tf: Timeframe) => [
    { ...CANDLES[0], source: tf },
  ]);
  mockDetectPatterns.mockReturnValue([{ pattern: 'DBR' }]);
  mockUpsertZone.mockResolvedValue(undefined);
});

describe('detectAndUpsertZonesForInstrument — all 8 timeframes', () => {
  test('fetches and detects every timeframe exactly once, in pipeline order', async () => {
    const result = await detectAndUpsertZonesForInstrument(42);

    const fetched = mockFetchCandles.mock.calls.map((c) => c[1]);
    expect(fetched).toEqual(ALL);
    expect(mockFetchCandles).toHaveBeenCalledTimes(8);
    expect(mockDetectPatterns).toHaveBeenCalledTimes(8);
    expect(mockUpsertZone).toHaveBeenCalledTimes(8);
    expect(result.failedTimeframes).toEqual([]);
    expect(result.outcomes.map((o) => o.status)).toEqual(ALL.map(() => 'OK'));

    for (const [index, tf] of ALL.entries()) {
      const candles = mockFetchCandles.mock.results[index].value;
      const resolved = await candles;
      // Detection and scoring share the exact same window (one fetch).
      expect(mockDetectPatterns.mock.calls[index][0]).toBe(resolved);
      expect(mockDetectPatterns.mock.calls[index][2]).toBe(tf);
      expect(mockUpsertZone.mock.calls[index][1]).toBe(resolved);
    }
  });

  test('a failed timeframe is reported explicitly and fails the instrument after attempting all 8', async () => {
    mockFetchCandles.mockImplementation(async (_id: number, tf: Timeframe) => {
      if (tf === '3M') throw new Error('aggregated_candles unavailable');
      return [{ ...CANDLES[0], source: tf }];
    });
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(detectAndUpsertZonesForInstrument(42)).rejects.toThrow(
      /3M=aggregated_candles unavailable/
    );

    // The remaining timeframes still ran; the caller decides to retry/fail.
    expect(mockFetchCandles).toHaveBeenCalledTimes(8);
    expect(mockDetectPatterns).toHaveBeenCalledTimes(7);
    expect(mockUpsertZone).toHaveBeenCalledTimes(7);

    const summary = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('instrument=42'));
    expect(summary).toContain('3M:FAILED');
    expect(summary).toContain('failed=1');

    const failure = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('timeframe=3M'));
    expect(failure).toContain('aggregated_candles unavailable');
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('marks a timeframe with no candles as NO_DATA without failing the instrument', async () => {
    mockFetchCandles.mockImplementation(async (_id: number, tf: Timeframe) =>
      tf === '1Y' ? [] : [{ ...CANDLES[0], source: tf }]
    );
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    const result = await detectAndUpsertZonesForInstrument(42);

    expect(mockDetectPatterns).toHaveBeenCalledTimes(7);
    const year = result.outcomes.find((o) => o.timeframe === '1Y');
    expect(year).toMatchObject({ status: 'NO_DATA', candles: 0, matches: 0 });
    expect(result.failedTimeframes).toEqual([]);
    infoSpy.mockRestore();
  });
});

describe('runFullScan — membership-only universe', () => {
  const session: KiteSession = {
    accessToken: 'token',
    userId: 'user',
    userName: 'User',
    email: 'u@example.com',
    loginTime: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };

  test('scans the persisted Nifty 500 membership, never every active instrument', async () => {
    mockListNifty500.mockResolvedValueOnce([3, 1, 2]);
    mockFetchCandles.mockResolvedValue([]);

    await runFullScan({
      jobId: 'job-1',
      session,
      fromDate: new Date('2025-01-01'),
      toDate: new Date('2025-12-31'),
    });

    expect(mockListNifty500).toHaveBeenCalledTimes(1);
    const detectedIds = [...new Set(mockFetchCandles.mock.calls.map((c) => c[0]))];
    expect(detectedIds.sort()).toEqual([1, 2, 3]);
    expect(mockUpdateScanJob).toHaveBeenLastCalledWith(
      'job-1',
      expect.objectContaining({ status: 'SUCCESS', progressPercent: 100 })
    );
  });

  test('marks the job FAILED when detection fails, instead of reporting SUCCESS', async () => {
    mockListNifty500.mockResolvedValueOnce([1]);
    mockFetchCandles.mockImplementation(async (_id: number, tf: Timeframe) => {
      if (tf === '4H') throw Object.assign(new Error('relation "four_hour_candles" does not exist'), { code: '42P01' });
      return [];
    });
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await runFullScan({
      jobId: 'job-2',
      session,
      fromDate: new Date('2025-01-01'),
      toDate: new Date('2025-12-31'),
    });

    expect(mockUpdateScanJob).toHaveBeenLastCalledWith(
      'job-2',
      expect.objectContaining({
        status: 'FAILED',
        errorMessage: expect.stringContaining('four_hour_candles'),
      })
    );
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
