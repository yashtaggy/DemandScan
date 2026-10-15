/**
 * GET /api/kite/status
 *
 * Returns the current authentication status for the requesting browser session.
 * Resolves the session from the HttpOnly ds_sid cookie.
 * NEVER returns the access token, API key, API secret, or encryption key.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/kite-session";
import { areKiteEnvVarsSet, isDatabaseConfigured } from "@/lib/env";
import { getNSEMarketStatus } from "@/lib/kite-client";
import type { AuthStatus } from "@/lib/types";


export async function GET(req: NextRequest) {
  const cookieHeader = req.headers.get("cookie");
  const session = await getSessionFromRequest(cookieHeader);
  const marketStatus = getNSEMarketStatus();

  const authStatus: AuthStatus & {
    envConfigured: boolean;
    dbConfigured: boolean;
    market: typeof marketStatus;
  } = {
    authenticated: session !== null,
    userId: session?.userId,
    userName: session?.userName,
    loginTime: session?.loginTime,
    expiresAt: session?.expiresAt,
    sessionValid: session !== null,
    envConfigured: areKiteEnvVarsSet(),
    dbConfigured: isDatabaseConfigured(),
    market: marketStatus,
  };

  return NextResponse.json(authStatus, {
    headers: { "Cache-Control": "no-store" },
  });
}
