/**
 * Market quote primitives for Live Trade.
 *
 * Pure classification helpers live here so freshness, change and distance
 * arithmetic can be tested without a clock, a database or Kite. The only
 * impure part is the provider adapter, which delegates to the existing Kite
 * quote service and is injected at the service boundary.
 *
 * Freshness is derived from the provider quote timestamp (the exchange quote
 * time), never from a stored price: this module has no quote cache. A client
 * that keeps the last successful response after a failed refresh labels it
 * STALE locally; the server never relabels an old timestamp as LIVE.
 */

import { normalizeKiteTimestamp } from "@/lib/kite-timestamp";
import { getQuotes } from "@/lib/kite-client";
import type { QuoteData } from "@/lib/types";
import {
  LIVE_TRADE_NSE_SESSION,
  LIVE_TRADE_QUOTE_FUTURE_TOLERANCE_SECONDS,
  LIVE_TRADE_QUOTE_LIVE_MAX_AGE_SECONDS,
  type LiveTradeQuoteFreshness,
} from "./constants";
import { LiveTradeError } from "./errors";

export interface QuoteProvider {
  fetchQuotes(
    accessToken: string,
    symbols: string[]
  ): Promise<Map<string, QuoteData>>;
}

/** Existing Kite batch quote service; no new provider client is introduced. */
export const kiteQuoteProvider: QuoteProvider = {
  fetchQuotes: (accessToken, symbols) => getQuotes(accessToken, symbols),
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Approximate NSE regular session: Monday–Friday, 09:15–15:30 IST.
 * Exchange holidays and special sessions are not modelled.
 */
export function isApproxNseMarketOpen(now: Date): boolean {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  if (day < 1 || day > 5) return false;

  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return (
    minutes >= LIVE_TRADE_NSE_SESSION.openMinutesIst &&
    minutes < LIVE_TRADE_NSE_SESSION.closeMinutesIst
  );
}

/**
 * Parses a provider timestamp; null when missing, unparseable or materially
 * in the future.
 *
 * Kite's adapter normalizes IST wall clocks and SDK `Date` objects before they
 * reach this function, so a `Date` here is an absolute instant. Raw strings
 * are still normalized defensively. When `now` is supplied, a timestamp more
 * than `LIVE_TRADE_QUOTE_FUTURE_TOLERANCE_SECONDS` ahead of it is rejected as
 * invalid, so clock skew cannot make an impossible quote `LIVE`.
 */
export function parseQuoteTimestamp(
  value: unknown,
  now?: Date
): Date | null {
  let parsed: Date | null;
  if (value instanceof Date) {
    parsed = Number.isNaN(value.getTime()) ? null : new Date(value);
  } else if (typeof value === "string" && value.trim() !== "") {
    const normalized = normalizeKiteTimestamp(value);
    parsed = normalized === null ? null : new Date(normalized);
  } else {
    parsed = null;
  }

  if (parsed === null) return null;
  if (now !== undefined) {
    const aheadMs = parsed.getTime() - now.getTime();
    if (aheadMs > LIVE_TRADE_QUOTE_FUTURE_TOLERANCE_SECONDS * 1000) {
      return null;
    }
  }
  return parsed;
}

export function isValidQuotePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Classifies a *valid* quote with a valid provider timestamp.
 *
 *  - Market open  + quote age <= threshold → LIVE
 *  - Market open  + quote age >  threshold → DELAYED
 *  - Market closed                          → LAST_CLOSE
 *
 * The timestamp is always exposed so a LAST_CLOSE snapshot is never mistaken
 * for a current session price.
 */
export function classifyQuoteFreshness(input: {
  quoteTimestamp: Date;
  now: Date;
  marketOpen: boolean;
}): LiveTradeQuoteFreshness {
  if (!input.marketOpen) return "LAST_CLOSE";
  const ageSeconds = (input.now.getTime() - input.quoteTimestamp.getTime()) / 1000;
  return ageSeconds <= LIVE_TRADE_QUOTE_LIVE_MAX_AGE_SECONDS
    ? "LIVE"
    : "DELAYED";
}

export interface QuoteChange {
  change: number | null;
  changePercent: number | null;
}

/**
 * Absolute/percentage change is only reported when the previous close is a
 * usable positive number. Unavailable values are null, never zero.
 */
export function computeQuoteChange(
  lastPrice: number,
  previousClose: unknown
): QuoteChange {
  if (!isValidQuotePrice(previousClose)) {
    return { change: null, changePercent: null };
  }
  const change = lastPrice - previousClose;
  return {
    change,
    changePercent: (change / previousClose) * 100,
  };
}

/**
 * Signed distance from the current price to a zone's proximal boundary:
 *
 *   distancePercent = ((currentPrice - proximal) / proximal) * 100
 *
 * Null when either side is missing, non-finite or non-positive; this avoids
 * division by zero and never invents a value.
 */
export function computeDistancePercent(
  currentPrice: unknown,
  proximal: unknown
): number | null {
  if (!isValidQuotePrice(currentPrice) || !isValidQuotePrice(proximal)) {
    return null;
  }
  return ((currentPrice - proximal) / proximal) * 100;
}

function numericStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[0-9]{3}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/**
 * Maps a provider failure to a public error without forwarding provider text.
 * Only safe metadata is logged.
 *
 * Kite rejects with a structured object carrying `error_type` (for example
 * `TokenException`, `PermissionException`, `NetworkException`), so structured
 * type and HTTP status are authoritative. Message matching is a fallback used
 * only when no structured type is present; a bare number inside an unrelated
 * message is not treated as a rate-limit signal.
 */
export function classifyQuoteProviderError(error: unknown): LiveTradeError {
  const source = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    error_type?: unknown;
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown; statusText?: unknown };
  };
  const name = typeof source.name === "string" ? source.name : "Error";
  const code = typeof source.code === "string" ? source.code : "unknown";
  const errorType =
    typeof source.error_type === "string"
      ? source.error_type.trim().toLowerCase()
      : "";
  const httpStatus =
    numericStatus(source.status) ??
    numericStatus(source.statusCode) ??
    numericStatus(source.response?.status);
  const message =
    typeof source.message === "string" ? source.message.toLowerCase() : "";

  console.error("[live-trade] quote provider failed", {
    name,
    code,
    errorType: errorType === "" ? "none" : errorType,
    httpStatus: httpStatus === null ? "none" : httpStatus,
  });

  if (errorType === "ratelimitexception" || httpStatus === 429) {
    return new LiveTradeError("RATE_LIMITED");
  }
  if (errorType === "tokenexception" || httpStatus === 401) {
    return new LiveTradeError("TOKEN_EXPIRED");
  }
  if (errorType === "permissionexception" || httpStatus === 403) {
    return new LiveTradeError(
      "FORBIDDEN",
      "Market data permission is not available for this session."
    );
  }
  if (
    errorType === "networkexception" ||
    errorType === "generalexception" ||
    errorType === "dataexception"
  ) {
    return new LiveTradeError("QUOTE_FETCH_FAILED");
  }

  if (errorType === "" && httpStatus === null) {
    if (/rate.?limit|too many requests|\bhttp\s*429\b/.test(message)) {
      return new LiveTradeError("RATE_LIMITED");
    }
    if (/tokenexception|invalid token|token expired|access token/.test(message)) {
      return new LiveTradeError("TOKEN_EXPIRED");
    }
    if (
      /permissionexception|permission denied|not permitted|\bhttp\s*403\b/.test(
        message
      )
    ) {
      return new LiveTradeError(
        "FORBIDDEN",
        "Market data permission is not available for this session."
      );
    }
  }

  return new LiveTradeError("QUOTE_FETCH_FAILED");
}
