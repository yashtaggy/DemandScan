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

  const pollJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/scanner/job/${jobId}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const j = mapJob(jobId, data.job);
      setJob(j);
      if (j.status === "SUCCESS" || j.status === "FAILED") {
        stopPolling();
        stopWorker();
      }
    } catch {
      // Ignore network errors during polling
    }
  }, [stopPolling, stopWorker]);

  const driveBatches = useCallback(async (jobId: string, signal: AbortSignal) => {
    while (!signal.aborted) {
      try {
        const res = await fetch("/api/scanner/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        });

        if (res.status === 401) break;

        const data = await res.json().catch(() => ({}));
        if (data.job) {
          const j = mapJob(jobId, data.job);
          setJob(j);
          if (j.status === "SUCCESS" || j.status === "FAILED") {
            stopPolling();
            break;
          }
        }

        if (!data.claimed || !data.moreRemaining) {
          await pollJob(jobId);
          if (!data.moreRemaining) break;
          // Another worker holds the lease; wait and retry instead of stopping.
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
      } catch {
        if (signal.aborted) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }, [pollJob, stopPolling]);

  const launch = useCallback(async (
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

      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.jobId) {
        const jobId: string = data.jobId;
        setJob({
          jobId,
          status: "RUNNING",
          progressPercent: 0,
          errorMessage: "Resuming the scan already in progress.",
          startedAt: new Date().toISOString(),
          completedAt: null,
          currentStage: null,
        });
        pollRef.current = setInterval(() => pollJob(jobId), POLL_INTERVAL_MS);
        const controller = new AbortController();
        workerAbort.current = controller;
        void driveBatches(jobId, controller.signal);
        return;
      }

      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
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

      pollRef.current = setInterval(() => pollJob(jobId), POLL_INTERVAL_MS);
      const controller = new AbortController();
      workerAbort.current = controller;
      void driveBatches(jobId, controller.signal);
    } catch (err: any) {
      setJob((prev) =>
        prev
          ? { ...prev, status: "FAILED", errorMessage: err?.message ?? "Failed to launch scan" }
          : null
      );
    } finally {
      setLaunching(false);
    }
  }, [driveBatches, pollJob, stopPolling, stopWorker]);

  const reset = useCallback(() => {
    stopPolling();
    stopWorker();
    setJob(null);
  }, [stopPolling, stopWorker]);

  useEffect(() => () => {
    stopPolling();
    stopWorker();
  }, [stopPolling, stopWorker]);

  return { job, launching, launch, reset };
}
