/**
 * Shared HTTP concerns for the Live Trade API.
 *
 * Every route resolves the owner from the server-side Kite session and maps
 * failures through one handler, so authentication, origin checks and error
 * shapes cannot drift between endpoints.
 *
 * Mutation protection is an Origin allow-list, not CORS: the browser sends
 * `Origin` on every non-GET request and scripts on another site cannot forge
 * it. The allow-list contains the configured application origin plus, outside
 * production only, the loopback origin the request was addressed to.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getAppOrigin } from "../env";
import { LiveTradeError } from "./errors";
import { resolveLiveTradeOwner } from "./ownership";
import type { LiveTradeOwnerContext } from "./types";
import { isUuid } from "./validation";

/** Reorders carry at most 200 UUIDs; 64 KiB leaves ample headroom. */
export const LIVE_TRADE_MAX_BODY_BYTES = 64 * 1024;

const NO_STORE = { "Cache-Control": "no-store" };

export function liveTradeJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(
    { success: true, data },
    { status, headers: NO_STORE }
  );
}

/**
 * Public errors keep their status and body. Anything else becomes INTERNAL and
 * is logged without its message, which may contain SQL text or driver detail.
 */
function liveTradeErrorResponse(error: unknown): NextResponse {
  if (error instanceof LiveTradeError) {
    const headers: Record<string, string> = { ...NO_STORE };
    if (error.code === "QUOTE_COOLDOWN") {
      const retryAfter = error.details?.retryAfterSeconds;
      if (
        typeof retryAfter === "number" &&
        Number.isFinite(retryAfter) &&
        retryAfter > 0
      ) {
        headers["Retry-After"] = String(Math.ceil(retryAfter));
      }
    }
    return NextResponse.json(error.toBody(), {
      status: error.status,
      headers,
    });
  }

  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name ?? "Error")
      : typeof error;
  console.error("[live-trade] unhandled request error", { name });

  const internal = new LiveTradeError("INTERNAL");
  return NextResponse.json(internal.toBody(), {
    status: internal.status,
    headers: NO_STORE,
  });
}

function parseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin === "null") return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * The configured origin is authoritative. In development and tests the actual
 * loopback origin of the request is accepted as well; production never gets
 * that exception. There is deliberately no wildcard fallback.
 */
function allowedMutationOrigins(req: NextRequest): Set<string> {
  const allowed = new Set<string>();

  try {
    const configured = parseOrigin(getAppOrigin());
    if (configured) allowed.add(configured);
  } catch {
    // Missing configuration is handled by the caller after parsing Origin.
  }

  if (process.env.NODE_ENV !== "production") {
    try {
      const requestUrl = new URL(req.url);
      if (isLoopbackHost(requestUrl.hostname)) {
        allowed.add(`${requestUrl.protocol}//${requestUrl.host}`);
      }
    } catch {
      // A request URL that cannot be parsed contributes no allowed origin.
    }
  }

  return allowed;
}

/**
 * Dynamic route identifiers are checked before body or query parsing. A
 * malformed UUID is a client mistake (400 INVALID_QUERY); it must never reach a
 * lookup, because a lookup cannot distinguish a malformed id from a missing or
 * foreign-owned record.
 */
export function requirePathUuid(value: unknown): string {
  if (!isUuid(value)) {
    throw new LiveTradeError(
      "INVALID_QUERY",
      "Resource id must be a valid UUID."
    );
  }
  return value;
}

export function assertMutationOrigin(req: NextRequest): void {
  const originHeader = req.headers.get("origin");
  if (!originHeader) {
    throw new LiveTradeError("FORBIDDEN", "Origin header is required.");
  }

  const origin = parseOrigin(originHeader);
  if (origin === null) {
    throw new LiveTradeError("FORBIDDEN", "Origin header is invalid.");
  }

  const allowed = allowedMutationOrigins(req);
  if (allowed.size === 0) {
    throw new LiveTradeError(
      "INTERNAL",
      "Mutation origin is not configured."
    );
  }

  if (!allowed.has(origin)) {
    throw new LiveTradeError("FORBIDDEN", "Origin is not allowed.");
  }
}

export async function readLiveTradeJsonBody(
  req: NextRequest
): Promise<unknown> {
  const contentType = (req.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new LiveTradeError(
      "INVALID_BODY",
      "Content-Type must be application/json."
    );
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0) {
      throw new LiveTradeError("INVALID_BODY", "Invalid Content-Length.");
    }
    if (declared > LIVE_TRADE_MAX_BODY_BYTES) {
      throw new LiveTradeError("PAYLOAD_TOO_LARGE");
    }
  }

  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > LIVE_TRADE_MAX_BODY_BYTES) {
    throw new LiveTradeError("PAYLOAD_TOO_LARGE");
  }
  if (text.trim() === "") {
    throw new LiveTradeError("INVALID_BODY", "Request body is empty.");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LiveTradeError(
      "INVALID_BODY",
      "Request body must be valid JSON."
    );
  }
}

export async function handleLiveTrade(
  req: NextRequest,
  options: { mutation?: boolean },
  handler: (owner: LiveTradeOwnerContext) => Promise<NextResponse> | NextResponse
): Promise<NextResponse> {
  try {
    // Origin is checked before authentication so a rejected cross-site request
    // performs no session lookup and no database work.
    if (options.mutation) assertMutationOrigin(req);

    const owner = await resolveLiveTradeOwner(req.headers.get("cookie"));
    return await handler(owner);
  } catch (error) {
    return liveTradeErrorResponse(error);
  }
}
