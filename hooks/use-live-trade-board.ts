"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getBoard,
  isAbortError,
  LiveTradeClientError,
  type LiveTradeBoardDto,
} from "@/lib/live-trade/client";

export interface UseLiveTradeBoardReturn {
  board: LiveTradeBoardDto | null;
  loading: boolean;
  refreshing: boolean;
  error: LiveTradeClientError | null;
  refetch: () => Promise<void>;
}

/**
 * Loads the owner's board once and on demand after a mutation.
 *
 * The board never includes quotes, so a market-data outage cannot prevent this
 * request from succeeding. Refetches abort an in-flight board read so a slow
 * response cannot overwrite a newer one.
 */
export function useLiveTradeBoard(enabled: boolean): UseLiveTradeBoardReturn {
  const [board, setBoard] = useState<LiveTradeBoardDto | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<LiveTradeClientError | null>(null);

  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const hasBoardRef = useRef(false);

  const refetch = useCallback(async () => {
    if (!enabled) return;
    const requestId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (hasBoardRef.current) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const next = await getBoard(controller.signal);
      if (requestId !== requestIdRef.current) return;
      hasBoardRef.current = true;
      setBoard(next);
    } catch (cause) {
      if (isAbortError(cause) || requestId !== requestIdRef.current) return;
      setError(
        cause instanceof LiveTradeClientError
          ? cause
          : new LiveTradeClientError(
              "The workspace could not be loaded. Please try again.",
              { status: 0, code: "UNKNOWN" }
            )
      );
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort();
      hasBoardRef.current = false;
      /* eslint-disable-next-line react-hooks/set-state-in-effect --
         Disabling the workspace must clear any previously loaded board. */
      setBoard(null);
      setLoading(false);
      setRefreshing(false);
      setError(null);
      return;
    }
    void refetch();
    return () => {
      abortRef.current?.abort();
    };
  }, [enabled, refetch]);

  return { board, loading, refreshing, error, refetch };
}
