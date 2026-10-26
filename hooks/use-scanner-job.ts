"use client";

import { useState, useCallback, useRef, useEffect } from "react";

export type ScanJobStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED" | null;

export interface ScanJob {
  jobId: string;
  status: ScanJobStatus;
  progressPercent: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  currentStage: string | null;
  totalInstruments: number;
  processedInstruments: number;
  retryCount: number;
}

export interface ScanBatchCounters {
  completed: number;
  failed: number;
  total: number;
}

export interface UseScannerJobReturn {
  job: ScanJob | null;
  batches: ScanBatchCounters;
  launching: boolean;
  /** True while an existing job is being resumed after a page load. */
  resuming: boolean;
  launch: (opts?: {
    from?: string;
    to?: string;
    concurrency?: number;
    symbols?: string[];
    instrumentIds?: number[];
  }) => Promise<void>;
  reset: () => void;
}

const POLL_INTERVAL_MS = 2000;
const LEASE_RETRY_MS = 1500;
const NETWORK_RETRY_MS = 2000;
const MAX_NETWORK_BACKOFF_MS = 15_000;
const MAX_CONSECUTIVE_BATCH_FAILURES = 20;

const EMPTY_BATCHES: ScanBatchCounters = { completed: 0, failed: 0, total: 0 };

function mapBatches(raw: any): ScanBatchCounters {
  return {
    completed: Number(raw?.completed ?? 0),
    failed: Number(raw?.failed ?? 0),
    total: Number(raw?.total ?? 0),
  };
}

