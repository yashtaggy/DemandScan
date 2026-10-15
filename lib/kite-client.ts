/**
 * Kite Connect client factory and market-data service.
 *
 * All methods in this module run on the server only.
 * The Kite access token is NEVER returned to browser code.
 *
 * Documented Kite Connect endpoints used:
 *  - POST /session/token         (generateSession)
 *  - GET  /quote                 (getQuote — batch, up to 500 instruments)
 *  - GET  /instruments/{exchange} (exchange-specific CSV)
 *
 * Reference: https://kite.trade/docs/connect/v3/
 */

import { KiteConnect } from "kiteconnect";
import type { Connect, Instrument as KiteInstrument } from "kiteconnect";
import { getKiteApiKey } from "./env";
import type { Instrument, QuoteData, StockRow } from "./types";

// ─── Client factory ───────────────────────────────────────────────────────────

/**
 * Create an authenticated KiteConnect instance.
 * The `Connect` type is the instance type returned by `new KiteConnect(...)`.
 */
export function createKiteClient(accessToken: string): Connect {
  const kc = new KiteConnect({ api_key: getKiteApiKey() });
  kc.setAccessToken(accessToken);
  return kc;
}

// ─── Raw Kite quote shape (getQuote returns unknown; we assert the shape) ──────

interface RawKiteQuote {
  instrument_token: number;
  timestamp: string;
  last_trade_time: string;
  last_price: number;
  last_quantity: number;
  buy_quantity: number;
  sell_quantity: number;
  volume: number;
  average_price: number;
  net_change: number;
  oi?: number;
  oi_day_high?: number;
  oi_day_low?: number;
  lower_circuit_limit?: number;
  upper_circuit_limit?: number;
  ohlc: {
    open: number;
    high: number;
    low: number;
    close: number;
  };
}

// ─── Instrument cache ─────────────────────────────────────────────────────────

interface InstrumentCache {
  instruments: Map<string, Instrument>; // key: "NSE:SYMBOL"
  loadedAt: Date;
}

let instrumentCache: InstrumentCache | null = null;
const INSTRUMENT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Fetch and cache the NSE instrument master from Kite.
 * Returns a Map keyed by "EXCHANGE:TRADINGSYMBOL" (e.g. "NSE:INFY").
 */
export async function getNSEInstruments(
  accessToken: string,
  forceRefresh = false
): Promise<Map<string, Instrument>> {
  const now = new Date();
  if (
    !forceRefresh &&
    instrumentCache &&
    now.getTime() - instrumentCache.loadedAt.getTime() < INSTRUMENT_CACHE_TTL_MS
  ) {
    return instrumentCache.instruments;
  }

  const kc = createKiteClient(accessToken);
  // getInstruments takes a single exchange string (Exchanges type), not an array
  const rawInstruments: KiteInstrument[] = await kc.getInstruments("NSE");

  const instruments = new Map<string, Instrument>();
  for (const raw of rawInstruments) {
    // Only include EQ segment instruments
    if (raw.segment !== "NSE" && raw.segment !== "NSE-EQ") continue;
    if (raw.instrument_type !== "EQ") continue;

    const key = `NSE:${raw.tradingsymbol}`;
    instruments.set(key, {
      // SDK returns instrument_token and exchange_token as strings
      instrumentToken: Number(raw.instrument_token),
      exchangeToken: Number(raw.exchange_token),
      tradingSymbol: raw.tradingsymbol,
      name: raw.name,
      lastPrice: raw.last_price,
      // SDK returns expiry as Date object
      expiry: raw.expiry instanceof Date ? raw.expiry.toISOString() : (raw.expiry ?? ""),
      strike: raw.strike ?? 0,
      tickSize: raw.tick_size,
      lotSize: raw.lot_size,
      instrumentType: raw.instrument_type,
      segment: raw.segment,
      exchange: raw.exchange,
    });
  }

  instrumentCache = { instruments, loadedAt: now };
  console.log(
    `[kite-client] Loaded ${instruments.size} NSE EQ instruments at ${now.toISOString()}`
  );
  return instruments;
}

export function getInstrumentCacheAge(): Date | null {
  return instrumentCache?.loadedAt ?? null;
}

// ─── Quote retrieval ──────────────────────────────────────────────────────────

/**
 * Fetch quotes for up to 500 instruments in a single Kite API call.
 * Kite's documented limit for /quote is 500 instruments per request.
 *
 * @param accessToken  Valid Kite access token
 * @param symbols      Array of "EXCHANGE:TRADINGSYMBOL" strings (e.g. ["NSE:INFY"])
 */
