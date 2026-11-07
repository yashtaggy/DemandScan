/**
 * POST /api/live-trade/items
 *
 * Adds an instrument to the authenticated owner's board. The owner, sort
 * order and version are server-controlled and rejected if supplied.
 */

import type { NextRequest } from "next/server";
import {
  handleLiveTrade,
  liveTradeJson,
  readLiveTradeJsonBody,
} from "@/lib/live-trade/http";
import { createItem } from "@/lib/live-trade/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleLiveTrade(req, { mutation: true }, async ({ ownerId }) => {
    const body = await readLiveTradeJsonBody(req);
    const item = await createItem(ownerId, body);
    return liveTradeJson(item, 201);
  });
}
