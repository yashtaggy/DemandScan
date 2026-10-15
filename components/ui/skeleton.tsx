"use client";

import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded bg-slate-700/60",
        className
      )}
    />
  );
}

export function StockTableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="space-y-px">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 px-4 py-3 bg-slate-800/40 rounded-lg"
        >
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-3 w-28 flex-1" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

export function SummaryCardSkeleton() {
  return (
    <div className="rounded-xl border border-slate-700/50 bg-slate-800/40 p-5 space-y-3">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-16" />
      <Skeleton className="h-3 w-32" />
    </div>
  );
}
