/**
 * Live Trade owner resolution.
 *
 * The owner is ALWAYS the authenticated Kite `user_id` from the server-side
 * session. No route, body field or query parameter may supply it.
 *
 * `resolveLiveTradeOwner` is the only producer of `LiveTradeOwnerId`, so a
 * repository call cannot be made with an unverified string.
 */

import { getSessionFromRequest } from "../kite-session";
import { LiveTradeError } from "./errors";
import type { LiveTradeOwnerContext, LiveTradeOwnerId } from "./types";
import { isValidOwnerId } from "./validation";

/**
 * Resolves the owner for a request.
 *
 * Throws `LiveTradeError('UNAUTHENTICATED')` when the session is missing,
 * expired, or has no usable Kite user id. Database failures from the session
 * store propagate unchanged so the route can report a server error rather than
 * a misleading 401.
 */
export async function resolveLiveTradeOwner(
  cookieHeader: string | null | undefined
): Promise<LiveTradeOwnerContext> {
  const session = await getSessionFromRequest(cookieHeader);

  if (!session) throw new LiveTradeError("UNAUTHENTICATED");
  if (!isValidOwnerId(session.userId)) throw new LiveTradeError("UNAUTHENTICATED");

  return { ownerId: session.userId as LiveTradeOwnerId, session };
}

/** Convenience wrapper when only the owner id is needed. */
export async function resolveLiveTradeOwnerId(
  cookieHeader: string | null | undefined
): Promise<LiveTradeOwnerId> {
  return (await resolveLiveTradeOwner(cookieHeader)).ownerId;
}
