/**
 * GET /api/kite/callback
 *
 * Zerodha redirects here after successful authentication with:
 *   ?request_token=<token>&action=login&status=success
 *
 * This route:
 *  1. Validates the request_token parameter.
 *  2. Exchanges it for an access token using the Kite SDK (server-side only).
 *  3. Stores the access token in the server-side session store.
 *  4. NEVER returns the access token, request token, or API secret to the browser.
 *  5. Redirects to the dashboard on success.
 *
 * Security headers:
 *  - Cache-Control: no-store (prevent caching of sensitive callback URL)
 *  - Referrer-Policy: no-referrer (prevent leaking the callback URL)
 */

import { type NextRequest, NextResponse } from "next/server";
import { KiteConnect } from "kiteconnect";
import { getKiteApiKey, getKiteApiSecret } from "@/lib/env";
import { sessionStore, computeKiteTokenExpiry } from "@/lib/kite-session";
import type { KiteSession } from "@/lib/types";


const SENSITIVE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const status = searchParams.get("status");
  const requestToken = searchParams.get("request_token");
  const errorType = searchParams.get("error_type");
  const errorMessage = searchParams.get("message");

  // ─── Handle Zerodha-side errors ─────────────────────────────────────────────
  if (status === "failure" || errorType) {
    console.error(
      `[kite/callback] Zerodha login failed: type=${errorType} message=${errorMessage}`
    );
    return NextResponse.redirect(
      new URL(`/?auth_error=${encodeURIComponent(errorType ?? "login_failed")}`, req.url),
      { headers: SENSITIVE_HEADERS }
    );
  }

  // ─── Validate request_token ──────────────────────────────────────────────────
  if (!requestToken || requestToken.trim() === "") {
    console.error("[kite/callback] Missing request_token parameter.");
    return NextResponse.redirect(new URL("/?auth_error=missing_token", req.url), {
      headers: SENSITIVE_HEADERS,
    });
  }

  // ─── Exchange request_token for access_token ─────────────────────────────────
  try {
    const apiKey = getKiteApiKey();
    const apiSecret = getKiteApiSecret();

    const kc = new KiteConnect({ api_key: apiKey });
    // generateSession() computes HMAC-SHA256(api_key+request_token+api_secret)
    // and exchanges it with Zerodha for an access token.
    const sessionData = await kc.generateSession(requestToken, apiSecret);

    if (!sessionData?.access_token) {
      throw new Error("generateSession returned no access_token.");
    }

    const expiresAt = computeKiteTokenExpiry();

    const kiteSession: KiteSession = {
      accessToken: sessionData.access_token,
      userId: sessionData.user_id ?? "",
      userName: sessionData.user_name ?? "",
      email: sessionData.email ?? "",
      loginTime: sessionData.login_time ?? new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    await sessionStore.set(kiteSession);

    console.log(
      `[kite/callback] Session established for user=${kiteSession.userId} ` +
        `expires=${kiteSession.expiresAt}`
    );

    // Redirect to dashboard — access token is NEVER sent to the browser
    return NextResponse.redirect(new URL("/", req.url), {
      headers: SENSITIVE_HEADERS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[kite/callback] Session generation failed: ${message}`);

    // Return generic error to browser — no internal details
    return NextResponse.redirect(new URL("/?auth_error=session_failed", req.url), {
      headers: SENSITIVE_HEADERS,
    });
  }
}
