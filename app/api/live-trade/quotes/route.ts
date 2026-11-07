/**
 * GET /api/live-trade/quotes[?instrumentIds=1,2]
 *
 * Batched market snapshot for the authenticated owner's selected instruments.
 * The owner is resolved from the server-side Kite session; the request never
 * supplies an owner. An empty selection returns an empty success response
 * without a provider call or a cooldown claim.
 *
 * This is a read endpoint, but it writes only short-lived cooldown metadata.
 * The claim is committed before the Kite request, so no transaction or row
 * lock is held while the provider is slow.
 */

import type { NextRequest } from "next/server";
import { handleLiveTrade, liveTradeJson } from "@/lib/live-trade/http";
import { parseQuoteQuery } from "@/lib/live-trade/query";
import { getLiveQuotes } from "@/lib/live-trade/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleLiveTrade(req, {}, async ({ ownerId, session }) => {
    const query = parseQuoteQuery(new URL(req.url).searchParams);
    return liveTradeJson(
      await getLiveQuotes(ownerId, session, query.instrumentIds)
    );
  });
}
