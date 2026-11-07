/**
 * GET /api/live-trade/board
 *
 * Returns the authenticated owner's complete workspace: groups and items in
 * saved order, instrument-master freshness and batched nearest-zone summaries.
 * It performs no quote lookup and no scanner work, so the board is identical
 * whether or not the market is open.
 */

import type { NextRequest } from "next/server";
import { handleLiveTrade, liveTradeJson } from "@/lib/live-trade/http";
import { getBoard } from "@/lib/live-trade/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleLiveTrade(req, {}, async ({ ownerId }) => {
    return liveTradeJson(await getBoard(ownerId));
  });
}
