"use client";

import type { ScanJob, ScanBatchCounters } from "@/hooks/use-scanner-job";

interface ScanProgressProps {
  job: ScanJob | null;
  launching: boolean;
  batches?: ScanBatchCounters;
  resuming?: boolean;
}

const STAGE_LABELS: Record<string, string> = {
  SYNC_INSTRUMENTS: "Syncing Nifty 500 universe",
  INGEST_DAILY: "Ingesting daily candles",
  INGEST_HOURLY: "Ingesting hourly candles",
  AGGREGATE_DAILY: "Aggregating weekly → yearly",
  AGGREGATE_4H: "Aggregating 4H sessions",
  DETECT_ZONES: "Detecting zones (8 timeframes)",
  LIFECYCLE: "Updating zone lifecycles",
};

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function ScanProgress({ job, launching, batches, resuming }: ScanProgressProps) {
  if (!job && !launching && !resuming) return null;

  const pct = job?.progressPercent ?? 0;
  const status = job?.status ?? (launching ? "PENDING" : null);
  const launchError = !status && job?.errorMessage;

  const statusColor = {
    PENDING: "text-amber-400",
    RUNNING: "text-indigo-400",
    SUCCESS: "text-emerald-400",
    FAILED: "text-rose-400",
  }[status ?? "PENDING"] ?? "text-slate-400";

  const statusLabel = resuming
    ? "Resuming existing scan…"
    : launchError
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

  const startedAt = job?.startedAt ? new Date(job.startedAt).getTime() : NaN;
  const completedAt = job?.completedAt ? new Date(job.completedAt).getTime() : NaN;
  const endAt = Number.isFinite(completedAt) ? completedAt : Date.now();
  const elapsedMs = Number.isFinite(startedAt) ? endAt - startedAt : NaN;

  const total = job?.totalInstruments ?? 0;
  const processed = job?.processedInstruments ?? 0;
  const batchesCompleted = batches?.completed ?? 0;

  // Coarse whole-job estimate from persisted progress. Only shown while
  // running with enough progress for the extrapolation to mean anything.
  const etaMs =
    status === "RUNNING" && pct >= 5 && pct < 100 && Number.isFinite(elapsedMs)
      ? (elapsedMs * (100 - pct)) / pct
      : null;
  const avgBatchMs =
    batchesCompleted > 0 && Number.isFinite(elapsedMs)
      ? elapsedMs / batchesCompleted
      : null;

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

      {job?.currentStage && (status === "RUNNING" || status === "SUCCESS") && (
        <p className="text-xs text-slate-400">
          {STAGE_LABELS[job.currentStage] ?? job.currentStage}
        </p>
      )}

      {status === "RUNNING" && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-500 tabular-nums">
          <span>Instruments</span>
          <span className="text-right text-slate-400">
            {processed}/{total > 0 ? total : "—"} this stage
          </span>
          <span>Batches</span>
          <span className="text-right text-slate-400">
            {batchesCompleted} done
            {(batches?.failed ?? 0) > 0 ? ` · ${batches?.failed} failed` : ""}
          </span>
          {(job?.retryCount ?? 0) > 0 && (
            <>
              <span>Retries</span>
              <span className="text-right text-amber-400">{job?.retryCount}</span>
            </>
          )}
          <span>Elapsed</span>
          <span className="text-right text-slate-400">{formatDuration(elapsedMs)}</span>
          {avgBatchMs != null && (
            <>
              <span>Avg batch</span>
              <span className="text-right text-slate-400">{formatDuration(avgBatchMs)}</span>
            </>
          )}
          {etaMs != null && (
            <>
              <span>Est. remaining</span>
              <span className="text-right text-slate-400">
                ~{formatDuration(etaMs)}
              </span>
            </>
          )}
        </div>
      )}

      {status === "RUNNING" && (
        <p className="text-xs text-slate-500 leading-relaxed">
          This tab processes the scan in bounded batches and shows persisted
          progress. Refresh or reopen the scanner and the same job resumes
          automatically. Closing the tab pauses progress; reopening continues
          exactly where it stopped (never a duplicate job).
        </p>
      )}
      {etaMs != null && (
        <p className="text-[10px] text-slate-600">
          Estimate extrapolated from overall progress; actual time varies by stage.
        </p>
      )}

      {status === "SUCCESS" && (
        <p className="text-xs text-emerald-400/70">
          Zones updated — the table below refreshes automatically.
        </p>
      )}
    </div>
  );
}
