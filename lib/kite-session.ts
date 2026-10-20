/**
 * Server-side session storage for Kite Connect access tokens.
 *
 * Production implementation backed by Neon Postgres with:
 *  - AES-256-GCM encryption of the access token at rest.
 *  - Opaque, cryptographically random session IDs in HttpOnly cookies.
 *  - Only the SHA-256 hash of the session ID is stored in the database.
 *  - Automatic expiry of stale rows.
 *
 * INTERFACE CONTRACT (unchanged from original InMemorySessionStore):
 *  - get(sessionId)  → KiteSession | null
 *  - set(sessionId, session) → void
 *  - clear(sessionId) → void
 *
 * The sessionId parameter is the opaque random cookie value (plaintext).
 * This module hashes it before every database read/write.
 *
 * THIS FILE IS SERVER-ONLY. Never import it in client components.
 */

import type { KiteSession } from "./types";
import { getDb } from "./db";
import { encrypt, decrypt, hashSessionId } from "./crypto";

// ─── Re-export helpers needed by callers ─────────────────────────────────────

export { computeKiteTokenExpiry } from "./session-helpers";

// ─── Session store interface ──────────────────────────────────────────────────

export interface KiteSessionStore {
  /** Resolve session by the plaintext session cookie value. */
  get(sessionId: string): Promise<KiteSession | null>;
  /** Persist a new session, keyed by the plaintext session cookie value. */
  set(sessionId: string, session: KiteSession): Promise<void>;
  /** Invalidate the session for the given cookie value. */
  clear(sessionId: string): Promise<void>;
}

// ─── Postgres-backed implementation ───────────────────────────────────────────

export class DbSessionStore implements KiteSessionStore {
  async get(sessionId: string): Promise<KiteSession | null> {
    if (!sessionId) return null;

    const sql = getDb();
    const hashedId = hashSessionId(sessionId);

    const rows = await sql`
      SELECT
        encrypted_access_token,
        user_id,
        user_name,
        email,
        login_time,
        expires_at
      FROM kite_sessions
      WHERE session_id_hash = ${hashedId}
        AND expires_at > NOW()
      LIMIT 1
    `;

    if (rows.length === 0) return null;

    const row = rows[0];

    let accessToken: string;
    try {
      accessToken = decrypt(row.encrypted_access_token as string);
    } catch {
      // Decryption failure — treat as no session (key rotation or corruption)
      console.error("[db-session] Decryption failed for session hash; treating as unauthenticated.");
      return null;
    }

    return {
      accessToken,
      userId: row.user_id as string,
      userName: row.user_name as string,
      email: row.email as string,
      loginTime: (row.login_time as Date).toISOString(),
      expiresAt: (row.expires_at as Date).toISOString(),
    };
  }

  async set(sessionId: string, session: KiteSession): Promise<void> {
    if (!sessionId) throw new Error("sessionId is required");

    const sql = getDb();
    const hashedId = hashSessionId(sessionId);
    const encryptedToken = encrypt(session.accessToken);

    await sql`
      INSERT INTO kite_sessions (
        session_id_hash,
        encrypted_access_token,
        user_id,
        user_name,
        email,
        login_time,
        expires_at,
        created_at
      ) VALUES (
        ${hashedId},
        ${encryptedToken},
        ${session.userId},
        ${session.userName},
        ${session.email},
        ${new Date(session.loginTime)},
        ${new Date(session.expiresAt)},
        NOW()
      )
      ON CONFLICT (session_id_hash) DO UPDATE SET
        encrypted_access_token = EXCLUDED.encrypted_access_token,
        user_id                = EXCLUDED.user_id,
        user_name              = EXCLUDED.user_name,
        email                  = EXCLUDED.email,
        login_time             = EXCLUDED.login_time,
        expires_at             = EXCLUDED.expires_at,
        created_at             = NOW()
    `;
  }

  async clear(sessionId: string): Promise<void> {
    if (!sessionId) return;

    const sql = getDb();
    const hashedId = hashSessionId(sessionId);

    await sql`
      DELETE FROM kite_sessions
      WHERE session_id_hash = ${hashedId}
    `;
  }
}

// ─── Exported singleton ────────────────────────────────────────────────────────

export const sessionStore = new DbSessionStore();

// ─── Cookie helpers ────────────────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = "ds_sid";

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  // Kite tokens expire next day 06:00 IST (~max 30 hours); set cookie to 24 h
  maxAge: 24 * 60 * 60,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the session ID from the request cookies.
 * Returns null if the cookie is absent or empty.
 */
export function getSessionIdFromCookies(
  cookieHeader: string | null | undefined
): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name.trim() === SESSION_COOKIE_NAME) {
      const value = rest.join("=").trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Resolve the current KiteSession from a request cookie header.
 * Returns null if cookie is absent, session not found, or session expired.
 */
export async function getSessionFromRequest(
  cookieHeader: string | null | undefined
): Promise<KiteSession | null> {
  const sessionId = getSessionIdFromCookies(cookieHeader);
  if (!sessionId) return null;
  return sessionStore.get(sessionId);
}

/**
 * Returns true if the request has a valid session.
 */
export async function isAuthenticated(
  cookieHeader: string | null | undefined
): Promise<boolean> {
  return (await getSessionFromRequest(cookieHeader)) !== null;
}

/**
 * Returns the current session or throws UNAUTHENTICATED.
 */
export async function requireSession(
  cookieHeader: string | null | undefined
): Promise<KiteSession> {
  const session = await getSessionFromRequest(cookieHeader);
  if (!session) throw new Error("UNAUTHENTICATED");
  return session;
}

/**
 * Resolve a Kite session from the stored SHA-256 cookie hash.
 * Used by the scan worker to reload the encrypted Kite token when only the
 * job's stored session_id_hash is available.
 * Does not change encryption, cookies, or token handling.
 */
export async function getSessionByIdHash(
  sessionIdHash: string
): Promise<KiteSession | null> {
  if (!sessionIdHash) return null;

  const sql = getDb();
  const rows = await sql`
    SELECT
      encrypted_access_token,
      user_id,
      user_name,
      email,
      login_time,
      expires_at
    FROM kite_sessions
    WHERE session_id_hash = ${sessionIdHash}
      AND expires_at > NOW()
    LIMIT 1
  `;

  if (rows.length === 0) return null;

  const row = rows[0];
  let accessToken: string;
  try {
    accessToken = decrypt(row.encrypted_access_token as string);
  } catch {
    console.error("[db-session] Decryption failed for hashed session; treating as unauthenticated.");
    return null;
  }

  return {
    accessToken,
    userId: row.user_id as string,
    userName: row.user_name as string,
    email: row.email as string,
    loginTime: (row.login_time as Date).toISOString(),
    expiresAt: (row.expires_at as Date).toISOString(),
  };
}
