/**
 * Tests for Nifty 500 constituent list.
 */

import { getNifty500FullSymbols, getNifty500Count, NIFTY500_LAST_UPDATED } from "@/lib/nifty500";

describe("Nifty500 constituent list", () => {
  it("has no duplicate symbols", () => {
    const symbols = getNifty500FullSymbols();
    const unique = new Set(symbols);
    expect(unique.size).toBe(symbols.length);
  });

  it("all symbols use NSE: prefix", () => {
    const symbols = getNifty500FullSymbols();
    expect(symbols.every((s) => s.startsWith("NSE:"))).toBe(true);
  });

  it("all symbol parts are uppercase", () => {
    const symbols = getNifty500FullSymbols();
    for (const sym of symbols) {
      const [, ticker] = sym.split(":");
      expect(ticker).toBe(ticker.toUpperCase());
    }
  });

  it("contains exactly the 500 official tradeable constituents", () => {
    expect(getNifty500Count()).toBe(500);
    // NSE includes a DUMMYHEG placeholder row in the CSV; it is not tradeable.
    expect(getNifty500FullSymbols()).not.toContain("NSE:DUMMYHEG");
  });

  it("includes known blue-chip stocks under their official NSE symbols", () => {
    const symbols = getNifty500FullSymbols();
    expect(symbols).toContain("NSE:RELIANCE");
    expect(symbols).toContain("NSE:INFY");
    expect(symbols).toContain("NSE:TCS");
    expect(symbols).toContain("NSE:HDFCBANK");
  });

  it("lastUpdated is a valid date string", () => {
    const d = new Date(NIFTY500_LAST_UPDATED);
    expect(d instanceof Date && !isNaN(d.getTime())).toBe(true);
  });
});
