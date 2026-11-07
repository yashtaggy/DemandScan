/**
 * Kite quote adapter tests.
 *
 * Kite is mocked; the real `getQuotes` mapping runs. These tests cover the two
 * boundary behaviours Live Trade depends on:
 *  - timestamps leave the adapter as correct UTC ISO strings even when the SDK
 *    converted a 19-character IST wall clock to a `Date`;
 *  - one malformed entry cannot fail the whole batch.
 */

jest.mock("kiteconnect", () => ({
  KiteConnect: jest.fn(),
}));

jest.mock("@/lib/env", () => ({
  getKiteApiKey: () => "test-api-key",
}));

import { KiteConnect } from "kiteconnect";
import { getQuotes } from "@/lib/kite-client";

const KiteConnectMock = KiteConnect as unknown as jest.Mock;
const getQuote = jest.fn();
const setAccessToken = jest.fn();

beforeEach(() => {
  getQuote.mockReset();
  setAccessToken.mockReset();
  KiteConnectMock.mockImplementation(() => ({ setAccessToken, getQuote }));
});

function rawQuote(overrides: Record<string, unknown> = {}) {
  return {
    instrument_token: 1,
    timestamp: "2026-11-06 09:28:41",
    last_trade_time: "2026-11-06 09:28:41",
    last_price: 100,
    last_quantity: 1,
    buy_quantity: 1,
    sell_quantity: 1,
    volume: 1,
    average_price: 100,
    net_change: 1,
    ohlc: { open: 100, high: 101, low: 99, close: 99 },
    ...overrides,
  };
}

describe("getQuotes", () => {
  it("normalizes string and SDK Date wall clocks to the same UTC instant", async () => {
    getQuote.mockResolvedValue({
      "NSE:INFY": rawQuote(),
      "NSE:TCS": rawQuote({
        timestamp: new Date(2026, 10, 6, 9, 28, 41),
        last_trade_time: new Date(2026, 10, 6, 9, 28, 41),
      }),
    });

    const result = await getQuotes("access-token", ["NSE:INFY", "NSE:TCS"]);

    expect(result.get("NSE:INFY")?.timestamp).toBe(
      "2026-11-06T03:58:41.000Z"
    );
    expect(result.get("NSE:INFY")?.lastTradeTime).toBe(
      "2026-11-06T03:58:41.000Z"
    );
    expect(result.get("NSE:TCS")?.timestamp).toBe(
      "2026-11-06T03:58:41.000Z"
    );
    expect(result.get("NSE:TCS")?.lastTradeTime).toBe(
      "2026-11-06T03:58:41.000Z"
    );
    expect(setAccessToken).toHaveBeenCalledWith("access-token");
  });

  it("keeps valid entries when another entry is malformed", async () => {
    getQuote.mockResolvedValue({
      "NSE:INFY": rawQuote(),
      "NSE:NO_OHLC": rawQuote({ ohlc: null, timestamp: "2026-11-06T03:58:41Z" }),
      "NSE:NULL": null,
      "NSE:TEXT": "not a quote",
    });

    const result = await getQuotes("access-token", [
      "NSE:INFY",
      "NSE:NO_OHLC",
      "NSE:NULL",
      "NSE:TEXT",
    ]);

    expect(result.get("NSE:INFY")?.lastPrice).toBe(100);
    expect(result.get("NSE:NO_OHLC")).toMatchObject({
      lastPrice: 100,
      timestamp: "2026-11-06T03:58:41.000Z",
      ohlc: { open: 0, high: 0, low: 0, close: 0 },
    });
    expect(result.has("NSE:NULL")).toBe(false);
    expect(result.has("NSE:TEXT")).toBe(false);
  });

  it("returns an empty map for a request with no symbols", async () => {
    const result = await getQuotes("access-token", []);
    expect(result.size).toBe(0);
    expect(getQuote).not.toHaveBeenCalled();
  });
});
