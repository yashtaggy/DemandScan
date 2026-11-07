/**
 * Live Trade domain types — request shapes and the resolved owner identity.
 *
 * Repositories (Phase 3) accept `LiveTradeOwnerId` instead of a raw string so
 * an owner value can only originate from `resolveLiveTradeOwner`, which reads
 * the server-side Kite session.
 */

import type { KiteSession } from "@/lib/types";
import type {
  LiveTradeDirection,
  LiveTradePriority,
  LiveTradeStatus,
  LiveTradeTimeframe,
} from "./constants";

/**
 * Branded owner identifier. A plain `string` is not assignable to it — the only
 * producer is the session-based resolver in ./ownership.
 */
export type LiveTradeOwnerId = string & {
  readonly __brand: "LiveTradeOwnerId";
};

export interface LiveTradeOwnerContext {
  ownerId: LiveTradeOwnerId;
  /** Verified session; provides the Kite access token for quote retrieval. */
  session: KiteSession;
}

/** Normalized, validated create payload. Every field has a concrete value. */
export interface CreateLiveTradeItemInput {
  instrumentId: number;
  groupId: string | null;
  priority: LiveTradePriority;
  direction: LiveTradeDirection | null;
  /** `null` means Any timeframe. Omitted in the request becomes "1D". */
  timeframe: LiveTradeTimeframe | null;
  entryPrice: number | null;
  targetPrice: number | null;
  stopLoss: number | null;
  notes: string;
  tradeStatus: LiveTradeStatus;
}

/**
 * Validated patch. Absent fields are unchanged; `null` clears the field for
 * the nullable columns (groupId, direction, timeframe, prices).
 */
export interface UpdateLiveTradeItemInput {
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

export interface CreateLiveTradeGroupInput {
  name: string;
}

export interface UpdateLiveTradeGroupInput {
  name: string;
  version: number;
}

export interface LiveTradeReorderInput {
  orderedItemIds: string[];
}

export interface LiveTradeGroupReorderInput {
  orderedGroupIds: string[];
}
