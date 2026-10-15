/**
 * GET /api/kite/status
 *
 * Returns the current authentication status.
 * NEVER returns the access token, API key, or API secret.
 */

import { NextResponse } from "next/server";
import { sessionStore } from "@/lib/kite-session";
import { areKiteEnvVarsSet } from "@/lib/env";
import { getNSEMarketStatus } from "@/lib/kite-client";
import type { AuthStatus } from "@/lib/types";


export async function GET() {
  const session = await sessionStore.get();
  const marketStatus = getNSEMarketStatus();

  const authStatus: AuthStatus & { envConfigured: boolean; market: typeof marketStatus } = {
    authenticated: session !== null,
    userId: session?.userId,
    userName: session?.userName,
    loginTime: session?.loginTime,
    expiresAt: session?.expiresAt,
    sessionValid: session !== null,
    envConfigured: areKiteEnvVarsSet(),
    market: marketStatus,
  };

  return NextResponse.json(authStatus, {
    headers: { "Cache-Control": "no-store" },
  });
}
