"use client";

import type { ScanJob } from "@/hooks/use-scanner-job";

interface ScanProgressProps {
  job: ScanJob | null;
  launching: boolean;
}

export function ScanProgress({ job, launching }: ScanProgressProps) {
  if (!job && !launching) return null;

  const pct = job?.progressPercent ?? 0;
  const status = job?.status ?? (launching ? "PENDING" : null);
  const launchError = !status && job?.errorMessage;

  const statusColor = {
    PENDING: "text-amber-400",
    RUNNING: "text-indigo-400",
    SUCCESS: "text-emerald-400",
    FAILED: "text-rose-400",
  }[status ?? "PENDING"] ?? "text-slate-400";

  const statusLabel = launchError
    ? "Unable to start scan"
    : {
        PENDING: "Queued…",
        RUNNING: `Scanning… ${pct}%`,
        SUCCESS: "Scan complete",
        FAILED: "Scan failed",
      }[status ?? "PENDING"] ?? "Working…";

  const barColor = {
    PENDING: "bg-amber-500",
    RUNNING: "bg-indigo-500",
    SUCCESS: "bg-emerald-500",
    FAILED: "bg-rose-500",
  }[status ?? "PENDING"] ?? "bg-slate-500";

  return (
    <div className="space-y-2 animate-in fade-in slide-in-from-top-1 duration-300">
      <div className="flex items-center justify-between">
        <span className={`text-xs font-medium ${launchError ? "text-rose-400" : statusColor}`}>
          {statusLabel}
        </span>
        {status === "RUNNING" && (
          <span className="text-xs text-slate-500">{pct}%</span>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-1.5 w-full rounded-full bg-slate-700/60 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor} ${
            status === "RUNNING" ? "scanner-progress-shimmer" : ""
          }`}
          style={{ width: `${status === "PENDING" ? 4 : pct}%` }}
        />
      </div>

      {job?.errorMessage && (
        <p className="text-xs text-rose-400/80 leading-relaxed">{job.errorMessage}</p>
      )}

      {job?.currentStage && status === "RUNNING" && (
        <p className="text-xs text-slate-500">Stage: {job.currentStage}</p>
      )}

      {status === "RUNNING" && (
        <p className="text-xs text-slate-500 leading-relaxed">
          This tab processes the scan in small batches and shows live progress
          from the database. If you close the browser, automatic progress
          pauses — reopen the scanner and press Run scan to resume the same
          job exactly where it left off (it will never restart or duplicate).
        </p>
      )}

      {status === "SUCCESS" && (
        <p className="text-xs text-emerald-400/70">
          Zones updated — refresh the table below to see results.
        </p>
      )}
    </div>
  );
}
