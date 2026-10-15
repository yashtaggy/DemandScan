"use client";

import { cn } from "@/lib/utils";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "success" | "danger" | "warning" | "neutral" | "info";
  size?: "sm" | "md";
  dot?: boolean;
  className?: string;
}

export function Badge({
  children,
  variant = "neutral",
  size = "sm",
  dot = false,
  className,
}: BadgeProps) {
  const variantClasses = {
    success: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    danger: "bg-rose-500/15 text-rose-400 border-rose-500/30",
    warning: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    neutral: "bg-slate-700/50 text-slate-300 border-slate-600/50",
    info: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  };

  const dotColors = {
    success: "bg-emerald-400",
    danger: "bg-rose-400",
    warning: "bg-amber-400",
    neutral: "bg-slate-400",
    info: "bg-blue-400",
  };

  const sizeClasses = {
    sm: "text-xs px-2 py-0.5",
    md: "text-sm px-3 py-1",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
    >
      {dot && (
        <span
          className={cn("h-1.5 w-1.5 rounded-full animate-pulse", dotColors[variant])}
        />
      )}
      {children}
    </span>
  );
}
