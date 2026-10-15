"use client";

import { cn, formatINR } from "@/lib/utils";
import { SummaryCardSkeleton } from "@/components/ui/skeleton";

interface SummaryCardProps {
  label: string;
  value: string | number | null | undefined;
  subtext?: string;
  icon: React.ReactNode;
  color?: "default" | "green" | "blue" | "amber";
  loading?: boolean;
}

function SummaryCard({ label, value, subtext, icon, color = "default", loading }: SummaryCardProps) {
  const colorClasses = {
    default: "text-slate-100",
    green: "text-emerald-400",
    blue: "text-blue-400",
    amber: "text-amber-400",
  };

  const iconBgClasses = {
    default: "bg-slate-700/50",
    green: "bg-emerald-500/10",
    blue: "bg-blue-500/10",
    amber: "bg-amber-500/10",
  };

  if (loading) return <SummaryCardSkeleton />;

  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-5 hover:bg-slate-800/60 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{label}</p>
          <p className={cn("text-2xl font-bold tabular-nums", colorClasses[color])}>
            {value ?? "—"}
          </p>
          {subtext && (
            <p className="text-xs text-slate-500 truncate">{subtext}</p>
          )}
        </div>
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", iconBgClasses[color])}>
          {icon}
        </div>
      </div>
    </div>
  );
}

interface SummaryCardsProps {
  instrumentsLoaded?: number;
  symbolsWithQuotes?: number;
  matchingFilter?: number;
  fetchedAt?: string | null;
  loading?: boolean;
}

export function SummaryCards({
  instrumentsLoaded,
  symbolsWithQuotes,
  matchingFilter,
  fetchedAt,
  loading,
}: SummaryCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <SummaryCard
        label="Instruments Loaded"
        value={instrumentsLoaded?.toLocaleString("en-IN")}
        subtext="From NSE EQ segment"
        icon={
          <svg className="h-4 w-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h18M3 12h18M3 17h18" />
          </svg>
        }
        loading={loading}
      />
      <SummaryCard
        label="Live Quotes"
        value={symbolsWithQuotes?.toLocaleString("en-IN")}
        subtext="With valid quote data"
        color="green"
        icon={
          <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" />
          </svg>
        }
        loading={loading}
      />
      <SummaryCard
        label="Filtered Results"
        value={matchingFilter?.toLocaleString("en-IN")}
        subtext="Matching active filters"
        color="blue"
        icon={
          <svg className="h-4 w-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z" />
          </svg>
        }
        loading={loading}
      />
      <SummaryCard
        label="Last Refresh"
        value={fetchedAt ? new Date(fetchedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" }) : null}
        subtext="IST"
        color="amber"
        icon={
          <svg className="h-4 w-4 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        }
        loading={loading}
      />
    </div>
  );
}