export async function getQuotes(
  accessToken: string,
  symbols: string[]
): Promise<Map<string, QuoteData>> {
  if (symbols.length === 0) return new Map();
  if (symbols.length > 500) {
    throw new Error("Kite /quote endpoint supports a maximum of 500 instruments per request.");
  }

  const kc = createKiteClient(accessToken);
  // getQuote returns Promise<unknown> in the SDK types — we assert the shape
  const raw = (await kc.getQuote(symbols)) as Record<string, RawKiteQuote>;

  const result = new Map<string, QuoteData>();
  for (const [symbol, q] of Object.entries(raw)) {
    result.set(symbol, {
      instrumentToken: q.instrument_token,
      timestamp: q.timestamp,
      lastTradeTime: q.last_trade_time,
      lastPrice: q.last_price,
      lastQuantity: q.last_quantity,
      buyQuantity: q.buy_quantity,
      sellQuantity: q.sell_quantity,
      volume: q.volume,
      averagePrice: q.average_price,
      ohlc: {
        open: q.ohlc.open,
        high: q.ohlc.high,
        low: q.ohlc.low,
        close: q.ohlc.close,
      },
      netChange: q.net_change,
      oi: q.oi ?? 0,
      oiDayHigh: q.oi_day_high ?? 0,
      oiDayLow: q.oi_day_low ?? 0,
      lowerCircuitLimit: q.lower_circuit_limit ?? 0,
      upperCircuitLimit: q.upper_circuit_limit ?? 0,
    });
  }

  return result;
}

// ─── Stock row builder ────────────────────────────────────────────────────────

/**
 * Merge instrument metadata + live quote into a StockRow for the dashboard.
 */
export function buildStockRow(
  fullSymbol: string,
  instrument: Instrument,
  quote: QuoteData | undefined
): StockRow {
  const [exchange, symbol] = fullSymbol.split(":");

  if (!quote) {
    return {
      symbol,
      exchange,
      fullSymbol,
      name: instrument.name,
      lastPrice: instrument.lastPrice,
      change: 0,
      changePercent: 0,
      volume: 0,
      open: 0,
      high: 0,
      low: 0,
      previousClose: 0,
      lastUpdated: "",
      hasQuote: false,
    };
  }

  const previousClose = quote.ohlc.close;
  const change = quote.lastPrice - previousClose;
  const changePercent =
    previousClose !== 0 ? (change / previousClose) * 100 : 0;

  return {
    symbol,
    exchange,
    fullSymbol,
    name: instrument.name,
    lastPrice: quote.lastPrice,
    change,
    changePercent,
    volume: quote.volume,
    open: quote.ohlc.open,
    high: quote.ohlc.high,
    low: quote.ohlc.low,
    previousClose,
    lastUpdated: quote.timestamp ?? new Date().toISOString(),
    hasQuote: true,
  };
}

// ─── Market status helper (no external API required) ─────────────────────────

/**
 * Determines NSE market status from the server clock.
 * NSE regular session: Monday–Friday, 09:15–15:30 IST.
 * This is an approximation; does not account for exchange holidays.
 */
export function getNSEMarketStatus(): {
  isOpen: boolean;
  nextEvent: string;
  exchange: string;
} {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const ist = new Date(now.getTime() + IST_OFFSET_MS);

  const day = ist.getUTCDay(); // 0 = Sunday, 6 = Saturday
  const hour = ist.getUTCHours();
  const minute = ist.getUTCMinutes();
  const timeInMinutes = hour * 60 + minute;

  const openMinutes = 9 * 60 + 15;   // 09:15
  const closeMinutes = 15 * 60 + 30; // 15:30

  const isWeekday = day >= 1 && day <= 5;
  const isDuringSession = timeInMinutes >= openMinutes && timeInMinutes < closeMinutes;
  const isOpen = isWeekday && isDuringSession;

  let nextEvent: string;
  if (!isWeekday) {
    nextEvent = "Opens Monday 09:15 IST";
  } else if (timeInMinutes < openMinutes) {
    nextEvent = "Opens at 09:15 IST";
  } else if (isOpen) {
    nextEvent = "Closes at 15:30 IST";
  } else {
    nextEvent = "Opens next trading day at 09:15 IST";
  }

  return { isOpen, nextEvent, exchange: "NSE" };
}
