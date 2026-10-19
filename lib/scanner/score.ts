/**
 * lib/scanner/score.ts
 *
 * Composite scoring engine — DemandScan v1 (100-point scale).
 *
 * Two separate scores are maintained:
 *
 * 1. FORMATION SCORE (stored in zones.score):
 *    Computed once at zone detection time from the formation candles.
 *    Covers: timeframe quality, leg-out body ratio, base tightness, volume surge.
 *    Does NOT depend on current market data.
 *
 * 2. COMPOSITE SCORE (stored in zones.composite_score):
 *    Computed on demand when current price data is available.
 *    Includes the formation components PLUS freshness, age, distance, confluence,
 *    opposing-zone room, and data quality.
 *    Stored with a full component breakdown in zones.score_components (JSONB).
 *
 * ─── Component weights (sum = 100) ────────────────────────────────────────────
 *   Timeframe quality       max 20   (1Y=20, 6M=17, 3M=14, 1M=11, 1W=8, 4H=5, 1D=3, 1H=1)
 *   Leg-out body ratio      max 15
 *   Base tightness          max 15
 *   Volume surge            max 10
 *   Freshness / visits      max 10
 *   Zone age                max 5
 *   Distance from price     max 5
 *   Multi-TF confluence     max 10
 *   Opposing-zone room      max 5
 *   Data quality            max 5
 *   ─────────────────────────────────────────────────────────────────────────
 *   TOTAL                   100
 *
 * All weights are explicitly labelled NOT empirically optimal.
 * Missing inputs (e.g. no current price) → component is null, isComplete = false.
 */

import type { Candle, PatternMatch, ScannerConfig, ScoreComponents, Timeframe, LifecycleState } from './types';

// ─── Timeframe quality map ────────────────────────────────────────────────────

