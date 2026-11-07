/**
 * PATCH /api/live-trade/groups/reorder
 *
 * Applies a complete new group order. The submitted set must match the
 * owner's group set exactly; a concurrent change surfaces as REORDER_STALE.
 */

import type { NextRequest } from "next/server";
import {
  handleLiveTrade,
  liveTradeJson,
  readLiveTradeJsonBody,
} from "@/lib/live-trade/http";
import { reorderGroups } from "@/lib/live-trade/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  return handleLiveTrade(req, { mutation: true }, async ({ ownerId }) => {
    const body = await readLiveTradeJsonBody(req);
    const groups = await reorderGroups(ownerId, body);
    return liveTradeJson({ groups });
  });
}
