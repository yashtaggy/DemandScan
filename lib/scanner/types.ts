// ─── Scanner domain types ────────────────────────────────────────────────────

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
  date: Date; // UTC date representing the trading day
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
}

export type Timeframe = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y";

/** Timeframes used in the aggregation engine (excludes raw daily "1D"). */
export type AggregationTimeframe = Exclude<Timeframe, "1D">;

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

export type Pattern = "DBR" | "RBR" | "RBD" | "DBD";

export type ZoneSide = "DEMAND" | "SUPPLY";

export type LifecycleState =
  | "CONFIRMED_FRESH"
  | "TOUCHED_ONCE"
  | "RETESTED"
  | "BROKEN";

export interface Zone {
  zoneId: string; // UUID string
  instrumentId: number;
  /** Populated when zones are joined with the instruments table. */
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
  proximal: number; // nearest price level to current market
  distal: number;   // furthest price level
  formationTs: Date;
  configVersion: number;
  score: number; // 0–100
  lifecycleState: LifecycleState;
  lastTouchTs?: Date;
  touchCount: number;
  createdAt: Date;
}

export interface ScannerConfig {
  version: number;
  thresholds: {
    minBaseCandles: number;      // min candles in base (tight consolidation)
    maxBaseCandles: number;      // max candles in base
    baseBodyRatio: number;       // max body/range ratio for base candle, e.g. 0.5
    legOutBodyRatio: number;     // min body/range ratio for leg-out, e.g. 0.5
    legOutRangeMultiplier: number; // leg-out range must be >= N * base avg range
    freshZoneScoreBonus: number; // extra score for untouched zones
    proximalBuffer: number;      // % buffer around proximal for touch detection
  };
}

/** Default scanner configuration */
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  version: 1,
  thresholds: {
    minBaseCandles: 1,
    maxBaseCandles: 3,
    baseBodyRatio: 0.5,
    legOutBodyRatio: 0.5,
    legOutRangeMultiplier: 1.5,
    freshZoneScoreBonus: 20,
    proximalBuffer: 0.003, // 0.3%
  },
};

export interface PatternMatch {
  instrumentId: number;
  timeframe: Timeframe;
  pattern: Pattern;
  side: ZoneSide;
  /** Index of the leg-in candle in the candle array */
  legInIndex: number;
  /** Index of the first base candle */
  baseStartIndex: number;
  /** Index of the last base candle */
  baseEndIndex: number;
  /** Index of the leg-out candle */
  legOutIndex: number;
  zoneLow: number;
  zoneHigh: number;
}
