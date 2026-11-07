"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getBoard,
  isAbortError,
  LiveTradeClientError,
  type LiveTradeBoardDto,
} from "@/lib/live-trade/client";

export interface BoardTaskContext {
  /** Board state when this task reaches the front of the queue. */
  board: LiveTradeBoardDto;
  /** Applies a server-confirmed patch to the current board. */
  apply: (update: (board: LiveTradeBoardDto) => LiveTradeBoardDto) => void;
  /** Reads the authoritative board without leaving the queue. */
  refresh: () => Promise<void>;
}

export interface UseLiveTradeBoardReturn {
  board: LiveTradeBoardDto | null;
  loading: boolean;
  refreshing: boolean;
  error: LiveTradeClientError | null;
  refetch: () => Promise<void>;
  /**
   * Runs a mutation that changes the board. Tasks execute one at a time in
   * call order, so each task sees every board change queued before it and a
   * response can never be applied after a newer one. Payloads that depend on
   * the current rows (versions, the full reorder set) must be computed inside
   * the task from `context.board`, not from render state.
   */
  runBoardTask: <T>(task: (context: BoardTaskContext) => Promise<T>) => Promise<T>;
}

/**
 * Loads the owner's board shell once and on demand.
 *
 * Zone summaries are requested separately, so the list is never blocked on
 * the heavier coverage reads. The board never includes quotes, so a
 * market-data outage cannot prevent this request from succeeding.
 *
 * Reads and mutations share a single promise queue. Several mutations can
 * each return a complete snapshot (reorder returns every row), so without
 * serialisation a slow response could overwrite a newer confirmed change.
 * Running them one at a time makes request order, server commit order and
 * apply order identical, which removes that class of race entirely. The
 * board is also mirrored in a ref so a queued task reads the state produced
 * by the task before it rather than a stale render closure.
 */
export function useLiveTradeBoard(enabled: boolean): UseLiveTradeBoardReturn {
  const [board, setBoard] = useState<LiveTradeBoardDto | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<LiveTradeClientError | null>(null);

  const boardRef = useRef<LiveTradeBoardDto | null>(null);
  const enabledRef = useRef(enabled);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const hasBoardRef = useRef(false);
  /** Tail of the board queue; reads and mutations run one at a time. */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const commit = useCallback((next: LiveTradeBoardDto | null) => {
    boardRef.current = next;
    setBoard(next);
  }, []);

  const enqueue = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(task, task);
    queueRef.current = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }, []);

  const readBoard = useCallback(async (): Promise<void> => {
    if (!enabledRef.current) return;

    const requestId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (hasBoardRef.current) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const next = await getBoard(controller.signal, { includeZones: false });
      if (requestId !== requestIdRef.current) return;
      hasBoardRef.current = true;
      commit(next);
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
  }, [commit]);

  const refetch = useCallback(() => enqueue(readBoard), [enqueue, readBoard]);

  const runBoardTask = useCallback(
    <T>(task: (context: BoardTaskContext) => Promise<T>): Promise<T> =>
      enqueue(async () => {
        const current = boardRef.current;
        if (!enabledRef.current || current === null) {
          throw new LiveTradeClientError(
            "The workspace is not ready. Reload the page and try again.",
            { status: 0, code: "UNKNOWN" }
          );
        }
        return task({
          board: current,
          apply: (update) => {
            const latest = boardRef.current;
            if (latest === null) return;
            commit(update(latest));
          },
          refresh: readBoard,
        });
      }),
    [commit, enqueue, readBoard]
  );

  useEffect(() => {
    enabledRef.current = enabled;
    if (!enabled) {
      // Invalidate a read that is already in flight as well as aborting it, so
      // a response that ignores the abort cannot repopulate a cleared board.
      requestIdRef.current += 1;
      abortRef.current?.abort();
      hasBoardRef.current = false;
      boardRef.current = null;
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

  return { board, loading, refreshing, error, refetch, runBoardTask };
}