const TF_QUALITY: Record<Timeframe, number> = {
  '1Y':  20,
  '6M':  17,
  '3M':  14,
  '1M':  11,
  '1W':  8,
  '4H':  5,
  '1D':  3,
  '1H':  1,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function bodyRatio(c: Candle): number {
  const r = c.high - c.low;
  return r === 0 ? 0 : Math.abs(c.close - c.open) / r;
}

// ─── Formation score (subset, for backward compat) ────────────────────────────

/**
 * Compute the formation-only score (0–100).
 * Uses only candle data available at detection time.
 * Returned as zones.score — kept separate from composite_score.
 */
export function computeFormationScore(
  match: PatternMatch,
  candles: Candle[],
  cfg: ScannerConfig
): number {
  const w = cfg.thresholds.weights;
  let score = 0;

  // 1. Timeframe quality (max 20)
  score += TF_QUALITY[match.timeframe] ?? 1;

  // 2. Leg-out body ratio (max 15)
  const legOut = candles[match.legOutIndex];
  const legOutBr = bodyRatio(legOut);
  score += clamp(Math.round(legOutBr * w.legOutBodyRatio), 0, w.legOutBodyRatio);

  // 3. Base tightness (max 15)
  const baseCandles = candles.slice(match.baseStartIndex, match.baseEndIndex + 1);
  const avgBaseBr = baseCandles.reduce((s, c) => s + bodyRatio(c), 0) / baseCandles.length;
  score += clamp(Math.round((1 - avgBaseBr) * w.baseTightness), 0, w.baseTightness);

  // 4. Volume surge (max 10)
  const histStart = Math.max(0, match.legOutIndex - 20);
  const histCandles = candles.slice(histStart, match.legOutIndex);
  if (histCandles.length > 0) {
    const avgVol = histCandles.reduce((s, c) => s + c.volume, 0) / histCandles.length;
    const surge = avgVol > 0 ? legOut.volume / avgVol : 1;
    score += clamp(Math.round((surge - 1) * (w.volumeSurge / 2)), 0, w.volumeSurge);
  }

  return clamp(score, 0, 100);
}

// ─── Full composite score ─────────────────────────────────────────────────────

export interface CompositeScoreInput {
  match: PatternMatch;
  candles: Candle[];
  cfg: ScannerConfig;
  lifecycleState: LifecycleState;
  touchCount: number;
  formationTs: Date;
  currentPrice: number | null;
  proximal: number;
  confluenceScore: number;        // 0–100 from confluence engine
  oppositionRisk: number;         // 0–100 from confluence engine
  dataQualityScore: number;       // 0–5 from coverage table
}

/**
 * Compute the full composite score (0–100) with per-component breakdown.
 * Returns ScoreComponents including isComplete and missingComponents.
 */
export function computeCompositeScore(input: CompositeScoreInput): {
  compositeScore: number;
  components: ScoreComponents;
} {
  const {
    match, candles, cfg, lifecycleState, touchCount,
    formationTs, currentPrice, proximal,
    confluenceScore, oppositionRisk, dataQualityScore,
  } = input;
  const w = cfg.thresholds.weights;
  const missing: string[] = [];

  // ── Formation components ───────────────────────────────────────────────────

  // 1. Timeframe quality (max 20)
  const tfQuality = TF_QUALITY[match.timeframe] ?? 1;

  // 2. Leg-out body ratio (max 15)
  const legOut = candles[match.legOutIndex];
  const legOutBr = bodyRatio(legOut);
  const legOutScore = clamp(Math.round(legOutBr * w.legOutBodyRatio), 0, w.legOutBodyRatio);

  // 3. Base tightness (max 15)
  const baseCandles = candles.slice(match.baseStartIndex, match.baseEndIndex + 1);
  const avgBaseBr = baseCandles.reduce((s, c) => s + bodyRatio(c), 0) / baseCandles.length;
  const tightnessScore = clamp(Math.round((1 - avgBaseBr) * w.baseTightness), 0, w.baseTightness);

  // 4. Volume surge (max 10)
  const histStart = Math.max(0, match.legOutIndex - 20);
  const histCandles = candles.slice(histStart, match.legOutIndex);
  let volumeSurgeScore = 0;
  if (histCandles.length > 0) {
    const avgVol = histCandles.reduce((s, c) => s + c.volume, 0) / histCandles.length;
    const surge = avgVol > 0 ? legOut.volume / avgVol : 1;
    volumeSurgeScore = clamp(Math.round((surge - 1) * (w.volumeSurge / 2)), 0, w.volumeSurge);
  }

  // ── Current condition components ───────────────────────────────────────────

  // 5. Freshness (max 10)
  const freshnessMap: Record<string, number> = {
    CONFIRMED_FRESH: w.freshness,
    TOUCHED_ONCE:    Math.round(w.freshness * 0.5),
    RETESTED:        Math.round(w.freshness * 0.2),
    BROKEN:          0,
  };
  const freshnessScore = freshnessMap[lifecycleState] ?? 0;

  // 6. Zone age (max 5)
  const ageMs = Date.now() - formationTs.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  let ageScore = 0;
  if      (ageDays < 30)  ageScore = w.zoneAge;
  else if (ageDays < 90)  ageScore = Math.round(w.zoneAge * 0.6);
  else if (ageDays < 180) ageScore = Math.round(w.zoneAge * 0.2);
  // else 0

  // 7. Distance from price (max 5)
  let distanceFromPriceScore: number | null = null;
  let distancePct: number | null = null;
  if (currentPrice !== null && proximal > 0) {
    distancePct = Math.abs((currentPrice - proximal) / proximal) * 100;
    if      (distancePct < 0.5) distanceFromPriceScore = w.distanceFromPrice;
    else if (distancePct < 1.0) distanceFromPriceScore = Math.round(w.distanceFromPrice * 0.8);
    else if (distancePct < 2.0) distanceFromPriceScore = Math.round(w.distanceFromPrice * 0.6);
    else if (distancePct < 5.0) distanceFromPriceScore = Math.round(w.distanceFromPrice * 0.2);
    else                         distanceFromPriceScore = 0;
  } else {
    missing.push('distanceFromPrice');
  }

  // 8. Multi-TF confluence (max 10) — normalise from 0–100 to 0–10
  const confluenceNorm = clamp(Math.round(confluenceScore / 10), 0, w.confluenceScore);

  // 9. Opposing-zone room (max 5) — inverted opposition risk (0–100 → 0–5)
  const opposingRoomScore = clamp(Math.round((100 - oppositionRisk) / 20), 0, w.opposingZoneRoom);

  // 10. Data quality (max 5)
  const dataQualScore = clamp(dataQualityScore, 0, w.dataQuality);

  // ── Compute total ────────────────────────────────────────────────────────
  const distScore = distanceFromPriceScore ?? 0; // zero-substituted if missing
  const compositeScore = clamp(
    tfQuality + legOutScore + tightnessScore + volumeSurgeScore +
    freshnessScore + ageScore + distScore +
    confluenceNorm + opposingRoomScore + dataQualScore,
    0,
    100
  );

  const components: ScoreComponents = {
    timeframeQuality: tfQuality,
    legOutBodyRatio: legOutScore,
    baseTightness: tightnessScore,
    volumeSurge: volumeSurgeScore,
    freshness: freshnessScore,
    zoneAge: ageScore,
    distanceFromPrice: distanceFromPriceScore,
    confluenceScore: confluenceNorm,
    opposingZoneRoom: opposingRoomScore,
    dataQuality: dataQualScore,
    isComplete: missing.length === 0,
    missingComponents: missing,
  };

  return { compositeScore, components };
}
