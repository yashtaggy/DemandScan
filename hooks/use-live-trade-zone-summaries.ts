"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getZones,
  isAbortError,
  LiveTradeClientError,
  type LiveTradeZoneSummaryDto,
} from "@/lib/live-trade/client";

export interface UseLiveTradeZoneSummariesReturn {
  summaries: Map<number, LiveTradeZoneSummaryDto>;
  /**
   * True while any summary request is in flight. Rows that already have a
   * summary keep showing it; rows without one (for example a just-added
   * instrument) show their loading state.
   */
  loading: boolean;
  error: LiveTradeClientError | null;
  /** Refetches in the background; existing summaries stay visible meanwhile. */
  reload: () => void;
}

const EMPTY = new Map<number, LiveTradeZoneSummaryDto>();

interface SummaryState {
  summaries: Map<number, LiveTradeZoneSummaryDto>;
  loading: boolean;
  error: LiveTradeClientError | null;
}

const INITIAL_STATE: SummaryState = {
  summaries: EMPTY,
  loading: false,
  error: null,
};

/**
 * Loads the owner's structural-zone summaries independently of the board.
 *
 * The board shell renders as soon as groups and items arrive; these heavier
 * nearest-zone and coverage reads arrive later and fill the zone columns in
 * place. The endpoint lists the owner's own instruments, so no identity is
 * sent from the browser. Requests abort on unmount and only the newest
 * response is applied, so a slow reply cannot overwrite a newer one.
 */
export function useLiveTradeZoneSummaries(
  enabled: boolean
): UseLiveTradeZoneSummariesReturn {
  const [state, setState] = useState<SummaryState>(INITIAL_STATE);

  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    if (!enabled) return;

    const requestId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((previous) => ({
      ...previous,
      loading: true,
      error: null,
    }));

    getZones({}, controller.signal)
      .then((data) => {
        if (requestId !== requestIdRef.current) return;
        setState({
          summaries: new Map(
            data.summaries.map((summary) => [summary.instrumentId, summary])
          ),
          loading: false,
          error: null,
        });
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause) || requestId !== requestIdRef.current) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          error:
            cause instanceof LiveTradeClientError
              ? cause
              : new LiveTradeClientError(
                  "Zone summaries could not be loaded.",
                  { status: 0, code: "UNKNOWN" }
                ),
        }));
      });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      requestIdRef.current += 1;
      abortRef.current?.abort();
      /* eslint-disable-next-line react-hooks/set-state-in-effect --
         Disabling the summaries (empty board or signed out) must clear the
         previous owner's map so it can never be shown again. */
      setState(INITIAL_STATE);
      return;
    }
    reload();
    return () => {
      abortRef.current?.abort();
    };
  }, [enabled, reload]);

  return {
    summaries: state.summaries,
    loading: state.loading,
    error: state.error,
    reload,
  };
}
