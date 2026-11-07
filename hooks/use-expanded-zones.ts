"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getZones,
  isAbortError,
  LiveTradeClientError,
  type LiveTradeExpandedZoneDto,
  type LiveTradeZonesResponseDto,
} from "@/lib/live-trade/client";

type ExpandedPayload = NonNullable<LiveTradeZonesResponseDto["expanded"]>;
export type ExpandedZonePagination = ExpandedPayload["pagination"];

export interface UseExpandedZonesReturn {
  zones: LiveTradeExpandedZoneDto[];
  pagination: ExpandedZonePagination | null;
  loading: boolean;
  loadingMore: boolean;
  error: LiveTradeClientError | null;
  loadMore: () => void;
  retry: () => void;
}

const DEFAULT_PAGE_SIZE = 100;

interface ExpandedState {
  /** The instrument the stored pages belong to. */
  instrumentId: number | null;
  zones: LiveTradeExpandedZoneDto[];
  pagination: ExpandedZonePagination | null;
  error: LiveTradeClientError | null;
  /** A first-page retry for the current instrument. */
  requesting: boolean;
  loadingMore: boolean;
}

const EMPTY_STATE: ExpandedState = {
  instrumentId: null,
  zones: [],
  pagination: null,
  error: null,
  requesting: false,
  loadingMore: false,
};

/**
 * Paginated structural zones for exactly one instrument.
 *
 * Pages are requested on demand; the full zone table is never loaded at once.
 * BROKEN zones and any formation score remain visible because pagination does
 * not filter.
 */
export function useExpandedZones(
  instrumentId: number | null,
  enabled: boolean,
  pageSize: number = DEFAULT_PAGE_SIZE
): UseExpandedZonesReturn {
  const [state, setState] = useState<ExpandedState>(EMPTY_STATE);

  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const fetchPage = useCallback(
    async (id: number, offset: number, append: boolean) => {
      if (!enabled) return;

      const requestId = ++requestIdRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const data = await getZones(
          {
            instrumentIds: [id],
            includeExpanded: true,
            // The caller already has this instrument's summary; only the
            // expanded page is used, so skip the nearest/coverage reads.
            includeSummaries: false,
            limit: pageSize,
            offset,
          },
          controller.signal
        );

        if (requestId !== requestIdRef.current) return;
        const expanded = data.expanded;

        setState((previous) => {
          if (!expanded) {
            return {
              instrumentId: id,
              zones: [],
              pagination: null,
              error: null,
              requesting: false,
              loadingMore: false,
            };
          }

          let zones = expanded.zones;
          if (append && previous.instrumentId === id) {
            const seen = new Set(previous.zones.map((zone) => zone.zoneId));
            zones = [...previous.zones];
            for (const zone of expanded.zones) {
              if (seen.has(zone.zoneId)) continue;
              seen.add(zone.zoneId);
              zones.push(zone);
            }
          }

          return {
            instrumentId: id,
            zones,
            pagination: expanded.pagination,
            error: null,
            requesting: false,
            loadingMore: false,
          };
        });
      } catch (cause) {
        if (isAbortError(cause) || requestId !== requestIdRef.current) return;
        const error =
          cause instanceof LiveTradeClientError
            ? cause
            : new LiveTradeClientError(
                "Zones could not be loaded. Please try again.",
                { status: 0, code: "UNKNOWN" }
              );
        setState((previous) => ({
          instrumentId: id,
          zones: previous.instrumentId === id ? previous.zones : [],
          pagination:
            previous.instrumentId === id ? previous.pagination : null,
          error,
          requesting: false,
          loadingMore: false,
        }));
      }
    },
    [enabled, pageSize]
  );

  useEffect(() => {
    if (!enabled || instrumentId === null) {
      requestIdRef.current += 1;
      abortRef.current?.abort();
      return;
    }

    /* eslint-disable-next-line react-hooks/set-state-in-effect --
       Fetching the selected instrument's first page is the effect's purpose;
       loading is derived from the stored instrument id. */
    void fetchPage(instrumentId, 0, false);
    return () => {
      abortRef.current?.abort();
    };
  }, [instrumentId, enabled, fetchPage]);

  const current = state.instrumentId === instrumentId;
  const active = enabled && instrumentId !== null;

  const loadMore = useCallback(() => {
    if (
      instrumentId === null ||
      !current ||
      !state.pagination ||
      !state.pagination.hasMore ||
      state.requesting ||
      state.loadingMore
    ) {
      return;
    }
    const offset = state.pagination.offset + state.pagination.limit;
    if (offset + state.pagination.limit > state.pagination.batchLimit) return;

    setState((previous) => ({ ...previous, loadingMore: true, error: null }));
    void fetchPage(instrumentId, offset, true);
  }, [instrumentId, current, state, fetchPage]);

  const retry = useCallback(() => {
    if (instrumentId === null) return;
    setState((previous) => ({
      ...previous,
      requesting: true,
      error: null,
    }));
    void fetchPage(instrumentId, 0, false);
  }, [instrumentId, fetchPage]);

  return {
    zones: active && current ? state.zones : [],
    pagination: active && current ? state.pagination : null,
    loading: active && (!current || state.requesting),
    loadingMore: active && current && state.loadingMore,
    error: active && current ? state.error : null,
    loadMore,
    retry,
  };
}
