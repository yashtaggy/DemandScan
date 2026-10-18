/**
 * __tests__/scanner/zones.test.ts
 *
 * Unit tests for zone scoring logic (no DB required).
 */

import { scoreZone } from '@/lib/scanner/zones';
import type { Candle, ScannerConfig, PatternMatch } from '@/lib/scanner/types';
import { DEFAULT_SCANNER_CONFIG } from '@/lib/scanner/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCandle(
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100_000,
  offset = 0
): Candle {
  const d = new Date('2024-01-01');
  d.setDate(d.getDate() + offset);
  return { instrumentId: 1, date: d, open, high, low, close, volume, source: 'test' };
}

const cfg: ScannerConfig = {
  ...DEFAULT_SCANNER_CONFIG,
  thresholds: {
    ...DEFAULT_SCANNER_CONFIG.thresholds,
    freshZoneScoreBonus: 20,
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('scoreZone', () => {
  const candles: Candle[] = [
    makeCandle(115, 116, 100, 101, 500_000, 0), // leg-in (bear)
    makeCandle(105, 106, 104, 105.3, 50_000, 1), // base
    makeCandle(100, 115, 99, 114, 1_000_000, 2), // leg-out (bull – volume surge)
  ];

  const match: PatternMatch = {
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
  };

  test('returns a number between 0 and 100', () => {
    const score = scoreZone(match, candles, cfg, true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  test('fresh zone has higher score than non-fresh', () => {
    const fresh = scoreZone(match, candles, cfg, true);
    const stale = scoreZone(match, candles, cfg, false);
    expect(fresh).toBeGreaterThan(stale);
  });

  test('higher timeframe yields higher base score', () => {
    const daily = scoreZone({ ...match, timeframe: '1D' }, candles, cfg, false);
    const monthly = scoreZone({ ...match, timeframe: '1M' }, candles, cfg, false);
    expect(monthly).toBeGreaterThan(daily);
  });

  test('volume surge adds extra points', () => {
    // candles[2] has 1_000_000 volume vs avg of 500_000 → 2× surge
    const withSurge = scoreZone(match, candles, cfg, false);
    const lowVolCandles = candles.map((c, i) =>
      i === 2 ? { ...c, volume: 100_000 } : c
    );
    const withoutSurge = scoreZone(match, lowVolCandles, cfg, false);
    expect(withSurge).toBeGreaterThan(withoutSurge);
  });
});
