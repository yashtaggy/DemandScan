/**
 * PATCH  /api/live-trade/groups/[groupId]
 * DELETE /api/live-trade/groups/[groupId]?version=N
 *
 * Renames use optimistic concurrency. Deletion ungroups the group's items and
 * removes the group atomically; every affected item's version increments.
 * A malformed id is rejected with 400 INVALID_QUERY before the body is read; a
 * valid id that is missing or owned by someone else is 404 NOT_FOUND.
 */

import type { NextRequest } from "next/server";
import {
  handleLiveTrade,
  liveTradeJson,
  readLiveTradeJsonBody,
  requirePathUuid,
} from "@/lib/live-trade/http";
import { deleteGroup, updateGroup } from "@/lib/live-trade/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ groupId: string }>;
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  return handleLiveTrade(req, { mutation: true }, async ({ ownerId }) => {
    const { groupId } = await ctx.params;
    const id = requirePathUuid(groupId);
    const body = await readLiveTradeJsonBody(req);
    return liveTradeJson(await updateGroup(ownerId, id, body));
  });
}

export async function DELETE(req: NextRequest, ctx: RouteContext) {
  return handleLiveTrade(req, { mutation: true }, async ({ ownerId }) => {
    const { groupId } = await ctx.params;
    const id = requirePathUuid(groupId);
    const version = new URL(req.url).searchParams.get("version");
    await deleteGroup(ownerId, id, version);
    return liveTradeJson({ deleted: true });
  });
}
