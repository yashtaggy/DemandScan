/**
 * GET /api/live-trade/instruments?q=INFY
 *
 * Case-insensitive partial search over the active NSE instrument master by
 * symbol or company name. Results are capped and deterministic. The endpoint
 * never triggers an instrument sync; it reports master freshness separately.
 */

import type { NextRequest } from "next/server";
import { handleLiveTrade, liveTradeJson } from "@/lib/live-trade/http";
import { searchInstruments } from "@/lib/live-trade/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleLiveTrade(req, {}, async ({ ownerId }) => {
    const q = new URL(req.url).searchParams.get("q");
    return liveTradeJson(await searchInstruments(ownerId, q));
  });
}
