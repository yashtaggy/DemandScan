/**
 * Live Trade domain constants — approved enums, defaults and limits.
 *
 * These values mirror the database constraints in
 * db/migrations/2026-11-06-add-live-trade.sql. Keep the two in sync: the
 * schema contract tests assert the SQL side, the domain tests assert this side.
 */

import type { Timeframe } from "@/lib/scanner/types";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const LIVE_TRADE_PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;
export type LiveTradePriority = (typeof LIVE_TRADE_PRIORITIES)[number];

export const LIVE_TRADE_DIRECTIONS = ["BUY", "SELL"] as const;
export type LiveTradeDirection = (typeof LIVE_TRADE_DIRECTIONS)[number];

/**
 * Same identifiers as the scanner's `Timeframe`. "1M" is Monthly and "6M" is
 * six-monthly — there is no 1-minute timeframe anywhere in DemandScan.
 *
 * `null` is this module's representation of "Any timeframe"; it is deliberately
 * not a member of the enum so it cannot be stored as a string.
 */
export const LIVE_TRADE_TIMEFRAMES = [
  "1H",
  "4H",
  "1D",
  "1W",
  "1M",
  "3M",
  "6M",
  "1Y",
] as const satisfies readonly Timeframe[];
export type LiveTradeTimeframe = (typeof LIVE_TRADE_TIMEFRAMES)[number];

export const LIVE_TRADE_STATUSES = [
  "WATCHING",
  "WAITING_FOR_ENTRY",
  "ACTIVE_TRADE",
  "TARGET_HIT",
  "STOP_LOSS_HIT",
  "CLOSED",
] as const;
export type LiveTradeStatus = (typeof LIVE_TRADE_STATUSES)[number];

// ─── Defaults applied on create ───────────────────────────────────────────────

/** Omitted timeframe on create means the "1D" preference, not "Any". */
export const DEFAULT_LIVE_TRADE_TIMEFRAME: LiveTradeTimeframe = "1D";
export const DEFAULT_LIVE_TRADE_PRIORITY: LiveTradePriority = "MEDIUM";
export const DEFAULT_LIVE_TRADE_STATUS: LiveTradeStatus = "WATCHING";

// ─── Limits (approved in the v2 specification) ────────────────────────────────

export const LIVE_TRADE_ITEM_LIMIT = 200;
export const LIVE_TRADE_GROUP_LIMIT = 20;

export const LIVE_TRADE_NOTES_MAX_LENGTH = 2000;
export const LIVE_TRADE_GROUP_NAME_MIN_LENGTH = 1;
export const LIVE_TRADE_GROUP_NAME_MAX_LENGTH = 60;
export const LIVE_TRADE_OWNER_ID_MAX_LENGTH = 64;

/** NUMERIC(18,4) with a sane upper bound for Indian equity prices. */
export const LIVE_TRADE_PRICE_MAX = 1_000_000_000;
export const LIVE_TRADE_PRICE_DECIMALS = 4;

/** `version` is a PostgreSQL INTEGER. */
export const LIVE_TRADE_VERSION_MIN = 1;
export const LIVE_TRADE_VERSION_MAX = 2_147_483_647;

// ─── Instrument master ────────────────────────────────────────────────────────

/** Maximum number of search results returned by the instrument lookup. */
export const LIVE_TRADE_INSTRUMENT_SEARCH_LIMIT = 20;
/** Longest accepted search term, in code points. */
export const LIVE_TRADE_INSTRUMENT_QUERY_MAX_LENGTH = 50;

// ─── Market snapshot (Phase 5) ────────────────────────────────────────────────

/**
 * Per-owner floor between two quote fetches. This is a server-side abuse guard,
 * not the client polling interval: a client may poll every 30 seconds while the
 * server rejects any second request that arrives within 5 seconds.
 *
 * Enforced by one atomic statement against `live_trade_quote_state`, so it is
 * shared by every server instance. See repository.claimQuoteCooldown.
 */
export const LIVE_TRADE_QUOTE_COOLDOWN_SECONDS = 5;

/**
 * A quote is LIVE when the provider timestamp is no older than this during the
 * approximate NSE session. Older valid quotes are DELAYED.
 */
export const LIVE_TRADE_QUOTE_LIVE_MAX_AGE_SECONDS = 300;

/**
 * Tolerated provider clock skew. A timestamp further in the future than this is
 * treated as invalid (UNAVAILABLE) rather than LIVE, because it cannot come
 * from a real trade. A small allowance avoids rejecting a quote merely because
 * the exchange clock and the server clock differ by a second or two.
 */
export const LIVE_TRADE_QUOTE_FUTURE_TOLERANCE_SECONDS = 60;

/** Freshness states exposed by the quote DTO. */
export const LIVE_TRADE_QUOTE_FRESHNESS = [
  "LIVE",
  "DELAYED",
  "LAST_CLOSE",
  "UNAVAILABLE",
  "SIGN_IN_REQUIRED",
  "STALE",
] as const;
export type LiveTradeQuoteFreshness =
  (typeof LIVE_TRADE_QUOTE_FRESHNESS)[number];

/**
 * Safe per-instrument quote error codes. No provider text, HTTP detail or
 * session information is ever forwarded.
 */
export const LIVE_TRADE_QUOTE_ERROR_CODES = [
  "QUOTE_NOT_RETURNED",
  "QUOTE_INVALID",
  "QUOTE_TIMESTAMP_INVALID",
] as const;
export type LiveTradeQuoteErrorCode =
  (typeof LIVE_TRADE_QUOTE_ERROR_CODES)[number];

/**
 * Approximate NSE regular session (Monday–Friday, 09:15–15:30 IST). Exchange
 * holidays and special sessions are deliberately not modelled; callers must
 * treat this as an approximation.
 */
export const LIVE_TRADE_NSE_SESSION = {
  openMinutesIst: 9 * 60 + 15,
  closeMinutesIst: 15 * 60 + 30,
} as const;

// ─── Demand/supply zones (Phase 5) ────────────────────────────────────────────

/** Default and maximum expanded-zone page sizes. */
export const LIVE_TRADE_ZONE_PAGE_DEFAULT = 100;
export const LIVE_TRADE_ZONE_PAGE_MAX = 500;

/**
 * Maximum zones a single client interaction may page through. Offset-based
 * paging stops being useful beyond this because it is not snapshot-consistent.
 */
export const LIVE_TRADE_ZONE_BATCH_MAX = 5_000;

/**
 * A completed scan covering an instrument is considered fresh for this many
 * days. Zones are not rewritten when re-detected, so `zones.created_at` cannot
 * prove freshness; the latest covering successful scan is used instead.
 */
export const LIVE_TRADE_ZONE_FRESHNESS_DAYS = 7;

/** Scanner coverage states for an instrument. */
export const LIVE_TRADE_ZONE_COVERAGE = [
  "AVAILABLE",
  "NO_ZONES",
  "OUTSIDE_SCANNER_UNIVERSE",
  "NO_SCAN_HISTORY",
  "STALE",
  "UNKNOWN",
] as const;
export type LiveTradeZoneCoverage =
  (typeof LIVE_TRADE_ZONE_COVERAGE)[number];

/** Whether the nearest zone is in the preferred timeframe. */
export const LIVE_TRADE_ZONE_TIMEFRAME_MATCH = [
  "PREFERRED",
  "FALLBACK",
  "ANY",
] as const;
export type LiveTradeZoneTimeframeMatch =
  (typeof LIVE_TRADE_ZONE_TIMEFRAME_MATCH)[number];
