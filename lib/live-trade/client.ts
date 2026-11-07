/**
 * Browser-side Live Trade API client.
 *
 * Only the public HTTP contract is used here: the owner is always resolved by
 * the server from the HttpOnly Kite session cookie, so no identity, token or
 * owner value ever appears in a request built by this module.
 *
 * Every call is `no-store`; the client deliberately keeps no quote cache of its
 * own. Retained quote snapshots belong to the quotes hook, which labels them as
 * STALE or SIGN_IN_REQUIRED rather than presenting them as current.
 */

import type {
  LiveTradeDirection,
  LiveTradePriority,
  LiveTradeStatus,
  LiveTradeTimeframe,
} from "./constants";
import type {
  InstrumentSearchResultDto,
  LiveTradeGroupDto,
  LiveTradeItemDto,
} from "./repository";
import type {
  InstrumentSearchResponseDto,
  LiveTradeBoardDto,
  LiveTradeExpandedZoneDto,
  LiveTradeNearestZoneDto,
  LiveTradeQuoteDto,
  LiveTradeQuotesResponseDto,
  LiveTradeZoneSummaryDto,
  LiveTradeZonesResponseDto,
} from "./service";

export type {
  InstrumentSearchResponseDto,
  InstrumentSearchResultDto,
  LiveTradeBoardDto,
  LiveTradeExpandedZoneDto,
  LiveTradeGroupDto,
  LiveTradeItemDto,
  LiveTradeNearestZoneDto,
  LiveTradeQuoteDto,
  LiveTradeQuotesResponseDto,
  LiveTradeZoneSummaryDto,
  LiveTradeZonesResponseDto,
};

const DEFAULT_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: "Connect your Kite account to use Live Trade.",
  TOKEN_EXPIRED: "Your Kite session has expired. Reconnect to continue.",
  FORBIDDEN: "This action is not allowed from the current page.",
  NOT_FOUND: "That record no longer exists.",
  INVALID_BODY: "Check the highlighted fields and try again.",
  INVALID_QUERY: "The request was not valid.",
  DUPLICATE_ITEM: "That stock is already on your board.",
  DUPLICATE_GROUP: "A group with that name already exists.",
  ITEM_LIMIT: "Your board already has the maximum of 200 instruments.",
  GROUP_LIMIT: "You already have the maximum of 20 groups.",
  EDIT_CONFLICT:
    "This item changed in another request. Review the latest version and save again.",
  REORDER_STALE:
    "The saved order changed elsewhere. The board was reloaded; try again.",
  WRITE_BUSY: "The board is busy right now. Please try again.",
  PAYLOAD_TOO_LARGE: "That change is too large to save.",
  INVALID_GROUP: "The selected group is not available.",
  INSTRUMENT_NOT_SYNCED:
    "That instrument is not in the synchronized NSE list yet.",
  INSTRUMENT_INACTIVE: "That instrument is not currently tradeable.",
  QUOTE_COOLDOWN: "Quotes were requested too recently. Please wait.",
  RATE_LIMITED:
    "The market data provider is rate limiting requests. Try again shortly.",
  QUOTE_FETCH_FAILED:
    "Live quotes are temporarily unavailable. Your board is unaffected.",
  INTERNAL: "The server could not complete the request. Please try again.",
  NETWORK: "Could not reach the server. Check your connection and try again.",
  INVALID_RESPONSE: "The server returned an unexpected response.",
};

export class LiveTradeClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    options: {
      status: number;
      code: string;
      details?: Record<string, unknown>;
      retryAfterSeconds?: number | null;
    }
  ) {
    super(message);
    this.name = "LiveTradeClientError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export function isLiveTradeClientError(
  value: unknown
): value is LiveTradeClientError {
  return value instanceof LiveTradeClientError;
}

export function isAbortError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    (value as { name?: unknown }).name === "AbortError"
  );
}

export function liveTradeErrorMessage(value: unknown): string {
  if (value instanceof Error && value.message.trim() !== "") {
    return value.message;
  }
  return "Something went wrong. Please try again.";
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^[0-9]+$/.test(trimmed)) {
    return Math.max(0, Math.ceil(Number(trimmed)));
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SuccessEnvelope {
  success: true;
  data: unknown;
}

function isSuccessEnvelope(value: unknown): value is SuccessEnvelope {
  return isRecord(value) && value.success === true && "data" in value;
}

async function request<T>(
  path: string,
  init: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      credentials: "same-origin",
      signal: init.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new LiveTradeClientError(DEFAULT_MESSAGES.NETWORK, {
      status: 0,
      code: "NETWORK",
    });
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const record = isRecord(payload) ? payload : null;
    const code =
      typeof record?.code === "string" ? record.code : "INVALID_RESPONSE";
    const details = isRecord(record?.details) ? record.details : undefined;
    const retryAfterSeconds =
      parseRetryAfter(response.headers.get("Retry-After")) ??
      (typeof details?.retryAfterSeconds === "number"
        ? Math.max(0, Math.ceil(details.retryAfterSeconds))
        : null);
    const message =
      typeof record?.error === "string" && record.error.trim() !== ""
        ? record.error
        : DEFAULT_MESSAGES[code] ?? DEFAULT_MESSAGES.INTERNAL;

    throw new LiveTradeClientError(message, {
      status: response.status,
      code,
      details,
      retryAfterSeconds,
    });
  }

  if (!isSuccessEnvelope(payload)) {
    throw new LiveTradeClientError(DEFAULT_MESSAGES.INVALID_RESPONSE, {
      status: response.status,
      code: "INVALID_RESPONSE",
    });
  }

  return payload.data as T;
}

