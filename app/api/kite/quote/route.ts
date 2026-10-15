/**
 * GET /api/kite/quote?symbol=NSE:INFY
 *
 * Returns a live quote for a single instrument.
 * Requires an active Kite session identified by the ds_sid cookie.
 *
 * Query params:
 *   symbol  — Required. Format: "EXCHANGE:TRADINGSYMBOL" (e.g. NSE:INFY)
 *
 * Returns clean JSON — never raw Kite responses, stack traces, or secrets.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/kite-session";
import { getQuotes } from "@/lib/kite-client";


// Allowed pattern: EXCHANGE:SYMBOL (alphanumeric, hyphens, ampersands)
const SYMBOL_PATTERN = /^[A-Z]{2,10}:[A-Z0-9&\-]{1,20}$/;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol")?.toUpperCase().trim();

  // ─── Input validation ──────────────────────────────────────────────────────
  if (!symbol) {
    return NextResponse.json(
      { error: "Missing required query parameter: symbol", code: "MISSING_SYMBOL" },
      { status: 400 }
    );
  }

  if (!SYMBOL_PATTERN.test(symbol)) {
    return NextResponse.json(
      {
        error:
          "Invalid symbol format. Expected EXCHANGE:TRADINGSYMBOL (e.g. NSE:INFY).",
        code: "INVALID_SYMBOL",
      },
      { status: 400 }
    );
  }

  // ─── Auth check ────────────────────────────────────────────────────────────
  const cookieHeader = req.headers.get("cookie");
  let session;
  try {
    session = await requireSession(cookieHeader);
  } catch {
    return NextResponse.json(
      { error: "Not authenticated. Please connect your Zerodha account.", code: "UNAUTHENTICATED" },
      { status: 401 }
    );
  }

  // ─── Fetch quote ───────────────────────────────────────────────────────────
  try {
    const quotes = await getQuotes(session.accessToken, [symbol]);
    const quote = quotes.get(symbol);

    if (!quote) {
      return NextResponse.json(
        { error: `No quote data returned for symbol: ${symbol}`, code: "NO_DATA" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { ok: true, symbol, data: quote },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    // Classify Kite API errors without leaking internals
    if (message.includes("TokenException") || message.includes("token")) {
      return NextResponse.json(
        { error: "Kite session expired. Please reconnect.", code: "TOKEN_EXPIRED" },
        { status: 401 }
      );
    }
    if (message.includes("PermissionException") || message.includes("subscription")) {
      return NextResponse.json(
        { error: "Permission denied. Check your Kite Connect subscription.", code: "PERMISSION_DENIED" },
        { status: 403 }
      );
    }
    if (message.includes("NetworkException") || message.includes("ECONNREFUSED")) {
      return NextResponse.json(
        { error: "Network error contacting Kite Connect.", code: "NETWORK_ERROR" },
        { status: 502 }
      );
    }
    // Only classify as invalid instrument when the error is clearly about the symbol,
    // not a generic "Invalid" which could be auth-related.
    if (message.includes("InputException")) {
      return NextResponse.json(
        { error: `Invalid instrument: ${symbol}`, code: "INVALID_INSTRUMENT" },
        { status: 400 }
      );
    }

    console.error(`[kite/quote] Unhandled error for ${symbol}:`, message);
    return NextResponse.json(
      { error: "Failed to retrieve quote.", code: "QUOTE_ERROR" },
      { status: 500 }
    );
  }
}
