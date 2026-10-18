"use client";

import { useState } from "react";
import { useZones, type ZoneFilters } from "@/hooks/use-zones";
import { useScannerJob } from "@/hooks/use-scanner-job";
import { ScanProgress } from "@/components/scanner/ScanProgress";
import { ScannerControls } from "@/components/scanner/ScannerControls";
import { ZoneTable } from "@/components/scanner/ZoneTable";
import { Badge } from "@/components/ui/badge";

interface ScannerPanelProps {
  isAuthenticated: boolean;
}

export function ScannerPanel({ isAuthenticated }: ScannerPanelProps) {
  const [filters, setFilters] = useState<ZoneFilters>({ limit: 50 });
  const { zones, count, loading, error, refetch } = useZones(
    isAuthenticated ? filters : {}
  );
  const { job, launching, launch } = useScannerJob();

  const isRunning = job?.status === "RUNNING" || job?.status === "PENDING";

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">S/D Zone Scanner</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Multi-timeframe supply &amp; demand zones
          </p>
        </div>
        {count > 0 && (
          <Badge variant="neutral" size="sm">{count} zones</Badge>
        )}
      </div>

      {!isAuthenticated ? (
        <p className="text-xs text-slate-500 text-center py-4">
          Connect Zerodha to use the scanner.
        </p>
      ) : (
        <>
          {/* Scan progress */}
          <ScanProgress job={job} launching={launching} />

          {/* Controls */}
          <ScannerControls
            filters={filters}
            onFiltersChange={setFilters}
            onRunScan={() => launch()}
            onRefreshZones={refetch}
            isRunning={isRunning}
            launching={launching}
            isAuthenticated={isAuthenticated}
          />

          {/* Zone results */}
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">
              Zones
            </p>
            <ZoneTable
              zones={zones}
              loading={loading}
              error={error}
              onRetry={refetch}
            />
          </div>
        </>
      )}
    </div>
  );
}
