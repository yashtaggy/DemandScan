/**
 * GET /api/live-trade/zones
 *
 * Batched nearest demand/supply summaries for the owner's selected
 * instruments, with an optional paginated expanded list for one instrument.
 *
 * Query parameters:
 *   instrumentIds   comma-separated ids limited to the owner's selection
 *   timeframe       a scanner timeframe or "any"; absent uses each item's value
 *   includeExpanded "true" requires exactly one instrument
 *   limit           1-500 (default 100)
 *   offset          0-4999; offset + limit <= 5000
 *
 * No quote is fetched. Expanded zones therefore never carry a distance.
 */

import type { NextRequest } from "next/server";
import { handleLiveTrade, liveTradeJson } from "@/lib/live-trade/http";
import { parseZoneListQuery } from "@/lib/live-trade/query";
import { getZoneOverviews } from "@/lib/live-trade/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleLiveTrade(req, {}, async ({ ownerId }) => {
    const query = parseZoneListQuery(new URL(req.url).searchParams);
    return liveTradeJson(await getZoneOverviews(ownerId, query));
  });
}
