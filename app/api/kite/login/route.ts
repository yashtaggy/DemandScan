/**
 * GET /api/kite/login
 *
 * Redirects the user to Zerodha's official Kite Connect login page.
 * No credentials are returned to the browser; only a redirect is issued.
 *
 * The redirect URL registered in the Kite developer console is set via
 * KITE_REDIRECT_URL env var. It must match what is registered in the console.
 * The SDK's getLoginURL() builds the URL using the api_key parameter.
 */

import { type NextRequest, NextResponse } from "next/server";
import { KiteConnect } from "kiteconnect";
import { getKiteApiKey, areKiteEnvVarsSet } from "@/lib/env";


export async function GET(_req: NextRequest) {
  // Verify environment is configured before attempting any redirect
  if (!areKiteEnvVarsSet()) {
    return NextResponse.json(
      {
        error:
          "Kite Connect credentials are not configured. " +
          "Copy .env.example to .env.local and fill in KITE_API_KEY, KITE_API_SECRET, and KITE_REDIRECT_URL.",
        code: "ENV_NOT_CONFIGURED",
      },
      { status: 503 }
    );
  }

  try {
    const apiKey = getKiteApiKey();

    // KiteConnect builds the login URL as:
    // https://kite.trade/connect/login?api_key=<key>&v=3
    // The redirect URL must be registered in the Kite developer console
    // and is not passed as a constructor param.
    const kc = new KiteConnect({ api_key: apiKey });
    const loginUrl = kc.getLoginURL();

    // Redirect to Zerodha — no credentials in the URL we construct
    return NextResponse.redirect(loginUrl, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Do NOT expose credentials or stack traces
    console.error("[kite/login] Failed to build login URL:", message);
    return NextResponse.json(
      { error: "Failed to initiate Kite Connect login.", code: "LOGIN_INIT_FAILED" },
      { status: 500 }
    );
  }
}
