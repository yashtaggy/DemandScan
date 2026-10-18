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
}

export interface UseScannerJobReturn {
  job: ScanJob | null;
  launching: boolean;
  launch: (opts?: { from?: string; to?: string; concurrency?: number }) => Promise<void>;
  reset: () => void;
}

const POLL_INTERVAL_MS = 2000;

export function useScannerJob(): UseScannerJobReturn {
  const [job, setJob] = useState<ScanJob | null>(null);
  const [launching, setLaunching] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/scanner/job/${jobId}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const j: ScanJob = {
        jobId,
        status: data.job?.status ?? null,
        progressPercent: data.job?.progress_percent ?? 0,
        errorMessage: data.job?.error_message ?? null,
        startedAt: data.job?.started_at ?? "",
        completedAt: data.job?.completed_at ?? null,
      };
      setJob(j);

      // Stop polling once terminal state is reached.
      if (j.status === "SUCCESS" || j.status === "FAILED") {
        stopPolling();
      }
    } catch {
      // Ignore network errors during polling
    }
  }, [stopPolling]);

  const launch = useCallback(async (
    opts: { from?: string; to?: string; concurrency?: number } = {}
  ) => {
    stopPolling();
    setLaunching(true);
    try {
      const res = await fetch("/api/scanner/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const jobId: string = data.jobId;
      setJob({
        jobId,
        status: "PENDING",
        progressPercent: 0,
        errorMessage: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      });

      // Begin polling.
      pollRef.current = setInterval(() => pollJob(jobId), POLL_INTERVAL_MS);
    } catch (err: any) {
      setJob((prev) =>
        prev
          ? { ...prev, status: "FAILED", errorMessage: err?.message ?? "Failed to launch scan" }
          : null
      );
    } finally {
      setLaunching(false);
    }
  }, [pollJob, stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    setJob(null);
  }, [stopPolling]);

  // Clean up on unmount.
  useEffect(() => () => stopPolling(), [stopPolling]);

  return { job, launching, launch, reset };
}