function instrumentIdList(ids: number[]): string {
  return ids.join(",");
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function getBoard(signal?: AbortSignal): Promise<LiveTradeBoardDto> {
  return request<LiveTradeBoardDto>("/api/live-trade/board", { signal });
}

export function searchInstruments(
  query: string,
  signal?: AbortSignal
): Promise<InstrumentSearchResponseDto> {
  const params = new URLSearchParams({ q: query });
  return request<InstrumentSearchResponseDto>(
    `/api/live-trade/instruments?${params.toString()}`,
    { signal }
  );
}

export function getQuotes(
  instrumentIds?: number[],
  signal?: AbortSignal
): Promise<LiveTradeQuotesResponseDto> {
  const params = new URLSearchParams();
  if (instrumentIds !== undefined) {
    params.set("instrumentIds", instrumentIdList(instrumentIds));
  }
  const query = params.toString();
  return request<LiveTradeQuotesResponseDto>(
    `/api/live-trade/quotes${query ? `?${query}` : ""}`,
    { signal }
  );
}

export interface ZoneRequest {
  instrumentIds?: number[];
  /** Absent keeps each item's saved timeframe; `null` means all timeframes. */
  timeframe?: LiveTradeTimeframe | null;
  includeExpanded?: boolean;
  limit?: number;
  offset?: number;
}

export function getZones(
  options: ZoneRequest = {},
  signal?: AbortSignal
): Promise<LiveTradeZonesResponseDto> {
  const params = new URLSearchParams();
  if (options.instrumentIds !== undefined) {
    params.set("instrumentIds", instrumentIdList(options.instrumentIds));
  }
  if (options.timeframe !== undefined) {
    params.set("timeframe", options.timeframe ?? "any");
  }
  if (options.includeExpanded) params.set("includeExpanded", "true");
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));

  const query = params.toString();
  return request<LiveTradeZonesResponseDto>(
    `/api/live-trade/zones${query ? `?${query}` : ""}`,
    { signal }
  );
}

// ─── Item mutations ──────────────────────────────────────────────────────────

export interface CreateItemPayload {
  instrumentId: number;
  groupId?: string | null;
  priority?: LiveTradePriority;
}

export interface UpdateItemPayload {
  version: number;
  groupId?: string | null;
  priority?: LiveTradePriority;
  direction?: LiveTradeDirection | null;
  timeframe?: LiveTradeTimeframe | null;
  entryPrice?: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  notes?: string;
  tradeStatus?: LiveTradeStatus;
}

export function createItem(payload: CreateItemPayload): Promise<LiveTradeItemDto> {
  return request<LiveTradeItemDto>("/api/live-trade/items", {
    method: "POST",
    body: payload,
  });
}

export function updateItem(
  itemId: string,
  payload: UpdateItemPayload
): Promise<LiveTradeItemDto> {
  return request<LiveTradeItemDto>(
    `/api/live-trade/items/${encodeURIComponent(itemId)}`,
    { method: "PATCH", body: payload }
  );
}

export async function deleteItem(itemId: string, version: number): Promise<void> {
  await request<{ deleted: true }>(
    `/api/live-trade/items/${encodeURIComponent(itemId)}?version=${version}`,
    { method: "DELETE" }
  );
}

export async function reorderItems(orderedItemIds: string[]): Promise<LiveTradeItemDto[]> {
  const data = await request<{ items: LiveTradeItemDto[] }>(
    "/api/live-trade/items/reorder",
    { method: "PATCH", body: { orderedItemIds } }
  );
  return data.items;
}

// ─── Group mutations ─────────────────────────────────────────────────────────

export function createGroup(name: string): Promise<LiveTradeGroupDto> {
  return request<LiveTradeGroupDto>("/api/live-trade/groups", {
    method: "POST",
    body: { name },
  });
}

export function updateGroup(
  groupId: string,
  name: string,
  version: number
): Promise<LiveTradeGroupDto> {
  return request<LiveTradeGroupDto>(
    `/api/live-trade/groups/${encodeURIComponent(groupId)}`,
    { method: "PATCH", body: { name, version } }
  );
}

export async function deleteGroup(groupId: string, version: number): Promise<void> {
  await request<{ deleted: true }>(
    `/api/live-trade/groups/${encodeURIComponent(groupId)}?version=${version}`,
    { method: "DELETE" }
  );
}

export async function reorderGroups(
  orderedGroupIds: string[]
): Promise<LiveTradeGroupDto[]> {
  const data = await request<{ groups: LiveTradeGroupDto[] }>(
    "/api/live-trade/groups/reorder",
    { method: "PATCH", body: { orderedGroupIds } }
  );
  return data.groups;
}
