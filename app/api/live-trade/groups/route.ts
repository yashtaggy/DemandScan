/**
 * GET  /api/live-trade/groups
 * POST /api/live-trade/groups
 *
 * Groups are returned in saved order. Creation enforces the 20-group limit
 * and case-insensitive unique names; owner, sort order and version are
 * server-controlled.
 */

import type { NextRequest } from "next/server";
import {
  handleLiveTrade,
  liveTradeJson,
  readLiveTradeJsonBody,
} from "@/lib/live-trade/http";
import { createGroup, listGroups } from "@/lib/live-trade/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return handleLiveTrade(req, {}, async ({ ownerId }) => {
    return liveTradeJson({ groups: await listGroups(ownerId) });
  });
}

export async function POST(req: NextRequest) {
  return handleLiveTrade(req, { mutation: true }, async ({ ownerId }) => {
    const body = await readLiveTradeJsonBody(req);
    const group = await createGroup(ownerId, body);
    return liveTradeJson(group, 201);
  });
}
