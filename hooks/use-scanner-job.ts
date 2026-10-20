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
}

export interface UseScannerJobReturn {
  job: ScanJob | null;
  launching: boolean;
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

function mapJob(jobId: string, raw: any): ScanJob {
  return {
    jobId,
    status: raw?.status ?? null,
    progressPercent: raw?.progress_percent ?? 0,
    errorMessage: raw?.error_message ?? null,
    startedAt: raw?.started_at ?? "",
    completedAt: raw?.completed_at ?? null,
    currentStage: raw?.current_stage ?? null,
  };
}

function isTerminal(status: ScanJobStatus): boolean {
  return status === "SUCCESS" || status === "FAILED";
}

export function useScannerJob(): UseScannerJobReturn {
  const [job, setJob] = useState<ScanJob | null>(null);
  const [launching, setLaunching] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const workerAbort = useRef<AbortController | null>(null);

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
      while (!signal.aborted) {
        try {
          const res = await fetch("/api/scanner/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobId }),
            signal,
          });

          if (res.status === 401) {
            setJob((prev) =>
              prev
                ? {
                    ...prev,
                    errorMessage:
                      "Session expired. Reconnect Zerodha, then press Run scan to resume.",
                  }
                : prev
            );
            stopPolling();
            break;
          }

          const data = await res.json().catch(() => ({}));
          if (data.job) {
            const j = mapJob(jobId, data.job);
            setJob(j);
            if (isTerminal(j.status)) {
              stopPolling();
              break;
            }
          }

          if (!data.moreRemaining) break;

          if (!data.claimed) {
            // Another request holds the lease (e.g. a previous batch still
            // finishing). Wait for it to clear, then retry the same job.
            await pollJob(jobId);
            await new Promise((r) => setTimeout(r, LEASE_RETRY_MS));
          }
        } catch {
          if (signal.aborted) break;
          // Network error — the batch may not have completed. The server-side
          // lease keeps progress safe; retry the same job, never a new one.
          await new Promise((r) => setTimeout(r, NETWORK_RETRY_MS));
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
      const controller = new AbortController();
      workerAbort.current = controller;
      void driveBatches(jobId, controller.signal);
    },
    [driveBatches, pollJob, stopPolling]
  );

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
  }, [stopPolling, stopWorker]);

  useEffect(
    () => () => {
      stopPolling();
      stopWorker();
    },
    [stopPolling, stopWorker]
  );

  return { job, launching, launch, reset };
}
