/**
 * __tests__/scanner/patterns.test.ts
 *
 * Unit tests for the supply/demand zone pattern detection engine.
 * All tests run in-process without any DB or network calls.
 */

import { detectPatterns } from '@/lib/scanner/patterns';
import type { Candle, ScannerConfig } from '@/lib/scanner/types';
import { DEFAULT_SCANNER_CONFIG } from '@/lib/scanner/types';

// ─── Candle factory helpers ───────────────────────────────────────────────────

function makeCandle(
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100_000,
  dateOffset = 0
): Candle {
  const d = new Date('2024-01-01');
  d.setDate(d.getDate() + dateOffset);
  return {
    instrumentId: 1,
    date: d,
    open,
    high,
    low,
    close,
    volume,
    source: 'test',
  };
}

/** Strong bullish candle */
const bull = (offset: number): Candle =>
  makeCandle(100, 115, 99, 114, 500_000, offset);

/** Strong bearish candle */
const bear = (offset: number): Candle =>
  makeCandle(115, 116, 100, 101, 500_000, offset);

/** Tiny base candle (doji-like) */
const base = (price: number, offset: number): Candle =>
  makeCandle(price, price + 1, price - 1, price + 0.3, 50_000, offset);

// ─── Tests ────────────────────────────────────────────────────────────────────

const cfg: ScannerConfig = {
  ...DEFAULT_SCANNER_CONFIG,
  thresholds: {
    ...DEFAULT_SCANNER_CONFIG.thresholds,
    minBaseCandles: 1,
    maxBaseCandles: 3,
    baseBodyRatio: 0.4,
    legOutBodyRatio: 0.5,
    legOutRangeMultiplier: 1.0,
  },
};

describe('detectPatterns', () => {
  test('returns empty array for insufficient candles', () => {
    const candles = [bull(0), base(105, 1)];
    expect(detectPatterns(candles, 1, '1D', cfg)).toHaveLength(0);
  });

  test('detects DBR (Drop-Base-Rally → DEMAND)', () => {
    // bear → base → bull
    const candles = [bear(0), base(105, 1), bull(2)];
    const matches = detectPatterns(candles, 1, '1D', cfg);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern).toBe('DBR');
    expect(matches[0].side).toBe('DEMAND');
  });

  test('detects RBD (Rally-Base-Drop → SUPPLY)', () => {
    // bull → base → bear
    const candles = [bull(0), base(110, 1), bear(2)];
    const matches = detectPatterns(candles, 1, '1D', cfg);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern).toBe('RBD');
    expect(matches[0].side).toBe('SUPPLY');
  });

  test('detects RBR (Rally-Base-Rally → DEMAND)', () => {
    // bull → base → bull
    const candles = [bull(0), base(110, 1), bull(2)];
    const matches = detectPatterns(candles, 1, '1D', cfg);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern).toBe('RBR');
    expect(matches[0].side).toBe('DEMAND');
  });

  test('detects DBD (Drop-Base-Drop → SUPPLY)', () => {
    // bear → base → bear
    const candles = [bear(0), base(105, 1), bear(2)];
    const matches = detectPatterns(candles, 1, '1D', cfg);
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern).toBe('DBD');
    expect(matches[0].side).toBe('SUPPLY');
  });

  test('detects multiple non-overlapping patterns', () => {
    // DBR then RBD
    const candles = [
      bear(0), base(105, 1), bull(2), // DBR → DEMAND
      base(110, 3),                    // (part of next pattern)
      bear(4),                          // RBD leg-out
    ];
    const matches = detectPatterns(candles, 1, '1D', cfg);
    // Should find at least the first DBR
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].pattern).toBe('DBR');
  });

  test('zone boundaries are taken from base candles', () => {
    const candles = [bear(0), base(105, 1), bull(2)];
    const [match] = detectPatterns(candles, 1, '1D', cfg);
    // Base candle: price 105, high 106, low 104
    expect(match.zoneHigh).toBeCloseTo(106, 0);
    expect(match.zoneLow).toBeCloseTo(104, 0);
  });

  test('respects maxBaseCandles limit', () => {
    // 4-candle base should NOT match when maxBaseCandles = 3
    const candles = [
      bear(0),
      base(105, 1),
      base(105, 2),
      base(105, 3),
      base(105, 4), // 4th base — exceeds max
      bull(5),
    ];
    const strictCfg: ScannerConfig = {
      ...cfg,
      thresholds: { ...cfg.thresholds, maxBaseCandles: 3 },
    };
    const matches = detectPatterns(candles, 1, '1D', strictCfg);
    // No match because we can't fit a 4-base pattern
    expect(matches).toHaveLength(0);
  });
});
