/**
 * lib/scanner/patterns.ts
 *
 * Supply & Demand zone pattern detection.
 *
 * Detects the four classic patterns on a sequence of OHLCV candles:
 *
 *   DBR  (Drop-Base-Rally)  → DEMAND zone
 *   RBR  (Rally-Base-Rally) → DEMAND zone  (continuation)
 *   RBD  (Rally-Base-Drop)  → SUPPLY zone
 *   DBD  (Drop-Base-Drop)   → SUPPLY zone  (continuation)
 *
 * ─── Pattern anatomy ────────────────────────────────────────────────────────
 *   Leg-in  : strong momentum candle before the base (direction depends on pattern)
 *   Base    : 1–N small-body, low-range candles (tight consolidation)
 *   Leg-out : strong momentum candle after the base (opposite / same direction)
 *
 * The function scans left→right and returns every non-overlapping match found.
 *
 * ─── Configurable thresholds (from ScannerConfig) ──────────────────────────
 *   minBaseCandles        : minimum number of base candles (default 1)
 *   maxBaseCandles        : maximum number of base candles (default 3)
 *   baseBodyRatio         : body/range must be ≤ this for a candle to qualify as base (default 0.5)
 *   legOutBodyRatio       : body/range must be ≥ this for leg-out (default 0.5)
 *   legOutRangeMultiplier : leg-out range must be ≥ N × avg base range (default 1.5)
 */

import type { Candle, ScannerConfig, PatternMatch, Pattern, ZoneSide, Timeframe } from './types';

// ─── Candle measurement helpers ──────────────────────────────────────────────

function range(c: Candle): number {
  return c.high - c.low;
}

function bodySize(c: Candle): number {
  return Math.abs(c.close - c.open);
}

function bodyRatio(c: Candle): number {
  const r = range(c);
  return r === 0 ? 0 : bodySize(c) / r;
}

/** True if this candle looks like a bullish impulse (strong up-move). */
function isBullish(c: Candle): boolean {
  return c.close > c.open;
}

/** True if this candle looks like a bearish impulse (strong down-move). */
function isBearish(c: Candle): boolean {
  return c.close < c.open;
}

/** True if the candle qualifies as a "base" (small body, low range). */
function isBase(c: Candle, cfg: ScannerConfig): boolean {
  return bodyRatio(c) <= cfg.thresholds.baseBodyRatio;
}

/** True if the candle qualifies as a strong leg-out. */
function isLegOut(
  c: Candle,
  avgBaseRange: number,
  cfg: ScannerConfig
): boolean {
  const br = bodyRatio(c);
  const rng = range(c);
  return (
    br >= cfg.thresholds.legOutBodyRatio &&
    rng >= cfg.thresholds.legOutRangeMultiplier * avgBaseRange
  );
}

// ─── Zone boundary helpers ──────────────────────────────────────────────────

/**
 * Compute the zone boundaries from the base candles.
 * Zone high = max(high) of base candles
 * Zone low  = min(low)  of base candles
 */
function zoneFromBase(
  candles: Candle[],
  baseStartIdx: number,
  baseEndIdx: number
): { zoneLow: number; zoneHigh: number } {
  let zoneLow = Infinity;
  let zoneHigh = -Infinity;
  for (let i = baseStartIdx; i <= baseEndIdx; i++) {
    if (candles[i].low < zoneLow) zoneLow = candles[i].low;
    if (candles[i].high > zoneHigh) zoneHigh = candles[i].high;
  }
  return { zoneLow, zoneHigh };
}

// ─── Core scan function ──────────────────────────────────────────────────────

/**
 * Scan an ordered (ASC by date) array of candles and return every pattern match.
 *
 * A match is only returned once (non-overlapping windows). After a match is
 * detected the scan index jumps past the leg-out candle.
 */
