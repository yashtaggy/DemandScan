/**
 * @jest-environment jsdom
 *
 * Quote polling contract:
 *  - one request at a time and no request inside the 5-second server floor;
 *  - automatic polling pauses while the document is hidden;
 *  - a 429 exposes a cooldown and never retries in a tight loop;
 *  - a 401 stops polling and labels retained data sign-in required;
 *  - any other failure retains the snapshot as stale without touching board
 *    data (this hook never reads the board).
 */

import { act, renderHook } from "@testing-library/react";
import { useLiveTradeQuotes } from "@/hooks/use-live-trade-quotes";

function quoteEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      quotes: [
        {
          instrumentId: 1,
          symbol: "INFY",
          lastPrice: 1505.25,
          change: 12.5,
          changePercent: 0.8375,
          lastTradedAt: "2026-11-06T09:28:41.000Z",
          fetchedAt: "2026-11-06T09:29:00.000Z",
          freshness: "LIVE",
          errorCode: null,
          nearestDemand: null,
          nearestSupply: null,
        },
      ],
      zonesAvailable: true,
      market: {
        isOpen: true,
        exchange: "NSE",
        approximation: "NSE regular session",
      },
      cooldownSeconds: 5,
      requestedInstruments: 1,
      fetchedAt: "2026-11-06T09:29:00.000Z",
      ...overrides,
    },
  };
}

function errorEnvelope(
  status: number,
  code: string,
  message: string,
  retryAfter?: number
) {
  return {
    ok: false,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "retry-after" && retryAfter !== undefined
          ? String(retryAfter)
          : null,
    },
    json: async () => ({
      success: false,
      error: message,
      code,
      details:
        retryAfter === undefined ? undefined : { retryAfterSeconds: retryAfter },
    }),
  };
}

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-06T09:29:00.000Z"));
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("useLiveTradeQuotes", () => {
  test("loads quotes and polls again after 30 seconds", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(quoteEnvelope()))
      .mockResolvedValueOnce(okResponse(quoteEnvelope()));

    const { result } = renderHook(() =>
      useLiveTradeQuotes([1], true)
    );

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    expect(firstUrl).toContain("/api/live-trade/quotes");
    expect(firstUrl).toContain("instrumentIds=1");
    expect(result.current.quotes[1].lastPrice).toBe(1505.25);
    expect(result.current.displayState).toBe("current");
    expect(result.current.fetchedAt).toBe("2026-11-06T09:29:00.000Z");

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does not overlap requests or poll inside the cooldown floor", async () => {
    let resolveInitial: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveInitial = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { result } = renderHook(() => useLiveTradeQuotes([1], true));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.refresh();
      result.current.refresh();
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInitial(okResponse(quoteEnvelope()));
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(result.current.quotes[1].lastPrice).toBe(1505.25);
  });

  test("starts a five-second cooldown after a successful request", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(quoteEnvelope()))
      .mockResolvedValueOnce(okResponse(quoteEnvelope()));

    const { result } = renderHook(() => useLiveTradeQuotes([1], true));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.cooldownSecondsLeft).toBe(5);

    act(() => result.current.refresh());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(result.current.cooldownSecondsLeft).toBe(4);

    await act(async () => {
      jest.advanceTimersByTime(3_999);
    });
    expect(result.current.cooldownSecondsLeft).toBe(1);

    await act(async () => {
      jest.advanceTimersByTime(1);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(result.current.cooldownSecondsLeft).toBe(0);

    act(() => result.current.refresh());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second success restarts the window.
    expect(result.current.cooldownSecondsLeft).toBe(5);
  });

  test("keeps polling after 30 seconds even though the cooldown has expired", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(quoteEnvelope()))
      .mockResolvedValueOnce(okResponse(quoteEnvelope()));

    renderHook(() => useLiveTradeQuotes([1], true));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(5_000);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(25_000);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("aborts the in-flight request and stops timers on unmount", async () => {
    let resolveInitial: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveInitial = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);

    const { unmount } = renderHook(() => useLiveTradeQuotes([1], true));
    await flush();

    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal?.aborted).toBe(false);
    unmount();
    expect(init.signal?.aborted).toBe(true);

    await act(async () => {
      resolveInitial(okResponse(quoteEnvelope()));
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a 429 exposes the retry-after cooldown and never tight-retries", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(quoteEnvelope()))
      .mockResolvedValueOnce(
        errorEnvelope(429, "QUOTE_COOLDOWN", "Wait before refreshing.", 3)
      );

    const { result } = renderHook(() => useLiveTradeQuotes([1], true));
    await flush();

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.error?.code).toBe("QUOTE_COOLDOWN");
    expect(result.current.displayState).toBe("stale");
    expect(result.current.cooldownSecondsLeft).toBeGreaterThan(0);

    act(() => result.current.refresh());
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a 401 stops automatic polling and marks retained data sign-in required", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(quoteEnvelope()))
      .mockResolvedValueOnce(
        errorEnvelope(401, "TOKEN_EXPIRED", "Your session expired.")
      );

    const { result } = renderHook(() => useLiveTradeQuotes([1], true));
    await flush();

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(result.current.displayState).toBe("sign-in");
    expect(result.current.quotes[1]).toBeDefined();

    await act(async () => {
      jest.advanceTimersByTime(120_000);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a failed refresh keeps the previous snapshot as stale", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(quoteEnvelope()))
      .mockResolvedValueOnce(
        errorEnvelope(502, "QUOTE_FETCH_FAILED", "Provider unavailable.")
      );

    const { result } = renderHook(() => useLiveTradeQuotes([1], true));
    await flush();

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(result.current.displayState).toBe("stale");
    expect(result.current.quotes[1].lastPrice).toBe(1505.25);
    expect(result.current.error?.code).toBe("QUOTE_FETCH_FAILED");
  });

  test("pauses while the document is hidden and resumes when visible", async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse(quoteEnvelope()))
      .mockResolvedValueOnce(okResponse(quoteEnvelope()));

    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });

    const { result } = renderHook(() => useLiveTradeQuotes([1], true));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await act(async () => {
      jest.advanceTimersByTime(120_000);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibility = "visible";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.displayState).toBe("current");
    expect(result.current.quotes[1]).toBeDefined();
  });
});
