/**
 * Display vocabulary for the Live Trade workspace.
 *
 * The UI must not invent market facts, so every value rendered here comes from
 * an API field. These helpers only translate API enums into labels and styles.
 */

import type { LifecycleState, ZoneSide } from "@/lib/scanner/types";
import type {
  LiveTradeDirection,
  LiveTradePriority,
  LiveTradeQuoteErrorCode,
  LiveTradeStatus,
  LiveTradeZoneCoverage,
} from "./constants";
import { formatDateTime, formatINR, formatPercent } from "@/lib/utils";

type Tone = "success" | "warning" | "danger" | "neutral" | "info";

export const PRIORITY_META: Record<
  LiveTradePriority,
  { label: string; className: string }
> = {
  HIGH: {
    label: "High",
    className: "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-300",
  },
  MEDIUM: {
    label: "Medium",
    className: "border-indigo-500/30 bg-indigo-500/10 text-indigo-300",
  },
  LOW: {
    label: "Low",
    className: "border-slate-600/50 bg-slate-700/40 text-slate-300",
  },
};

export const STATUS_LABEL: Record<LiveTradeStatus, string> = {
  WATCHING: "Watching",
  WAITING_FOR_ENTRY: "Waiting for entry",
  ACTIVE_TRADE: "Active trade",
  TARGET_HIT: "Target hit",
  STOP_LOSS_HIT: "Stop-loss hit",
  CLOSED: "Closed",
};

export function directionLabel(direction: LiveTradeDirection | null): string {
  if (direction === "BUY") return "Buy";
  if (direction === "SELL") return "Sell";
  return "—";
}

export const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  CONFIRMED_FRESH: "Fresh",
  TOUCHED_ONCE: "Tested ×1",
  RETESTED: "Retested",
  BROKEN: "Broken",
};

export const LIFECYCLE_CLASS: Record<LifecycleState, string> = {
  CONFIRMED_FRESH:
    "border-emerald-400/25 bg-emerald-400/10 text-emerald-400",
  TOUCHED_ONCE: "border-amber-400/25 bg-amber-400/10 text-amber-400",
  RETESTED: "border-orange-400/25 bg-orange-400/10 text-orange-400",
  BROKEN: "border-rose-500/20 bg-rose-500/5 text-rose-400",
};

export const SIDE_META: Record<
  ZoneSide,
  { label: string; text: string; dot: string; border: string }
> = {
  DEMAND: {
    label: "Demand",
    text: "text-emerald-400",
    dot: "bg-emerald-400",
    border: "border-emerald-500/25",
  },
  SUPPLY: {
    label: "Supply",
    text: "text-rose-400",
    dot: "bg-rose-400",
    border: "border-rose-500/25",
  },
};

export const COVERAGE_META: Record<
  LiveTradeZoneCoverage,
  { label: string; tone: Tone; description: string }
> = {
  AVAILABLE: {
    label: "Zones available",
    tone: "success",
    description:
      "The scanner has a completed scan covering this stock. Scan freshness reflects the latest covering scan; each zone keeps its own formation date.",
  },
  NO_ZONES: {
    label: "No zones detected",
    tone: "neutral",
    description:
      "The scanner has covered this stock, but its latest completed scan found no qualifying demand or supply zones.",
  },
  OUTSIDE_SCANNER_UNIVERSE: {
    label: "Outside scanner universe",
    tone: "info",
    description:
      "This stock is not part of the scanner's tracked universe, so structural zones are not produced for it.",
  },
  NO_SCAN_HISTORY: {
    label: "No scan history",
    tone: "neutral",
    description:
      "No completed scan covering this stock was found. Zones will appear after the scanner covers it.",
  },
  STALE: {
    label: "Scanner data stale",
    tone: "warning",
    description:
      "The latest completed scan covering this stock is older than the freshness threshold. These zones are historical, not a current structural read.",
  },
  UNKNOWN: {
    label: "Coverage unknown",
    tone: "neutral",
    description:
      "Coverage could not be determined from the available scan data.",
  },
};

export const TIMEFRAME_MATCH_LABEL = {
  PREFERRED: "Preferred TF",
  FALLBACK: "Fallback TF",
  ANY: "Any TF",
} as const;

export const QUOTE_FRESHNESS_META: Record<
  string,
  { label: string; tone: Tone }
> = {
  LIVE: { label: "Live", tone: "success" },
  DELAYED: { label: "Delayed", tone: "warning" },
  LAST_CLOSE: { label: "Last close", tone: "info" },
  UNAVAILABLE: { label: "Unavailable", tone: "neutral" },
  SIGN_IN_REQUIRED: { label: "Sign in required", tone: "warning" },
  STALE: { label: "Stale", tone: "warning" },
};

export const QUOTE_ERROR_TEXT: Record<LiveTradeQuoteErrorCode, string> = {
  QUOTE_NOT_RETURNED: "The provider did not return a quote for this instrument.",
  QUOTE_INVALID: "The provider returned an invalid price.",
  QUOTE_TIMESTAMP_INVALID: "The quote time could not be validated.",
};

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `₹${formatINR(value)}`;
}

export function formatDistance(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return formatPercent(value);
}

export function formatDateOnly(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

export function formatDateTimeIst(iso: string | null | undefined): string {
  return iso ? formatDateTime(iso) : "—";
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-IN");
}

export function scoreTextClass(score: number): string {
  if (score >= 70) return "text-emerald-400";
  if (score >= 45) return "text-amber-400";
  return "text-slate-300";
}

export const COVERAGE_ORDER: LiveTradeZoneCoverage[] = [
  "AVAILABLE",
  "NO_ZONES",
  "OUTSIDE_SCANNER_UNIVERSE",
  "NO_SCAN_HISTORY",
  "STALE",
  "UNKNOWN",
];