export function detectPatterns(
  candles: Candle[],
  instrumentId: number,
  timeframe: Timeframe,
  cfg: ScannerConfig
): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const { minBaseCandles, maxBaseCandles } = cfg.thresholds;
  const n = candles.length;

  // We need at least: 1 leg-in + minBaseCandles + 1 leg-out
  if (n < minBaseCandles + 2) return matches;

  let i = 0; // current leg-in candidate index

  while (i < n - minBaseCandles - 1) {
    const legIn = candles[i];
    const legInBullish = isBullish(legIn) && bodyRatio(legIn) >= cfg.thresholds.legOutBodyRatio;
    const legInBearish = isBearish(legIn) && bodyRatio(legIn) >= cfg.thresholds.legOutBodyRatio;

    if (!legInBullish && !legInBearish) {
      i++;
      continue;
    }

    // Try every base window length from min to max.
    let matched = false;
    for (let baseLen = minBaseCandles; baseLen <= maxBaseCandles; baseLen++) {
      const baseStartIdx = i + 1;
      const baseEndIdx = i + baseLen; // inclusive
      const legOutIdx = baseEndIdx + 1;

      if (legOutIdx >= n) break; // not enough candles

      // All base candles must qualify.
      const baseCandles = candles.slice(baseStartIdx, baseEndIdx + 1);
      if (!baseCandles.every((c) => isBase(c, cfg))) continue;

      // Average base range for leg-out multiplier check.
      const avgBaseRange =
        baseCandles.reduce((sum, c) => sum + range(c), 0) / baseCandles.length;

      const legOut = candles[legOutIdx];
      if (!isLegOut(legOut, avgBaseRange, cfg)) continue;

      const { zoneLow, zoneHigh } = zoneFromBase(candles, baseStartIdx, baseEndIdx);

      // Classify the pattern.
      let pattern: Pattern;
      let side: ZoneSide;

      if (legInBearish && isBullish(legOut)) {
        pattern = 'DBR';
        side = 'DEMAND';
      } else if (legInBullish && isBullish(legOut)) {
        pattern = 'RBR';
        side = 'DEMAND';
      } else if (legInBullish && isBearish(legOut)) {
        pattern = 'RBD';
        side = 'SUPPLY';
      } else if (legInBearish && isBearish(legOut)) {
        pattern = 'DBD';
        side = 'SUPPLY';
      } else {
        continue; // shouldn't happen
      }

      matches.push({
        instrumentId,
        timeframe,
        pattern,
        side,
        legInIndex: i,
        baseStartIndex: baseStartIdx,
        baseEndIndex: baseEndIdx,
        legOutIndex: legOutIdx,
        zoneLow,
        zoneHigh,
      });

      // Advance past the leg-out to avoid overlap.
      i = legOutIdx + 1;
      matched = true;
      break;
    }

    if (!matched) {
      i++;
    }
  }

  return matches;
}

// ─── Convenience: run pattern detection over fetched candle data ─────────────

import { getDb } from '@/lib/db';

/**
 * Fetch candles from DB for an instrument + timeframe and return all detected
 * pattern matches. Handles all eight supported timeframes:
 *
 *   1H  → hourly_candles (is_session_complete = TRUE only)
 *   4H  → four_hour_candles (is_complete = TRUE — AM sessions only)
 *   1D  → daily_candles
 *   1W/1M/3M/6M/1Y → aggregated_candles
 */
export async function detectPatternsForInstrument(
  instrumentId: number,
  timeframe: Timeframe,
  cfg: ScannerConfig,
  limit = 500
): Promise<PatternMatch[]> {
  const sql = getDb();
  let rows: any[];

  if (timeframe === '1H') {
    rows = await sql`
      SELECT instrument_id AS instrument_token,
             candle_ts     AS period_start,
             open, high, low, close, volume
      FROM hourly_candles
      WHERE instrument_id       = ${instrumentId}
        AND is_session_complete = TRUE
      ORDER BY candle_ts ASC
      LIMIT ${limit}
    `;
  } else if (timeframe === '4H') {
    // Only complete AM sessions are eligible for zone formation
    rows = await sql`
      SELECT instrument_id AS instrument_token,
             session_ts    AS period_start,
             open, high, low, close, volume
      FROM four_hour_candles
      WHERE instrument_id = ${instrumentId}
        AND is_complete   = TRUE
      ORDER BY session_ts ASC
      LIMIT ${limit}
    `;
  } else if (timeframe === '1D') {
    rows = await sql`
      SELECT instrument_id AS instrument_token,
             candle_date   AS period_start,
             open, high, low, close, volume
      FROM daily_candles
      WHERE instrument_id = ${instrumentId}
      ORDER BY candle_date ASC
      LIMIT ${limit}
    `;
  } else {
    rows = await sql`
      SELECT instrument_token,
             period_start,
             open, high, low, close, volume
      FROM aggregated_candles
      WHERE instrument_token = ${instrumentId}
        AND timeframe        = ${timeframe}
      ORDER BY period_start ASC
      LIMIT ${limit}
    `;
  }

  const candles: Candle[] = rows.map((r: any) => ({
    instrumentId: Number(r.instrument_token),
    date: new Date(r.period_start),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
    source: 'db',
    isComplete: true,
  }));

  return detectPatterns(candles, instrumentId, timeframe, cfg);
}
