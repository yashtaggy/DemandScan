/**
 * Live Trade API error model.
 *
 * Every route maps a `LiveTradeError` to `{ error, code, details? }` with the
 * status below, matching the existing DemandScan error envelope
 * (`{ error: string, code?: string }` in lib/types.ts) while adding a stable
 * machine-readable code for the client.
 */

export const LIVE_TRADE_ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_BODY: 400,
  INVALID_QUERY: 400,
  DUPLICATE_GROUP: 409,
  ITEM_LIMIT: 409,
  GROUP_LIMIT: 409,
  EDIT_CONFLICT: 409,
  REORDER_STALE: 409,
  WRITE_BUSY: 409,
  PAYLOAD_TOO_LARGE: 413,
  INVALID_GROUP: 422,
  INSTRUMENT_NOT_SYNCED: 422,
  INSTRUMENT_INACTIVE: 422,
  QUOTE_COOLDOWN: 429,
  RATE_LIMITED: 429,
  QUOTE_FETCH_FAILED: 502,
  INTERNAL: 500,
} as const;

export type LiveTradeErrorCode = keyof typeof LIVE_TRADE_ERROR_STATUS;

const DEFAULT_MESSAGES: Record<LiveTradeErrorCode, string> = {
  UNAUTHENTICATED: "Authentication required.",
  TOKEN_EXPIRED: "The Kite session has expired. Please sign in again.",
  FORBIDDEN: "You do not have permission to perform this action.",
  NOT_FOUND: "The requested record was not found.",
  INVALID_BODY: "The request body is invalid.",
  INVALID_QUERY: "The request parameters are invalid.",
  DUPLICATE_GROUP: "A group with that name already exists.",
  ITEM_LIMIT: "The board item limit has been reached.",
  GROUP_LIMIT: "The group limit has been reached.",
  EDIT_CONFLICT: "This record changed in another request. Reload and try again.",
  REORDER_STALE: "The item order changed. Reload and try again.",
  WRITE_BUSY: "The board is busy. Please retry.",
  PAYLOAD_TOO_LARGE: "The request is too large.",
  INVALID_GROUP: "The selected group is not available.",
  INSTRUMENT_NOT_SYNCED: "That instrument has not been synchronized yet.",
  INSTRUMENT_INACTIVE: "That instrument is not currently tradeable.",
  QUOTE_COOLDOWN: "Quotes were requested too recently. Please wait.",
  RATE_LIMITED: "The market data provider is rate limiting requests.",
  QUOTE_FETCH_FAILED: "Live quotes are temporarily unavailable.",
  INTERNAL: "An unexpected error occurred.",
};

export interface LiveTradeErrorBody {
  error: string;
  code: LiveTradeErrorCode;
  details?: Record<string, unknown>;
}

export class LiveTradeError extends Error {
  readonly code: LiveTradeErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: LiveTradeErrorCode,
    message?: string,
    details?: Record<string, unknown>
  ) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = "LiveTradeError";
    this.code = code;
    this.status = LIVE_TRADE_ERROR_STATUS[code];
    this.details = details;
  }

  /** Serializes to the public envelope. Never includes internal state. */
  toBody(): LiveTradeErrorBody {
    return this.details
      ? { error: this.message, code: this.code, details: this.details }
      : { error: this.message, code: this.code };
  }
}

export function isLiveTradeError(value: unknown): value is LiveTradeError {
  return value instanceof LiveTradeError;
}
