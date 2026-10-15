/**
 * Server-side session storage for Kite Connect access tokens.
 *
 * ⚠️  WARNING — LOCAL PROTOTYPE ONLY
 * This implementation stores the session in a module-level Map (in-memory).
 * It is intentionally simple for a single-user local development prototype.
 *
 * LIMITATIONS:
 * - Sessions are lost when the Next.js process restarts.
 * - Not safe for multi-user or production deployments.
 * - Not encrypted at rest.
 *
 * TO REPLACE FOR PRODUCTION:
 * Implement the KiteSessionStore interface (see below) backed by:
 *   • An encrypted database column (e.g. Postgres + pgcrypto)
 *   • An encrypted Redis entry (e.g. redis + AES-256)
 *   • iron-session with a persistent database adapter
 * Then swap the export at the bottom of this file.
 *
 * DO NOT store the access token in:
 *   - Browser localStorage / sessionStorage
 *   - HTTP cookies visible to client JS
 *   - Next.js client-side React state
 *   - Environment variables (they are static and shared)
 */

import type { KiteSession } from "./types";

// ─── Session store interface (implement this to swap backends) ─────────────────

export interface KiteSessionStore {
  get(): Promise<KiteSession | null>;
  set(session: KiteSession): Promise<void>;
  clear(): Promise<void>;
}

// ─── In-memory implementation (single-user local prototype) ───────────────────

class InMemorySessionStore implements KiteSessionStore {
  private session: KiteSession | null = null;

  async get(): Promise<KiteSession | null> {
    if (!this.session) return null;

    // Check if the token has expired
    const expiresAt = new Date(this.session.expiresAt);
    if (expiresAt <= new Date()) {
      this.session = null;
      return null;
    }

    return this.session;
  }

  async set(session: KiteSession): Promise<void> {
    this.session = session;
  }

  async clear(): Promise<void> {
    this.session = null;
  }
}

// ─── Exported singleton ───────────────────────────────────────────────────────
// Replace `new InMemorySessionStore()` with a persistent implementation
// when moving beyond the local prototype.

export const sessionStore: KiteSessionStore = new InMemorySessionStore();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute the expiry time for a Kite access token.
 * Kite tokens expire at 06:00 IST the following day (regulatory requirement).
 */
export function computeKiteTokenExpiry(): Date {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const nowIST = new Date(now.getTime() + IST_OFFSET_MS);

  // Build the next-day 06:00 IST expiry using UTC methods on a Date
  // that already holds IST wall-clock time as its UTC value.
  // This avoids dependency on the process's local timezone.
  const expiry = new Date(nowIST);
  expiry.setUTCDate(expiry.getUTCDate() + 1);
  expiry.setUTCHours(6, 0, 0, 0); // 06:00 "IST" (stored as UTC in the IST-offset Date)

  // Shift back to true UTC for storage / comparison
  return new Date(expiry.getTime() - IST_OFFSET_MS);
}

/**
 * Returns true if a valid session exists.
 */
export async function isAuthenticated(): Promise<boolean> {
  const session = await sessionStore.get();
  return session !== null;
}

/**
 * Returns the current session or throws if not authenticated.
 */
export async function requireSession(): Promise<KiteSession> {
  const session = await sessionStore.get();
  if (!session) {
    throw new Error("UNAUTHENTICATED");
  }
  return session;
}
