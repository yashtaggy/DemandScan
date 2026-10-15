/**
 * POST /api/kite/logout
 *
 * Clears the server-side session.
 * Optionally calls Kite's invalidateAccessToken if a valid session exists.
 */

import { NextResponse } from "next/server";
import { sessionStore } from "@/lib/kite-session";
import { createKiteClient } from "@/lib/kite-client";


export async function POST() {
  const session = await sessionStore.get();

  if (session) {
    try {
      // Best-effort: invalidate the token on Kite's side
      // createKiteClient returns a Connect instance which has invalidateAccessToken()
      const kc = createKiteClient(session.accessToken);
      await kc.invalidateAccessToken();
    } catch (err) {
      // Non-fatal — we always clear our local session regardless
      console.warn("[kite/logout] Could not invalidate Kite token:", (err as Error).message);
    }
  }

  await sessionStore.clear();

  return NextResponse.json(
    { ok: true, message: "Logged out successfully." },
    { headers: { "Cache-Control": "no-store" } }
  );
}
