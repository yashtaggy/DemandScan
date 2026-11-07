/**
 * PATCH  /api/live-trade/items/[itemId]
 * DELETE /api/live-trade/items/[itemId]?version=N
 *
 * Updates use optimistic concurrency: `version` must match the stored row.
 * Deletes take the expected version from the query string. A malformed id is
 * rejected with 400 INVALID_QUERY before the body is read; a valid id that is
 * missing or owned by someone else is 404 NOT_FOUND.
 */

import type { NextRequest } from "next/server";
import {
  handleLiveTrade,
  liveTradeJson,
  readLiveTradeJsonBody,
  requirePathUuid,
} from "@/lib/live-trade/http";
import { deleteItem, updateItem } from "@/lib/live-trade/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ itemId: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  return handleLiveTrade(req, { mutation: true }, async ({ ownerId }) => {
    const { itemId } = await ctx.params;
    const id = requirePathUuid(itemId);
    const body = await readLiveTradeJsonBody(req);
    return liveTradeJson(await updateItem(ownerId, id, body));
  });
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  return handleLiveTrade(req, { mutation: true }, async ({ ownerId }) => {
    const { itemId } = await ctx.params;
    const id = requirePathUuid(itemId);
    const version = new URL(req.url).searchParams.get("version");
    await deleteItem(ownerId, id, version);
    return liveTradeJson({ deleted: true });
  });
}
