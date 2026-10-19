// ─── Scanner domain types — DemandScan v1 ────────────────────────────────────

export interface Instrument {
  instrumentId: number; // Kite token
  symbol: string;
  exchange: string;
  companyName?: string;
  active: boolean;
  source?: string;
  updatedAt: Date;
}

export interface Candle {
  instrumentId: number;
  date: Date; // UTC Date representing bar open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
  /** Only relevant for 4H candles — false means PM/short session, excluded from zone formation */
  isComplete?: boolean;
}

// ─── Timeframe identifiers ───────────────────────────────────────────────────
//
// Internal identifiers — do NOT confuse:
//   "1H"  = 60-minute bars fetched from Kite (60minute interval)
//   "4H"  = 4-hour bars aggregated locally from 1H (AM session only for zones)
//   "1D"  = Daily bars fetched from Kite (day interval)
//   "1W"–"1Y" = Aggregated from daily candles using IST calendar
//
// "1M" = Monthly (NOT 1-minute).  There is NO 1-minute timeframe in this scanner.
// "6M" = Half-yearly (NOT 6-minute).
export type Timeframe = "1H" | "4H" | "1D" | "1W" | "1M" | "3M" | "6M" | "1Y";

/** Timeframes that are aggregated from a lower source (excludes raw fetched ones). */
export type AggregationTimeframe = "4H" | "1W" | "1M" | "3M" | "6M" | "1Y";

/** Timeframes fetched directly from Kite. */
export type KiteFetchTimeframe = "1H" | "1D";

export interface AggregatedCandle {
  instrumentToken: number;
  timeframe: AggregationTimeframe;
  periodStart: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Zone patterns ───────────────────────────────────────────────────────────

export type Pattern = "DBR" | "RBR" | "RBD" | "DBD";

export type ZoneSide = "DEMAND" | "SUPPLY";

export type LifecycleState =
  | "CONFIRMED_FRESH"
  | "TOUCHED_ONCE"
  | "RETESTED"
  | "BROKEN";

// ─── Composite score components (v1 — 100-point total) ──────────────────────
//
// Component weights (documented, not empirically optimal):
//   Timeframe quality:     max 20  (1Y=20, 6M=17, 3M=14, 1M=11, 1W=8, 4H=5, 1D=3, 1H=1)
//   Leg-out body ratio:    max 15  (body/range of leg-out, normalised)
//   Base tightness:        max 15  (1 - avg body/range of base candles, normalised)
//   Volume surge:          max 10  (leg-out volume / 20-bar avg, capped)
//   Freshness / visits:    max 10  (FRESH=10, TOUCHED=5, RETESTED=2, BROKEN=0)
//   Zone age / recency:    max 5   (<30d=5, <90d=3, <180d=1, older=0)
//   Distance from price:   max 5   (<0.5%=5, <1%=4, <2%=3, <5%=1, >5%=0)
//   Multi-TF confluence:   max 10  (from confluence engine, normalised to 10)
//   Opposing-zone room:    max 5   (inverted opposition risk, normalised to 5)
//   Data quality:          max 5   (full=5, gaps=0–4, unavailable=component skipped)
//   ─────────────────────────────────────────────────────────────────────────
//   TOTAL:                 100 pts
//
// When inputs are unavailable (e.g. no current price), the component is null
// and isComplete=false. Missing components are listed in missingComponents[].
export interface ScoreComponents {
  timeframeQuality: number;          // 0–20
  legOutBodyRatio: number;           // 0–15
  baseTightness: number;             // 0–15
  volumeSurge: number;               // 0–10
  freshness: number;                 // 0–10
  zoneAge: number;                   // 0–5
  distanceFromPrice: number | null;  // 0–5, null if current price unavailable
  confluenceScore: number;           // 0–10
  opposingZoneRoom: number;          // 0–5
  dataQuality: number;               // 0–5
  isComplete: boolean;
  missingComponents: string[];
}

// ─── Zone ────────────────────────────────────────────────────────────────────

export interface Zone {
  zoneId: string;
  instrumentId: number;
  symbol?: string;
  timeframe: Timeframe;
  pattern: Pattern;
  side: ZoneSide;
  baseStart: Date;
  baseEnd: Date;
  legInTs: Date;
  legOutTs: Date;
  zoneLow: number;
  zoneHigh: number;
  proximal: number;
  distal: number;
  formationTs: Date;
  configVersion: number;
  /** Formation score only (0–100). Always present. Kept separate from compositeScore. */
  score: number;
  /** Composite score (0–100). Null until a price snapshot is available. */
  compositeScore?: number | null;
  /** Per-component breakdown. Null until computed. */
  scoreComponents?: ScoreComponents | null;
  /** Distance from current price to proximal (%). Null if price unavailable. */
  distancePct?: number | null;
  confluenceScore?: number;
  oppositionRisk?: number;
  dataQualityScore?: number;
  lifecycleState: LifecycleState;
  lastTouchTs?: Date;
  touchCount: number;
  createdAt: Date;
}

// ─── Candle coverage ─────────────────────────────────────────────────────────

export interface CandleCoverage {
  instrumentId: number;
  symbol?: string;
  timeframe: Timeframe;
  firstCandle: Date | null;
  lastCandle: Date | null;
  totalCandles: number;
  missingGaps: number;
  lastUpdated: Date;
}

// ─── Scanner config ───────────────────────────────────────────────────────────

export interface ScannerConfig {
  version: number;
  thresholds: {
    minBaseCandles: number;
    maxBaseCandles: number;
    baseBodyRatio: number;
    legOutBodyRatio: number;
    legOutRangeMultiplier: number;
    freshZoneScoreBonus: number; // legacy field, kept for backward compat
    proximalBuffer: number;
    weights: {
      timeframeQuality: number;   // max 20
      legOutBodyRatio: number;    // max 15
      baseTightness: number;      // max 15
      volumeSurge: number;        // max 10
      freshness: number;          // max 10
      zoneAge: number;            // max 5
      distanceFromPrice: number;  // max 5
      confluenceScore: number;    // max 10
      opposingZoneRoom: number;   // max 5
      dataQuality: number;        // max 5
    };
  };
}

/** Default scanner configuration — v1 (composite scoring, 8 timeframes) */
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  version: 2,
  thresholds: {
    minBaseCandles: 1,
    maxBaseCandles: 3,
    baseBodyRatio: 0.5,
    legOutBodyRatio: 0.5,
    legOutRangeMultiplier: 1.5,
    freshZoneScoreBonus: 0,
    proximalBuffer: 0.003,
    weights: {
      timeframeQuality: 20,
      legOutBodyRatio: 15,
      baseTightness: 15,
      volumeSurge: 10,
      freshness: 10,
      zoneAge: 5,
      distanceFromPrice: 5,
      confluenceScore: 10,
      opposingZoneRoom: 5,
      dataQuality: 5,
    },
  },
};

// ─── Pattern match ───────────────────────────────────────────────────────────

export interface PatternMatch {
  instrumentId: number;
  timeframe: Timeframe;
  pattern: Pattern;
  side: ZoneSide;
  legInIndex: number;
  baseStartIndex: number;
  baseEndIndex: number;
  legOutIndex: number;
  zoneLow: number;
  zoneHigh: number;
}
