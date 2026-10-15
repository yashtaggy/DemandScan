/**
 * Shared session computation helpers.
 * Extracted here so they can be imported by both kite-session.ts and tests
 * without pulling in the database or crypto modules.
 */

/**
 * Compute the expiry time for a Kite access token.
 * Kite tokens expire at 06:00 IST the following day (regulatory requirement).
 */
export function computeKiteTokenExpiry(): Date {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const nowIST = new Date(now.getTime() + IST_OFFSET_MS);

  // Build the next-day 06:00 IST expiry.
  const expiry = new Date(nowIST);
  expiry.setUTCDate(expiry.getUTCDate() + 1);
  expiry.setUTCHours(6, 0, 0, 0); // 06:00 "IST"

  // Shift back to true UTC
  return new Date(expiry.getTime() - IST_OFFSET_MS);
}
