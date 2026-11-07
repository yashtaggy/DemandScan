/**
 * @jest-environment jsdom
 *
 * Instrument search is debounced, never shows results for a superseded query,
 * and surfaces a safe error without inventing results.
 */

import { act, renderHook } from "@testing-library/react";
import { useInstrumentSearch } from "@/hooks/use-instrument-search";

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

function failureResponse() {
  return {
    ok: false,
    status: 500,
    headers: { get: () => null },
    json: async () => ({
      success: false,
      code: "INTERNAL",
      error: "Search is unavailable.",
    }),
  };
}

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

describe("useInstrumentSearch", () => {
  test("debounces the query and clears results when the query changes", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        success: true,
        data: {
          query: "infy",
          instruments: [
            {
              instrumentId: 1,
              symbol: "INFY",
              tradingSymbol: "INFY",
              name: "Infosys Limited",
              exchange: "NSE",
              active: true,
              updatedAt: null,
            },
          ],
          instrumentMaster: {
            latestInstrumentUpdateAt: null,
            activeInstrumentCount: 0,
            freshness: "unknown",
            stale: null,
          },
        },
      })
    );

    const { result, rerender } = renderHook(
      (props: { query: string }) => useInstrumentSearch(props.query, true, 300),
      { initialProps: { query: "infy" } }
    );

    expect(result.current.loading).toBe(true);
    await advance(299);
    expect(fetchMock).not.toHaveBeenCalled();

    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.results[0].symbol).toBe("INFY");
    expect(result.current.loading).toBe(false);

    rerender({ query: "infosys" });
    expect(result.current.results).toHaveLength(0);
    expect(result.current.loading).toBe(true);
  });

  test("returns a safe error and no results on failure", async () => {
    fetchMock.mockResolvedValueOnce(failureResponse());

    const { result } = renderHook(() =>
      useInstrumentSearch("infy", true, 300)
    );

    await advance(300);

    expect(result.current.error?.code).toBe("INTERNAL");
    expect(result.current.results).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });
});
