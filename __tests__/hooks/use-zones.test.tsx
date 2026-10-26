/**
 * @jest-environment jsdom
 *
 * `useZones` sends the Formation Score floor on the initial request and guards
 * against stale in-flight responses so a Reset cannot be overwritten by a
 * slower request started with the old filters.
 */

import { act, renderHook } from '@testing-library/react';
import {
  DEFAULT_SCANNER_FILTERS,
  useZones,
  type ZoneFilters,
} from '@/hooks/use-zones';

interface PendingFetch {
  url: string;
  signal: AbortSignal | null;
  resolve: (body: unknown) => void;
}

const mockFetch = jest.fn();
const pending: PendingFetch[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  pending.length = 0;
  mockFetch.mockReset();
  mockFetch.mockImplementation(
    (url: string, init?: RequestInit) =>
      new Promise((resolve) => {
        pending.push({
          url,
          signal: init?.signal ?? null,
          resolve: (body) =>
            resolve({ ok: true, json: async () => body } as Response),
        });
      })
  );
  (globalThis as any).fetch = mockFetch;
});

afterEach(() => {
  jest.useRealTimers();
});

async function advanceDebounce() {
  await act(async () => {
    jest.advanceTimersByTime(250);
  });
}

async function resolveFetch(index: number, body: unknown) {
  await act(async () => {
    pending[index].resolve(body);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useZones — default Formation Score', () => {
  test('initial default query requests minScore=50 with default sort', async () => {
    const { result } = renderHook(() => useZones(DEFAULT_SCANNER_FILTERS));

    // Debounced — no request on the very first tick.
    expect(mockFetch).not.toHaveBeenCalled();

    await advanceDebounce();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pending[0].url).toContain('minScore=50');
    expect(pending[0].url).toContain('sort=score');
    expect(pending[0].url).toContain('dir=desc');

    await resolveFetch(0, { zones: [{ zoneId: 'z1' }], count: 1 });
    expect(result.current.zones).toEqual([{ zoneId: 'z1' }]);
    expect(result.current.count).toBe(1);
    expect(result.current.loading).toBe(false);
  });

  test('an explicit minScore=0 is preserved in the request', async () => {
    renderHook(() => useZones({ ...DEFAULT_SCANNER_FILTERS, minScore: 0 }));

    await advanceDebounce();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(pending[0].url).toContain('minScore=0');
  });
});

describe('useZones — stale response guard', () => {
  test('a slow response from the previous filters cannot overwrite reset results', async () => {
    const staleFilters: ZoneFilters = {
      ...DEFAULT_SCANNER_FILTERS,
      symbol: 'OLD',
    };
    const { result, rerender } = renderHook(
      ({ filters }: { filters: ZoneFilters }) => useZones(filters),
      { initialProps: { filters: staleFilters } }
    );

    await advanceDebounce();
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toContain('symbol=OLD');

    // Reset applies the shared defaults while the first request is in flight.
    rerender({ filters: { ...DEFAULT_SCANNER_FILTERS } });

    // The stale request resolves late; its rows must be discarded.
    await resolveFetch(0, { zones: [{ zoneId: 'stale' }], count: 99 });
    expect(result.current.zones).toEqual([]);
    expect(result.current.count).toBe(0);

    // Only the reset query is issued next, and its result wins.
    await advanceDebounce();
    expect(pending).toHaveLength(2);
    expect(pending[1].url).not.toContain('symbol=');
    expect(pending[1].url).toContain('minScore=50');

    await resolveFetch(1, { zones: [{ zoneId: 'fresh' }], count: 1 });
    expect(result.current.zones).toEqual([{ zoneId: 'fresh' }]);
    expect(result.current.count).toBe(1);
    expect(result.current.error).toBeNull();
  });

  test('a stale error cannot surface after newer filters were requested', async () => {
    const { result, rerender } = renderHook(
      ({ filters }: { filters: ZoneFilters }) => useZones(filters),
      {
        initialProps: {
          filters: { ...DEFAULT_SCANNER_FILTERS, symbol: 'OLD' },
        } as { filters: ZoneFilters },
      }
    );

    await advanceDebounce();
    rerender({ filters: { ...DEFAULT_SCANNER_FILTERS } });

    // Simulate the stale request failing after it was superseded.
    await act(async () => {
      pending[0].resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: 'stale failure' }),
      } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.error).toBeNull();
  });
});
