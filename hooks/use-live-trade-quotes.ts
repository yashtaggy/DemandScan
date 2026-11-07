"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getQuotes,
  isAbortError,
  LiveTradeClientError,
  type LiveTradeQuoteDto,
} from "@/lib/live-trade/client";

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_SERVER_COOLDOWN_MS = 5_000;
const LOCAL_SUCCESS_COOLDOWN_MS = 5_000;

export type QuoteDisplayState = "current" | "stale" | "sign-in";

export interface QuoteMarketSnapshot {
  isOpen: boolean;
  exchange: "NSE";
  approximation: string;
}

export interface UseLiveTradeQuotesReturn {
  quotes: Record<number, LiveTradeQuoteDto>;
  market: QuoteMarketSnapshot | null;
  fetchedAt: string | null;
  zonesAvailable: boolean;
  loading: boolean;
  refreshing: boolean;
  error: LiveTradeClientError | null;
  /** Overrides retained snapshots after a failed refresh or expired session. */
  displayState: QuoteDisplayState;
  cooldownSecondsLeft: number;
  refresh: () => void;
}

/**
 * Polls `/api/live-trade/quotes` every 30 seconds while the page is visible.
 *
 * Guards:
 *  - one request at a time; instrument changes abort the previous request;
 *  - a successful response starts a local 5-second refresh cooldown;
 *  - no request within the server's 5-second floor;
 *  - timers stop while the document is hidden and on unmount;
 *  - a 429 honours Retry-After and only retries on the next regular poll;
 *  - a 401 stops automatic polling and labels retained data "sign in required";
 *  - any other failure retains the previous snapshot as STALE without touching
 *    board data.
 */
