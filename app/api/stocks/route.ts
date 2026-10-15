/**
 * GET /api/stocks
 *
 * Returns stock rows for all matched Nifty 500 constituents with live quotes.
 *
 * Query parameters (all optional):
 *   search      — Filter by symbol prefix
 *   sort        — "price" | "change" | "changePercent" | "volume" | "symbol" (default: "symbol")
 *   order       — "asc" | "desc" (default: "asc")
 *   filter      — "positive" | "negative" | "all" (default: "all")
 *   minChange   — Minimum absolute % change (e.g. "1.5")
 *   page        — Page number for pagination (default: 1)
 *   pageSize    — Items per page (default: 50, max: 200)
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/kite-session";
import { getNSEInstruments, getQuotes, buildStockRow } from "@/lib/kite-client";
import { getNifty500FullSymbols, NIFTY500_LAST_UPDATED } from "@/lib/nifty500";
import type { StockRow } from "@/lib/types";


type SortField = "price" | "change" | "changePercent" | "volume" | "symbol";
type SortOrder = "asc" | "desc";
type Filter = "positive" | "negative" | "all";

function parseIntParam(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  if (isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseFloatParam(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = parseFloat(value);
  return isNaN(n) ? fallback : n;
}

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────────────────
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json(
      { error: "Not authenticated. Please connect your Zerodha account.", code: "UNAUTHENTICATED" },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search")?.toUpperCase().trim() ?? "";
  const sort = (searchParams.get("sort") ?? "symbol") as SortField;
  const order = (searchParams.get("order") ?? "asc") as SortOrder;
  const filter = (searchParams.get("filter") ?? "all") as Filter;
  const minChange = parseFloatParam(searchParams.get("minChange"), 0);
  const page = parseIntParam(searchParams.get("page"), 1, 1, 10000);
  const pageSize = parseIntParam(searchParams.get("pageSize"), 50, 1, 200);

  const validSorts: SortField[] = ["price", "change", "changePercent", "volume", "symbol"];
  const validOrders: SortOrder[] = ["asc", "desc"];
  const validFilters: Filter[] = ["positive", "negative", "all"];

  if (!validSorts.includes(sort) || !validOrders.includes(order) || !validFilters.includes(filter)) {
    return NextResponse.json(
      { error: "Invalid sort, order, or filter parameter.", code: "INVALID_PARAMS" },
      { status: 400 }
    );
  }

  try {
    // ─── Instrument master ────────────────────────────────────────────────────
    const instrumentMap = await getNSEInstruments(session.accessToken);
    const nifty500 = getNifty500FullSymbols();

    // Match Nifty 500 symbols against instrument master
    const validSymbols = nifty500.filter((sym) => instrumentMap.has(sym));

    // ─── Batch quote fetch (max 500 per Kite request) ─────────────────────────
    const quotes = await getQuotes(session.accessToken, validSymbols);

    // ─── Build stock rows ─────────────────────────────────────────────────────
    let stocks: StockRow[] = validSymbols.map((sym) => {
      const instrument = instrumentMap.get(sym)!;
      const quote = quotes.get(sym);
      return buildStockRow(sym, instrument, quote);
    });

    // ─── Apply filters ────────────────────────────────────────────────────────
    if (search) {
      stocks = stocks.filter(
        (s) => s.symbol.startsWith(search) || s.name.toUpperCase().includes(search)
      );
    }

    if (filter === "positive") {
      stocks = stocks.filter((s) => s.changePercent > 0);
    } else if (filter === "negative") {
      stocks = stocks.filter((s) => s.changePercent < 0);
    }

    if (minChange > 0) {
      stocks = stocks.filter((s) => Math.abs(s.changePercent) >= minChange);
    }

    // ─── Sort ────────────────────────────────────────────────────────────────
    stocks.sort((a, b) => {
      let aVal: number | string;
      let bVal: number | string;

      switch (sort) {
        case "price":
          aVal = a.lastPrice;
          bVal = b.lastPrice;
          break;
        case "change":
          aVal = a.change;
          bVal = b.change;
          break;
        case "changePercent":
          aVal = a.changePercent;
          bVal = b.changePercent;
          break;
        case "volume":
          aVal = a.volume;
          bVal = b.volume;
          break;
        case "symbol":
        default:
          aVal = a.symbol;
          bVal = b.symbol;
      }

      if (typeof aVal === "string" && typeof bVal === "string") {
        return order === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return order === "asc" ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });

    // ─── Paginate ─────────────────────────────────────────────────────────────
    const total = stocks.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const paginated = stocks.slice(start, start + pageSize);

    return NextResponse.json(
      {
        ok: true,
        data: paginated,
        meta: {
          total,
          totalPages,
          page,
          pageSize,
          instrumentsLoaded: instrumentMap.size,
          symbolsMatched: validSymbols.length,
          symbolsWithQuotes: stocks.filter((s) => s.hasQuote).length,
          nifty500LastUpdated: NIFTY500_LAST_UPDATED,
          fetchedAt: new Date().toISOString(),
        },
      },
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
    console.error("[api/stocks] Error:", message);
    return NextResponse.json(
      { error: "Failed to retrieve stock data.", code: "FETCH_ERROR" },
      { status: 500 }
    );
  }
}