function mapJob(jobId: string, raw: any): ScanJob {
  return {
    jobId,
    status: raw?.status ?? null,
    progressPercent: raw?.progress_percent ?? 0,
    errorMessage: raw?.error_message ?? null,
    startedAt: raw?.started_at ?? "",
    completedAt: raw?.completed_at ?? null,
    currentStage: raw?.current_stage ?? null,
    totalInstruments: Number(raw?.total_instruments ?? 0),
    processedInstruments: Number(raw?.processed_instruments ?? 0),
    retryCount: Number(raw?.retry_count ?? 0),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminal(status: ScanJobStatus): boolean {
  return status === "SUCCESS" || status === "FAILED";
}

export function useScannerJob(): UseScannerJobReturn {
  const [job, setJob] = useState<ScanJob | null>(null);
  const [batches, setBatches] = useState<ScanBatchCounters>(EMPTY_BATCHES);
  const [launching, setLaunching] = useState(false);
  const [resuming, setResuming] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const workerAbort = useRef<AbortController | null>(null);
  const resumedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const stopWorker = useCallback(() => {
    workerAbort.current?.abort();
    workerAbort.current = null;
  }, []);

  const pollJob = useCallback(
    async (jobId: string): Promise<ScanJob | null> => {
      try {
        const res = await fetch(`/api/scanner/job/${jobId}`, { cache: "no-store" });
        if (!res.ok) return null;
        const data = await res.json();
        const j = mapJob(jobId, data.job);
        setJob(j);
        if (data.batches) setBatches(mapBatches(data.batches));
        if (isTerminal(j.status)) {
          stopPolling();
          stopWorker();
        }
        return j;
      } catch {
        // Temporary network error — keep the last known state and poll again.
        return null;
      }
    },
    [stopPolling, stopWorker]
  );

  /**
   * Sequentially request one bounded batch at a time for `jobId`. Never
   * overlaps requests: each iteration awaits the previous one. Stops when the
   * job reaches a terminal state, on auth failure, or when aborted.
   */
  const driveBatches = useCallback(
    async (jobId: string, signal: AbortSignal) => {
      let networkFailures = 0;
      const backoff = () =>
        Math.min(
          MAX_NETWORK_BACKOFF_MS,
          NETWORK_RETRY_MS * Math.pow(2, Math.min(networkFailures - 1, 3))
        );
      const giveUp = (message: string) => {
        setJob((prev) => (prev ? { ...prev, errorMessage: message } : prev));
        stopPolling();
      };

      while (!signal.aborted) {
        try {
          const res = await fetch("/api/scanner/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId }),
            signal,
          });

          if (res.status === 401) {
            giveUp(
              "Session expired. Reconnect Zerodha, then press Run scan to resume."
            );
            break;
          }

          if (res.status === 404) {
            giveUp("This scan job no longer exists. Start a new scan.");
            break;
          }

          if (!res.ok) {
            // Route-level failure (e.g. DB hiccup). Progress is checkpointed,
            // so retry the same job with bounded backoff — never a new scan.
            networkFailures += 1;
            if (networkFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
              giveUp(
                `Batch requests keep failing (HTTP ${res.status}). Progress is saved; press Run scan to resume.`
              );
              break;
            }
            await sleep(backoff());
            continue;
          }

          networkFailures = 0;
          const data = await res.json().catch(() => ({}));
          if (data.job) {
            const j = mapJob(jobId, data.job);
            setJob(j);
            if (isTerminal(j.status)) {
              stopPolling();
              break;
            }
          }
          if (data.batches) setBatches(mapBatches(data.batches));

          if (!data.moreRemaining) break;

          if (!data.claimed) {
            // Another request holds the lease (e.g. a previous batch still
            // finishing). Wait for it to clear, then retry the same job.
            await pollJob(jobId);
            await sleep(LEASE_RETRY_MS);
            continue;
          }

          if (typeof data.retryAfterMs === "number" && data.retryAfterMs > 0) {
            // Server classified the failure as transient; back off before
            // retrying the same checkpoint instead of hammering the API.
            await sleep(data.retryAfterMs);
          }
        } catch {
          if (signal.aborted) break;
          // Network error — the batch may not have completed. The server-side
          // lease keeps progress safe; retry the same job, never a new one.
          networkFailures += 1;
          if (networkFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
            giveUp(
              "Lost connection to the server. Progress is saved; press Run scan to resume when you're back online."
            );
            break;
          }
          await sleep(backoff());
        }
      }
    },
    [pollJob, stopPolling]
  );

  const startJob = useCallback(
    async (jobId: string) => {
      const j = await pollJob(jobId);
      if (j && isTerminal(j.status)) return;
      stopPolling();
      pollRef.current = setInterval(() => pollJob(jobId), POLL_INTERVAL_MS);
      stopWorker();
      const controller = new AbortController();
      workerAbort.current = controller;
      void driveBatches(jobId, controller.signal);
    },
    [driveBatches, pollJob, stopPolling, stopWorker]
  );

  // Resume an in-flight job after a refresh/reopen. This only monitors and
  // drives an EXISTING persisted job — it never creates a new scan.
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    let cancelled = false;

    void (async () => {
      setResuming(true);
      try {
        const res = await fetch("/api/scanner/run", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = await res.json().catch(() => ({}));
        const status = data?.job?.status;
        if (
          typeof data?.jobId === "string" &&
          data.jobId &&
          (status === "PENDING" || status === "RUNNING")
        ) {
          if (cancelled) return;
          setJob(mapJob(data.jobId, data.job));
          if (data.batches) setBatches(mapBatches(data.batches));
          await startJob(data.jobId);
        }
      } catch {
        // Offline — pressing Run scan later resumes the persisted job.
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();

    return () => {
      cancelled = true;
      resumedRef.current = false;
    };
  }, [startJob]);

  const launch = useCallback(
    async (
      opts: {
        from?: string;
        to?: string;
        concurrency?: number;
        symbols?: string[];
        instrumentIds?: number[];
      } = {}
    ) => {
      stopPolling();
      stopWorker();
      setLaunching(true);
      try {
        const res = await fetch("/api/scanner/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        });

        // An active job already exists — continue it instead of duplicating.
        if (res.status === 409) {
          const data = await res.json().catch(() => ({}));
          if (typeof data.jobId !== "string" || !data.jobId) {
            throw new Error(data.message ?? "A scan is already running.");
          }
          await startJob(data.jobId);
          return;
        }

        if (res.status === 401) {
          throw new Error("Your session expired. Reconnect Zerodha and try again.");
        }

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }

        const data = await res.json();
        const jobId: string = data.jobId;
        setJob(
          data.job
            ? mapJob(jobId, data.job)
            : {
                jobId,
                status: "PENDING",
                progressPercent: 0,
                errorMessage: null,
                startedAt: new Date().toISOString(),
                completedAt: null,
                currentStage: null,
                totalInstruments: 0,
                processedInstruments: 0,
                retryCount: 0,
              }
        );
        await startJob(jobId);
      } catch (err: any) {
        if (err instanceof TypeError) {
          // fetch() itself failed (network down / offline). The scan may or
          // may not have been created. Retrying launch is safe: the server
          // returns 409 for the existing job, which resumes it.
          setJob({
            jobId: "",
            status: null,
            progressPercent: 0,
            errorMessage:
              "Network error while starting the scan. Check your connection and press Run scan again — an in-progress scan will be resumed, not duplicated.",
            startedAt: "",
            completedAt: null,
            currentStage: null,
            totalInstruments: 0,
            processedInstruments: 0,
            retryCount: 0,
          });
        } else {
          setJob((prev) =>
            prev
              ? { ...prev, errorMessage: err?.message ?? "Failed to launch scan" }
              : {
                  jobId: "",
                  status: null,
                  progressPercent: 0,
                  errorMessage: err?.message ?? "Failed to launch scan",
                  startedAt: "",
                  completedAt: null,
                  currentStage: null,
                  totalInstruments: 0,
                  processedInstruments: 0,
                  retryCount: 0,
                }
          );
        }
      } finally {
        setLaunching(false);
      }
    },
    [startJob, stopPolling, stopWorker]
  );

  const reset = useCallback(() => {
    stopPolling();
    stopWorker();
    setJob(null);
    setBatches(EMPTY_BATCHES);
  }, [stopPolling, stopWorker]);

  useEffect(
    () => () => {
      stopPolling();
      stopWorker();
    },
    [stopPolling, stopWorker]
  );

  return { job, batches, launching, resuming, launch, reset };
}
