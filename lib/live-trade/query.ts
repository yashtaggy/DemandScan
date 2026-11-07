/**
 * Strict query-string parsing for the Phase 5 read endpoints.
 *
 * Every value is validated before it reaches SQL. Instrument identifiers are
 * bounded and deduplicated, page sizes cannot exceed the approved limits, and
 * the paging window cannot exceed the per-interaction batch ceiling.
 *
 * These parsers throw `LiveTradeError('INVALID_QUERY')` directly: the service
 * and route layers already map that error through the shared envelope.
 */

import {
  LIVE_TRADE_ITEM_LIMIT,
  LIVE_TRADE_TIMEFRAMES,
  LIVE_TRADE_ZONE_BATCH_MAX,
  LIVE_TRADE_ZONE_PAGE_DEFAULT,
  LIVE_TRADE_ZONE_PAGE_MAX,
  type LiveTradeTimeframe,
} from "./constants";
import { LiveTradeError } from "./errors";
import { isLiveTradeTimeframe } from "./validation";

function invalid(message: string): never {
  throw new LiveTradeError("INVALID_QUERY", message);
}

function parsePositiveInteger(token: string, field: string): number {
  if (!/^[1-9][0-9]*$/.test(token)) {
    invalid(`${field} must contain positive integers.`);
  }
  const value = Number(token);
  if (!Number.isSafeInteger(value)) {
    invalid(`${field} contains an out-of-range integer.`);
  }
  return value;
}

/**
 * `instrumentIds` is a comma-separated list. Absent means "all selected
 * instruments"; present but blank is invalid rather than silently interpreted
 * as "none".
 */
export function parseInstrumentIdList(
  raw: string | null,
  field = "instrumentIds"
): number[] | undefined {
  if (raw === null) return undefined;

  const trimmed = raw.trim();
  if (trimmed === "") invalid(`${field} must not be empty.`);

  const tokens = trimmed.split(",").map((token) => token.trim());
  if (tokens.length > LIVE_TRADE_ITEM_LIMIT) {
    invalid(`${field} must contain at most ${LIVE_TRADE_ITEM_LIMIT} instruments.`);
  }

  const seen = new Set<number>();
  const ids: number[] = [];
  for (const token of tokens) {
    const id = parsePositiveInteger(token, field);
    if (seen.has(id)) invalid(`${field} must not contain duplicates.`);
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export interface BoardQuery {
  /** When false the board omits structural-zone summaries. */
  includeZones: boolean;
}

/**
 * `/board` defaults to the complete workspace. A client that renders zone
 * evidence separately can ask for the shell only, skipping the coverage work.
 */
export function parseBoardQuery(searchParams: URLSearchParams): BoardQuery {
  const raw = searchParams.get("includeZones");
  if (raw === null) return { includeZones: true };
  return { includeZones: parseBoolean(raw, "includeZones") };
}

export interface QuoteQuery {
  /** `undefined` means every instrument on the owner's board. */
  instrumentIds?: number[];
}

export function parseQuoteQuery(searchParams: URLSearchParams): QuoteQuery {
  const instrumentIds = parseInstrumentIdList(searchParams.get("instrumentIds"));
  return instrumentIds === undefined ? {} : { instrumentIds };
}

export interface ZoneListQuery {
  /** `undefined` means every instrument on the owner's board. */
  instrumentIds?: number[];
  /** `true` when the caller supplied `timeframe`; `null` means all timeframes. */
  hasTimeframeOverride: boolean;
  timeframeOverride: LiveTradeTimeframe | null;
  includeExpanded: boolean;
  /** When false only the expanded page is produced. */
  includeSummaries: boolean;
  limit: number;
  offset: number;
}

function parseTimeframeOverride(
  raw: string | null
): { present: boolean; value: LiveTradeTimeframe | null } {
  if (raw === null) return { present: false, value: null };

  const normalized = raw.trim().toUpperCase();
  if (normalized === "") invalid("timeframe must not be empty.");
  if (normalized === "ANY") return { present: true, value: null };
  if (!isLiveTradeTimeframe(normalized)) {
    invalid(
      `timeframe must be one of: ${LIVE_TRADE_TIMEFRAMES.join(", ")} or any.`
    );
  }
  return { present: true, value: normalized };
}

function parseBoolean(raw: string | null, field: string): boolean {
  if (raw === null) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  invalid(`${field} must be true or false.`);
}

function parseBoundedInteger(
  raw: string | null,
  field: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (raw === null) return defaultValue;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    invalid(`${field} must be a non-negative integer.`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${field} must be between ${min} and ${max}.`);
  }
  return value;
}

export function parseZoneListQuery(searchParams: URLSearchParams): ZoneListQuery {
  const instrumentIds = parseInstrumentIdList(searchParams.get("instrumentIds"));
  const timeframe = parseTimeframeOverride(searchParams.get("timeframe"));
  const includeExpanded = parseBoolean(
    searchParams.get("includeExpanded"),
    "includeExpanded"
  );
  const includeSummariesRaw = searchParams.get("includeSummaries");
  const includeSummaries =
    includeSummariesRaw === null
      ? true
      : parseBoolean(includeSummariesRaw, "includeSummaries");

  const limit = parseBoundedInteger(
    searchParams.get("limit"),
    "limit",
    LIVE_TRADE_ZONE_PAGE_DEFAULT,
    1,
    LIVE_TRADE_ZONE_PAGE_MAX
  );
  const offset = parseBoundedInteger(
    searchParams.get("offset"),
    "offset",
    0,
    0,
    LIVE_TRADE_ZONE_BATCH_MAX - 1
  );

  if (offset + limit > LIVE_TRADE_ZONE_BATCH_MAX) {
    invalid(
      `offset + limit must not exceed ${LIVE_TRADE_ZONE_BATCH_MAX}.`
    );
  }

  return {
    ...(instrumentIds === undefined ? {} : { instrumentIds }),
    hasTimeframeOverride: timeframe.present,
    timeframeOverride: timeframe.value,
    includeExpanded,
    includeSummaries,
    limit,
    offset,
  };
}
