/**
 * PATCH /api/live-trade/items/reorder
 *
 * Applies a complete new item order. The submitted set must match the owner's
 * item set exactly; a concurrent change surfaces as REORDER_STALE.
 */

import type { NextRequest } from "next/server";
import {
  handleLiveTrade,
  liveTradeJson,
  readLiveTradeJsonBody,
} from "@/lib/live-trade/http";
import { reorderItems } from "@/lib/live-trade/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  return handleLiveTrade(req, { mutation: true }, async ({ ownerId }) => {
    const body = await readLiveTradeJsonBody(req);
    const items = await reorderItems(ownerId, body);
    return liveTradeJson({ items });
  });
}
