"use client";

import { useEffect, useRef, useState } from "react";
import {
  isAbortError,
  LiveTradeClientError,
  searchInstruments,
  type InstrumentSearchResponseDto,
} from "@/lib/live-trade/client";

export type InstrumentSearchResult = InstrumentSearchResponseDto["instruments"][number];
export type InstrumentMasterInfo = InstrumentSearchResponseDto["instrumentMaster"];

export interface UseInstrumentSearchReturn {
  results: InstrumentSearchResult[];
  master: InstrumentMasterInfo | null;
  /** The trimmed query the current results belong to. */
  resultQuery: string | null;
  loading: boolean;
  error: LiveTradeClientError | null;
}

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Debounced symbol/company search. A request is aborted as soon as the query
 * changes so an older result set cannot replace a newer one.
 */
export function useInstrumentSearch(
  query: string,
  enabled: boolean,
  debounceMs: number = SEARCH_DEBOUNCE_MS
): UseInstrumentSearchReturn {
  const [state, setState] = useState<{
    query: string;
    results: InstrumentSearchResult[];
    master: InstrumentMasterInfo | null;
    error: LiveTradeClientError | null;
  }>({ query: "", results: [], master: null, error: null });

  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();

    if (!enabled || trimmed === "") {
      requestIdRef.current += 1;
      abortRef.current?.abort();
      return;
    }

    const timer = setTimeout(() => {
      const requestId = ++requestIdRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      searchInstruments(trimmed, controller.signal)
        .then((data) => {
          if (requestId !== requestIdRef.current) return;
          setState({
            query: trimmed,
            results: data.instruments,
            master: data.instrumentMaster,
            error: null,
          });
        })
        .catch((cause: unknown) => {
          if (isAbortError(cause) || requestId !== requestIdRef.current) return;
          setState({
            query: trimmed,
            results: [],
            master: null,
            error:
              cause instanceof LiveTradeClientError
                ? cause
                : new LiveTradeClientError("Search failed. Please try again.", {
                    status: 0,
                    code: "UNKNOWN",
                  }),
          });
        });
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [query, enabled, debounceMs]);

  const trimmed = query.trim();
  const active = enabled && trimmed !== "";
  const settled = active && state.query === trimmed;

  return {
    results: settled ? state.results : [],
    master: settled ? state.master : null,
    resultQuery: settled ? trimmed : null,
    loading: active && !settled,
    error: settled ? state.error : null,
  };
}
