/**
 * Central type definitions for DemandScan.
 * All market data types are derived from Kite Connect's documented API responses.
 */

// ─── Kite Session ─────────────────────────────────────────────────────────────

export interface KiteSession {
  accessToken: string;
  userId: string;
  userName: string;
  email: string;
  loginTime: string; // ISO string
  expiresAt: string; // ISO string — Kite tokens expire at 03:00 IST next day
}

// ─── Instruments ──────────────────────────────────────────────────────────────

export interface Instrument {
  instrumentToken: number;
  exchangeToken: number;
  tradingSymbol: string;
  name: string;
  lastPrice: number;
  expiry: string;
  strike: number;
  tickSize: number;
  lotSize: number;
  instrumentType: string;
  segment: string;
  exchange: string;
}

// ─── Quotes ───────────────────────────────────────────────────────────────────

export interface OHLCData {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DepthItem {
  price: number;
  quantity: number;
  orders: number;
}

export interface QuoteData {
  instrumentToken: number;
  timestamp: string;
  lastTradeTime: string;
  lastPrice: number;
  lastQuantity: number;
  buyQuantity: number;
  sellQuantity: number;
  volume: number;
  averagePrice: number;
  ohlc: OHLCData;
  netChange: number;
  oi: number;
  oiDayHigh: number;
  oiDayLow: number;
  lowerCircuitLimit: number;
  upperCircuitLimit: number;
  depth?: {
    buy: DepthItem[];
    sell: DepthItem[];
  };
}

// ─── Stock (enriched view used in the dashboard) ──────────────────────────────

export interface StockRow {
  symbol: string;        // e.g. "INFY"
  exchange: string;      // e.g. "NSE"
  fullSymbol: string;    // e.g. "NSE:INFY"
  name: string;          // Company name
  lastPrice: number;
  change: number;        // Absolute change from previous close
  changePercent: number; // Percentage change
  volume: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  lastUpdated: string;   // ISO timestamp of quote
  hasQuote: boolean;
}

// ─── API Response wrappers ────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: string;
  code?: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ─── Auth status ──────────────────────────────────────────────────────────────

export interface AuthStatus {
  authenticated: boolean;
  userId?: string;
  userName?: string;
  loginTime?: string;
  expiresAt?: string;
  sessionValid: boolean;
}

// ─── Scanner config (Phase 2 placeholder) ─────────────────────────────────────

export type Timeframe = "5m" | "15m" | "1h" | "1D";
export type ZoneType = "supply" | "demand";
export type ZoneStatus = "fresh" | "tested" | "broken";

export interface ScannerConfig {
  timeframe: Timeframe;
  zoneType: ZoneType | "both";
  zoneStatus: ZoneStatus | "all";
  minRiskReward: number;
}

// ─── Market status ────────────────────────────────────────────────────────────

export interface MarketStatus {
  isOpen: boolean;
  nextEvent: string; // "Opens at 09:15" | "Closes at 15:30"
  exchange: string;
}
