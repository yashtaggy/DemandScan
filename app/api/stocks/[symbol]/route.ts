/**
 * GET /api/stocks/[symbol]
 *
 * Returns detailed quote data for a single stock.
 * symbol param: the trading symbol without exchange prefix (e.g. "INFY")
 * Exchange is always assumed to be NSE for this application.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/kite-session";
import { getNSEInstruments, getQuotes, buildStockRow } from "@/lib/kite-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYMBOL_PATTERN = /^[A-Z0-9&\-]{1,20}$/;

interface RouteContext {
  params: Promise<{ symbol: string }>;
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  const { symbol: rawSymbol } = await ctx.params;
  const symbol = rawSymbol?.toUpperCase().trim();

  if (!symbol || !SYMBOL_PATTERN.test(symbol)) {
    return NextResponse.json(
      { error: "Invalid symbol. Use only letters, numbers, hyphens, and ampersands.", code: "INVALID_SYMBOL" },
      { status: 400 }
    );
  }

  const cookieHeader = req.headers.get("cookie");
  let session;
  try {
    session = await requireSession(cookieHeader);
  } catch {
    return NextResponse.json(
      { error: "Not authenticated.", code: "UNAUTHENTICATED" },
      { status: 401 }
    );
  }

  const fullSymbol = `NSE:${symbol}`;

  try {
    const instruments = await getNSEInstruments(session.accessToken);
    const instrument = instruments.get(fullSymbol);

    if (!instrument) {
      return NextResponse.json(
        { error: `Instrument not found: ${symbol}. Not in NSE EQ segment or Kite instrument master.`, code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    const quotes = await getQuotes(session.accessToken, [fullSymbol]);
    const quote = quotes.get(fullSymbol);
    const stockRow = buildStockRow(fullSymbol, instrument, quote);

    return NextResponse.json(
      { ok: true, data: stockRow, quote: quote ?? null },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("TokenException")) {
      return NextResponse.json(
        { error: "Kite session expired. Please reconnect.", code: "TOKEN_EXPIRED" },
        { status: 401 }
      );
    }
    console.error(`[api/stocks/${symbol}] Error:`, message);
    return NextResponse.json(
      { error: "Failed to retrieve stock data.", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}
