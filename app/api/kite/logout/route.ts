/**
 * POST /api/kite/logout
 *
 * Invalidates the current browser session:
 *  1. Resolves the session from the HttpOnly ds_sid cookie.
 *  2. Best-effort: calls Kite's invalidateAccessToken.
 *  3. Deletes the row from the database.
 *  4. Clears the session cookie (Max-Age=0).
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  sessionStore,
  getSessionIdFromCookies,
  getSessionFromRequest,
  SESSION_COOKIE_NAME,
} from "@/lib/kite-session";
import { createKiteClient } from "@/lib/kite-client";


export async function POST(req: NextRequest) {
  const cookieHeader = req.headers.get("cookie");
  const sessionId = getSessionIdFromCookies(cookieHeader);
  const session = await getSessionFromRequest(cookieHeader);

  if (session) {
    try {
      // Best-effort: invalidate the token on Kite's side
      const kc = createKiteClient(session.accessToken);
      await kc.invalidateAccessToken();
    } catch (err) {
      // Non-fatal — we always clear our local session regardless
      console.warn("[kite/logout] Could not invalidate Kite token:", (err as Error).message);
    }
  }

  if (sessionId) {
    await sessionStore.clear(sessionId);
  }

  const response = NextResponse.json(
    { ok: true, message: "Logged out successfully." },
    { headers: { "Cache-Control": "no-store" } }
  );

  // Clear the cookie
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return response;
}
