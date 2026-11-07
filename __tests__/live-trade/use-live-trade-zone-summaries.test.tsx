/**
 * @jest-environment jsdom
 *
 * Independent zone summaries:
 *  - summaries load without instrument ids (the endpoint reads the owner's
 *    own board) and are exposed as a map;
 *  - a slower, older response can never overwrite a newer one;
 *  - disabling the hook clears the map so one owner's data cannot linger;
 *  - a failure keeps what was already loaded and reports the error.
 */

import { act, renderHook } from "@testing-library/react";
import { useLiveTradeZoneSummaries } from "@/hooks/use-live-trade-zone-summaries";

function summary(instrumentId: number, proximal: number) {
  return {
    instrumentId,
    symbol: `SYM${instrumentId}`,
    preferredTimeframe: "1D",
    coverage: "AVAILABLE",
    zoneFreshness: {
      freshnessThresholdDays: 7,
      latestCoveringScanAt: null,
      latestZoneFormationAt: null,
      latestZoneCreatedAt: null,
      zoneCount: 1,
      activeZoneCount: 1,
    },
    nearestDemand: {
      zoneId: `zone-${instrumentId}`,
      instrumentId,
      symbol: `SYM${instrumentId}`,
      side: "DEMAND",
      timeframe: "1D",
      pattern: "DBR",
      zoneLow: proximal - 10,
      zoneHigh: proximal,
      proximal,
      distal: proximal - 10,
      formationScore: 60,
      lifecycleState: "CONFIRMED_FRESH",
      formationTs: "2026-11-04T00:00:00.000Z",
      createdAt: "2026-11-04T00:00:00.000Z",
      touchCount: 0,
      lastTouchTs: null,
      timeframeMatch: "PREFERRED",
      distancePercent: null,
      distanceBasis: "PROXIMAL",
    },
    nearestSupply: null,
  };
}

function envelope(summaries: unknown[]) {
  return {
    success: true,
    data: {
      summaries,
      expanded: null,
      timeframeContext: { hasOverride: false, value: null },
      freshnessThresholdDays: 7,
      generatedAt: "2026-11-06T09:29:00.000Z",
    },
  };
}

function ok(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  };
}

function failure(status: number, code: string, message: string) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ success: false, code, error: message }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

test("loads every owned instrument's summary into a map", async () => {
  fetchMock.mockResolvedValueOnce(
    ok(envelope([summary(1, 100), summary(2, 200)]))
  );

  const { result } = renderHook(() => useLiveTradeZoneSummaries(true));
  expect(result.current.loading).toBe(true);
  await flush();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const url = String(fetchMock.mock.calls[0][0]);
  expect(url).toBe("/api/live-trade/zones");
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBeNull();
  expect([...result.current.summaries.keys()]).toEqual([1, 2]);
  expect(result.current.summaries.get(1)?.nearestDemand?.proximal).toBe(100);
});

test("a slow first response cannot overwrite a newer one", async () => {
  const first = deferred<unknown>();
  fetchMock
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(ok(envelope([summary(1, 300)])));

  const { result } = renderHook(() => useLiveTradeZoneSummaries(true));
  await flush();

  act(() => result.current.reload());
  await flush();
  expect(result.current.summaries.get(1)?.nearestDemand?.proximal).toBe(300);

  await act(async () => {
    first.resolve(ok(envelope([summary(1, 50)])));
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  expect(result.current.summaries.get(1)?.nearestDemand?.proximal).toBe(300);
});

test("disabling clears the map", async () => {
  fetchMock.mockResolvedValueOnce(ok(envelope([summary(1, 100)])));

  const { result, rerender } = renderHook(
    (props: { enabled: boolean }) => useLiveTradeZoneSummaries(props.enabled),
    { initialProps: { enabled: true } }
  );
  await flush();
  expect(result.current.summaries.size).toBe(1);

  rerender({ enabled: false });
  expect(result.current.summaries.size).toBe(0);
  expect(result.current.loading).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a failure keeps loaded summaries and reports the error", async () => {
  fetchMock
    .mockResolvedValueOnce(ok(envelope([summary(1, 100)])))
    .mockResolvedValueOnce(failure(500, "INTERNAL", "Server failed."));

  const { result } = renderHook(() => useLiveTradeZoneSummaries(true));
  await flush();
  expect(result.current.summaries.size).toBe(1);

  act(() => result.current.reload());
  await flush();

  expect(result.current.summaries.size).toBe(1);
  expect(result.current.loading).toBe(false);
  expect(result.current.error?.code).toBe("INTERNAL");
});
