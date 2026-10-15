import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a number as Indian currency (INR).
 * Uses Indian number formatting: 1,23,456.78
 */
export function formatINR(value: number, decimals = 2): string {
  if (!isFinite(value)) return "—";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format a large number with Indian suffixes (L = Lakh, Cr = Crore).
 */
export function formatVolume(value: number): string {
  if (!isFinite(value) || value === 0) return "—";
  if (value >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`;
  if (value >= 1e5) return `${(value / 1e5).toFixed(2)} L`;
  return value.toLocaleString("en-IN");
}

/**
 * Format a percentage change with sign and 2 decimal places.
 */
export function formatPercent(value: number): string {
  if (!isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/**
 * Format a timestamp as a short human-readable time string.
 */
export function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "Asia/Kolkata",
    });
  } catch {
    return "—";
  }
}

/**
 * Format a date+time for the last updated indicator.
 */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "Asia/Kolkata",
    });
  } catch {
    return "—";
  }
}

/**
 * Returns CSS class string for positive/negative change colors.
 */
export function changeColor(value: number): string {
  if (value > 0) return "text-emerald-400";
  if (value < 0) return "text-rose-400";
  return "text-slate-400";
}