export function useLiveTradeQuotes(
  instrumentIds: number[],
  enabled: boolean,
  intervalMs: number = DEFAULT_INTERVAL_MS
): UseLiveTradeQuotesReturn {
  const [quotes, setQuotes] = useState<Record<number, LiveTradeQuoteDto>>({});
  const [market, setMarket] = useState<QuoteMarketSnapshot | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [zonesAvailable, setZonesAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<LiveTradeClientError | null>(null);
  const [displayState, setDisplayState] = useState<QuoteDisplayState>("current");
  const [cooldownEndsAt, setCooldownEndsAt] = useState(0);
  const [clock, setClock] = useState(0);

  const idsRef = useRef(instrumentIds);
  const enabledRef = useRef(enabled);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cooldownUntilRef = useRef(0);
  const fetchedAtRef = useRef<string | null>(null);
  const lastSuccessAtRef = useRef(0);

  const runRef = useRef<() => void>(() => {});
  const scheduleRef = useRef<(delayMs: number) => void>(() => {});

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = useCallback(
    (delayMs: number) => {
      clearTimer();
      if (!enabledRef.current) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      timerRef.current = setTimeout(
        () => {
          timerRef.current = null;
          runRef.current();
        },
        Math.max(50, delayMs)
      );
    },
    [clearTimer]
  );

  useEffect(() => {
    scheduleRef.current = schedule;
  }, [schedule]);

  const run = useCallback(
    async () => {
      if (!mountedRef.current || !enabledRef.current) return;

      const ids = idsRef.current;
      if (ids.length === 0) {
        clearTimer();
        setQuotes({});
        setMarket(null);
        setZonesAvailable(true);
        setFetchedAt(null);
        setError(null);
        setDisplayState("current");
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (inFlightRef.current) return;

      const now = Date.now();
      const cooldownLeft = cooldownUntilRef.current - now;
      if (cooldownLeft > 0) {
        // Manual attempts inside the floor are deferred, never sent.
        scheduleRef.current(cooldownLeft + 250);
        return;
      }

      const hasSnapshot = fetchedAtRef.current !== null;
      inFlightRef.current = true;
      setError(null);
      if (hasSnapshot) setRefreshing(true);
      else setLoading(true);

      const requestId = ++requestIdRef.current;
      const controller = new AbortController();
      abortRef.current = controller;

      let nextDelay = intervalMs;

      try {
        const data = await getQuotes(ids, controller.signal);
        if (!mountedRef.current || requestId !== requestIdRef.current) return;

        const nextQuotes: Record<number, LiveTradeQuoteDto> = {};
        for (const quote of data.quotes) {
          nextQuotes[quote.instrumentId] = quote;
        }

        setQuotes(nextQuotes);
        setMarket(data.market);
        setZonesAvailable(data.zonesAvailable);
        fetchedAtRef.current = data.fetchedAt;
        setFetchedAt(data.fetchedAt);
        setDisplayState("current");
        setError(null);
        const successAt = Date.now();
        lastSuccessAtRef.current = successAt;
        const until = successAt + LOCAL_SUCCESS_COOLDOWN_MS;
        cooldownUntilRef.current = until;
        setCooldownEndsAt(until);
        setClock(successAt);
      } catch (cause) {
        if (!mountedRef.current || requestId !== requestIdRef.current) return;
        if (isAbortError(cause)) return;

        const clientError =
          cause instanceof LiveTradeClientError
            ? cause
            : new LiveTradeClientError(
                "Quotes could not be refreshed. Your board is unaffected.",
                { status: 0, code: "UNKNOWN" }
              );
        setError(clientError);

        if (clientError.status === 401) {
          setDisplayState("sign-in");
          nextDelay = -1;
        } else if (fetchedAtRef.current !== null) {
          setDisplayState("stale");
        }

        if (clientError.code === "QUOTE_COOLDOWN") {
          const retrySeconds =
            clientError.retryAfterSeconds ??
            MIN_SERVER_COOLDOWN_MS / 1000;
          const until = Date.now() + retrySeconds * 1000;
          cooldownUntilRef.current = until;
          setCooldownEndsAt(until);
          setClock(Date.now());
          // Wait for the regular poll after the cooldown; never a tight retry.
          nextDelay = Math.max(intervalMs, retrySeconds * 1000 + 500);
        }
      } finally {
        if (requestId === requestIdRef.current) {
          inFlightRef.current = false;
          if (mountedRef.current) {
            setLoading(false);
            setRefreshing(false);
          }
        }
      }

      if (nextDelay >= 0) scheduleRef.current(nextDelay);
    },
    [clearTimer, intervalMs]
  );

  useEffect(() => {
    runRef.current = () => {
      void run();
    };
  }, [run]);

  const refresh = useCallback(() => {
    runRef.current();
  }, []);

  const idsKey = instrumentIds.join(",");
  useEffect(() => {
    idsRef.current = idsKey === "" ? [] : idsKey.split(",").map(Number);
    enabledRef.current = enabled;

    if (!enabled) {
      clearTimer();
      abortRef.current?.abort();
      requestIdRef.current += 1;
      inFlightRef.current = false;
      /* eslint-disable-next-line react-hooks/set-state-in-effect --
         Disabling polling must drop the retained snapshot so stale data is
         never shown as current. */
      setQuotes({});
      setMarket(null);
      fetchedAtRef.current = null;
      setFetchedAt(null);
      setZonesAvailable(true);
      setError(null);
      setDisplayState("current");
      setLoading(false);
      setRefreshing(false);
      setCooldownEndsAt(0);
      cooldownUntilRef.current = 0;
      return;
    }

    // A changed selection invalidates an in-flight read for the old selection.
    abortRef.current?.abort();
    inFlightRef.current = false;
    clearTimer();
    runRef.current();
  }, [enabled, idsKey, clearTimer]);

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clearTimer();
        return;
      }
      const elapsed = Date.now() - lastSuccessAtRef.current;
      if (lastSuccessAtRef.current === 0 || elapsed >= intervalMs) {
        runRef.current();
      } else {
        scheduleRef.current(intervalMs - elapsed);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, intervalMs, clearTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      abortRef.current?.abort();
    };
  }, [clearTimer]);

  useEffect(() => {
    if (cooldownEndsAt <= 0) return;

    const timer = setInterval(() => {
      const now = Date.now();
      setClock(now);
      if (now >= cooldownEndsAt) clearInterval(timer);
    }, 250);

    return () => clearInterval(timer);
  }, [cooldownEndsAt]);

  const cooldownSecondsLeft =
    cooldownEndsAt > 0
      ? Math.max(0, Math.ceil((cooldownEndsAt - clock) / 1000))
      : 0;

  return {
    quotes,
    market,
    fetchedAt,
    zonesAvailable,
    loading,
    refreshing,
    error,
    displayState,
    cooldownSecondsLeft,
    refresh,
  };
}
