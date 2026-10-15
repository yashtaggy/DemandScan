/**
 * Tests for lib/kite-client.ts (pure utility functions only)
 * buildStockRow, getNSEMarketStatus — no Kite API credentials required.
 */

import { buildStockRow, getNSEMarketStatus } from "@/lib/kite-client";
import type { Instrument, QuoteData } from "@/lib/types";

// ─── Mock data ────────────────────────────────────────────────────────────────

const mockInstrument: Instrument = {
  instrumentToken: 408065,
  exchangeToken: 1594,
  tradingSymbol: "INFY",
  name: "Infosys Limited",
  lastPrice: 1750.0,
  expiry: "",
  strike: 0,
  tickSize: 0.05,
  lotSize: 1,
  instrumentType: "EQ",
  segment: "NSE",
  exchange: "NSE",
};

const mockQuote: QuoteData = {
  instrumentToken: 408065,
  timestamp: "2024-10-14T10:30:00+05:30",
  lastTradeTime: "2024-10-14T10:29:55+05:30",
  lastPrice: 1785.5,
  lastQuantity: 50,
  buyQuantity: 12500,
  sellQuantity: 9800,
  volume: 2450000,
  averagePrice: 1770.25,
  ohlc: {
    open: 1760.0,
    high: 1800.0,
    low: 1755.0,
    close: 1750.0,
  },
  netChange: 35.5,
  oi: 0,
  oiDayHigh: 0,
  oiDayLow: 0,
  lowerCircuitLimit: 1575.0,
  upperCircuitLimit: 1925.0,
};

// ─── buildStockRow tests ──────────────────────────────────────────────────────

describe("buildStockRow", () => {
  it("builds a row with live quote data", () => {
    const row = buildStockRow("NSE:INFY", mockInstrument, mockQuote);

    expect(row.symbol).toBe("INFY");
    expect(row.exchange).toBe("NSE");
    expect(row.fullSymbol).toBe("NSE:INFY");
    expect(row.name).toBe("Infosys Limited");
    expect(row.lastPrice).toBe(1785.5);
    expect(row.hasQuote).toBe(true);
  });

  it("calculates change from previous close correctly", () => {
    const row = buildStockRow("NSE:INFY", mockInstrument, mockQuote);
    // previousClose = ohlc.close = 1750
    // change = 1785.5 - 1750 = 35.5
    expect(row.change).toBeCloseTo(35.5, 2);
    expect(row.previousClose).toBe(1750.0);
  });

  it("calculates changePercent correctly", () => {
    const row = buildStockRow("NSE:INFY", mockInstrument, mockQuote);
    // (35.5 / 1750) * 100 = 2.0286...
    expect(row.changePercent).toBeCloseTo(2.028, 2);
  });

  it("returns zero change when no quote is available", () => {
    const row = buildStockRow("NSE:INFY", mockInstrument, undefined);

    expect(row.hasQuote).toBe(false);
    expect(row.change).toBe(0);
    expect(row.changePercent).toBe(0);
    expect(row.volume).toBe(0);
  });

  it("handles zero previous close without dividing by zero", () => {
    const quoteWithZeroClose: QuoteData = {
      ...mockQuote,
      ohlc: { ...mockQuote.ohlc, close: 0 },
    };
    const row = buildStockRow("NSE:INFY", mockInstrument, quoteWithZeroClose);
    expect(row.changePercent).toBe(0);
  });

  it("correctly splits exchange and symbol from fullSymbol", () => {
    const row = buildStockRow("NSE:TATAMOTORS", { ...mockInstrument, tradingSymbol: "TATAMOTORS" }, undefined);
    expect(row.exchange).toBe("NSE");
    expect(row.symbol).toBe("TATAMOTORS");
  });
});

// ─── getNSEMarketStatus tests ─────────────────────────────────────────────────

describe("getNSEMarketStatus", () => {
  it("returns NSE as the exchange", () => {
    const status = getNSEMarketStatus();
    expect(status.exchange).toBe("NSE");
  });

  it("returns isOpen boolean", () => {
    const status = getNSEMarketStatus();
    expect(typeof status.isOpen).toBe("boolean");
  });

  it("returns a non-empty nextEvent string", () => {
    const status = getNSEMarketStatus();
    expect(status.nextEvent.length).toBeGreaterThan(0);
  });
});
