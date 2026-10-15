/**
 * GET /api/kite/quote?symbol=NSE:INFY
 *
 * Returns a live quote for a single instrument.
 * Requires an active Kite session.
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
  let session;
  try {
    session = await requireSession();
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
    if (message.includes("InputException") || message.includes("Invalid")) {
      return NextResponse.json(
        { error: `Invalid instrument: ${symbol}`, code: "INVALID_INSTRUMENT" },
        { status: 400 }
      );
    }
    if (message.includes("TokenException")) {
      return NextResponse.json(
        { error: "Kite session expired. Please reconnect.", code: "TOKEN_EXPIRED" },
        { status: 401 }
      );
    }
    if (message.includes("NetworkException") || message.includes("ECONNREFUSED")) {
      return NextResponse.json(
        { error: "Network error contacting Kite Connect.", code: "NETWORK_ERROR" },
        { status: 502 }
      );
    }

    console.error(`[kite/quote] Unhandled error for ${symbol}:`, message);
    return NextResponse.json(
      { error: "Failed to retrieve quote.", code: "QUOTE_ERROR" },
      { status: 500 }
    );
  }
}
