/**
 * GET /api/live-trade/board
 *
 * Returns the authenticated owner's complete workspace: groups and items in
 * saved order, instrument-master freshness and batched nearest-zone summaries.
 * It performs no quote lookup and no scanner work, so the board is identical
 * whether or not the market is open.
 *
 * `?includeZones=false` omits structural-zone summaries so a client can render
 * the board shell first and load zone evidence separately.
 */

import type { NextRequest } from "next/server";
import { handleLiveTrade, liveTradeJson } from "@/lib/live-trade/http";
import { parseBoardQuery } from "@/lib/live-trade/query";
import { getBoard } from "@/lib/live-trade/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleLiveTrade(req, {}, async ({ ownerId }) => {
    const query = parseBoardQuery(new URL(req.url).searchParams);
    return liveTradeJson(await getBoard(ownerId, query));
  });
}
