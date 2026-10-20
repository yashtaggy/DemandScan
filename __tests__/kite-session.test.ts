/**
 * Tests for the new DB-backed session store and helper functions.
 *
 * All database and crypto operations are mocked — no real Neon or Kite
 * credentials are required.
 */

import type { KiteSession } from "@/lib/types";
import { computeKiteTokenExpiry } from "@/lib/session-helpers";

// ─── Mock the database ──────────────────────────────────────────────────────

// In-memory store that simulates the Neon SQL behaviour
const fakeDb = new Map<
  string,
  {
    encrypted_access_token: string;
    user_id: string;
    user_name: string;
    email: string;
    login_time: Date;
    expires_at: Date;
  }
>();

jest.mock("@/lib/db", () => ({
  getDb: () => {
    // Returns an async tagged-template function like neon()
    const sql = async (
      strings: TemplateStringsArray | string,
      ...values: unknown[]
    ) => {
      // Build a simple query string to dispatch
      const query = Array.isArray(strings)
        ? (strings as TemplateStringsArray).join("?")
        : (strings as string);

      if (query.includes("SELECT")) {
        // get() query — find by session_id_hash (values[0])
        const row = fakeDb.get(values[0] as string);
        if (!row || row.expires_at <= new Date()) return [];
        return [row];
      }

      if (query.includes("INSERT")) {
        // set() — upsert the row
        fakeDb.set(values[0] as string, {
          encrypted_access_token: values[1] as string,
          user_id: values[2] as string,
          user_name: values[3] as string,
          email: values[4] as string,
          login_time: values[5] as Date,
          expires_at: values[6] as Date,
        });
        return [];
      }

      if (query.includes("DELETE")) {
        // clear() — delete by session_id_hash (values[0])
        fakeDb.delete(values[0] as string);
        return [];
      }

      return [];
    };
    return sql;
  },
}));

// ─── Mock crypto (encrypt/decrypt/hashSessionId) ────────────────────────────

jest.mock("@/lib/crypto", () => ({
  encrypt: (text: string) => `enc:${text}`,
  decrypt: (blob: string) => blob.replace(/^enc:/, ""),
  hashSessionId: (id: string) => `hash:${id}`,
}));

// ─── Now import the module under test ───────────────────────────────────────

import {
  DbSessionStore,
  getSessionIdFromCookies,
  getSessionFromRequest,
  getSessionByIdHash,
  isAuthenticated,
  requireSession,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/kite-session";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockSession(overrides: Partial<KiteSession> = {}): KiteSession {
  const futureExpiry = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
  return {
    accessToken: "mock_access_token_12345",
    userId: "ZP0001",
    userName: "Test User",
    email: "test@example.com",
    loginTime: new Date().toISOString(),
    expiresAt: futureExpiry,
    ...overrides,
  };
}

function makeCookieHeader(sessionId: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}; other_cookie=value`;
}

let store: DbSessionStore;

beforeEach(() => {
  fakeDb.clear();
  store = new DbSessionStore();
});

// ─── DbSessionStore ───────────────────────────────────────────────────────────

describe("DbSessionStore", () => {
  it("returns null when no session is set", async () => {
    expect(await store.get("nonexistent-id")).toBeNull();
  });

  it("stores and retrieves a valid session", async () => {
    const mock = makeMockSession();
    await store.set("session-123", mock);
    const result = await store.get("session-123");
    expect(result).not.toBeNull();
    expect(result?.userId).toBe("ZP0001");
    expect(result?.accessToken).toBe("mock_access_token_12345");
  });

  it("returns null for an expired session", async () => {
    const expired = makeMockSession({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await store.set("session-expired", expired);
    // Simulate expiry in the fake DB
    const row = fakeDb.get("hash:session-expired");
    if (row) row.expires_at = new Date(Date.now() - 1000);

    const result = await store.get("session-expired");
    expect(result).toBeNull();
  });

  it("clears the session on logout", async () => {
    await store.set("session-abc", makeMockSession());
    await store.clear("session-abc");
    expect(await store.get("session-abc")).toBeNull();
  });

  it("does not return session when sessionId is empty", async () => {
    expect(await store.get("")).toBeNull();
  });

  it("does not expose accessToken incorrectly (decryption check)", async () => {
    const mock = makeMockSession({ accessToken: "secret_token" });
    await store.set("session-tok", mock);
    const result = await store.get("session-tok");
    // The mock decrypt just strips "enc:" prefix, so token is recoverable server-side
    expect(result?.accessToken).toBe("secret_token");
  });
});

// ─── getSessionIdFromCookies ──────────────────────────────────────────────────

describe("getSessionIdFromCookies", () => {
  it("returns null when cookieHeader is null", () => {
    expect(getSessionIdFromCookies(null)).toBeNull();
  });

  it("returns null when cookieHeader is empty", () => {
    expect(getSessionIdFromCookies("")).toBeNull();
  });

  it("returns null when the session cookie is absent", () => {
    expect(getSessionIdFromCookies("other_cookie=value; another=x")).toBeNull();
  });

  it("extracts the correct session ID from a multi-cookie header", () => {
    const header = `other=foo; ${SESSION_COOKIE_NAME}=my-session-id; another=bar`;
    expect(getSessionIdFromCookies(header)).toBe("my-session-id");
  });

  it("returns null when the session cookie value is empty", () => {
    expect(getSessionIdFromCookies(`${SESSION_COOKIE_NAME}=`)).toBeNull();
  });
});

// ─── getSessionFromRequest ────────────────────────────────────────────────────

describe("getSessionFromRequest", () => {
  it("returns null when no cookie header", async () => {
    expect(await getSessionFromRequest(null)).toBeNull();
  });

  it("returns null when session cookie is missing", async () => {
    expect(await getSessionFromRequest("other=x")).toBeNull();
  });

  it("returns session when valid cookie is present", async () => {
    const mock = makeMockSession();
    await store.set("valid-id", mock);
    // Re-create store to use the same fakeDb
    const session = await getSessionFromRequest(makeCookieHeader("valid-id"));
    expect(session).not.toBeNull();
    expect(session?.userId).toBe("ZP0001");
  });

  it("returns null for invalid session ID", async () => {
    const session = await getSessionFromRequest(makeCookieHeader("bad-id"));
    expect(session).toBeNull();
  });
});

// ─── isAuthenticated ─────────────────────────────────────────────────────────

describe("isAuthenticated", () => {
  it("returns false when no cookie", async () => {
    expect(await isAuthenticated(null)).toBe(false);
  });

  it("returns false when session not found", async () => {
    expect(await isAuthenticated(makeCookieHeader("unknown"))).toBe(false);
  });

  it("returns true when valid session exists", async () => {
    await store.set("auth-id", makeMockSession());
    expect(await isAuthenticated(makeCookieHeader("auth-id"))).toBe(true);
  });
});

// ─── requireSession ───────────────────────────────────────────────────────────

describe("requireSession", () => {
  it("throws UNAUTHENTICATED when no cookie", async () => {
    await expect(requireSession(null)).rejects.toThrow("UNAUTHENTICATED");
  });

  it("throws UNAUTHENTICATED when session not found", async () => {
    await expect(requireSession(makeCookieHeader("unknown"))).rejects.toThrow(
      "UNAUTHENTICATED"
    );
  });

  it("returns session when authenticated", async () => {
    await store.set("req-id", makeMockSession());
    const session = await requireSession(makeCookieHeader("req-id"));
    expect(session.userId).toBe("ZP0001");
  });
});

describe("getSessionByIdHash", () => {
  it("loads a live session by stored cookie hash without changing token handling", async () => {
    const mock = makeMockSession();
    await store.set("session-123", mock);
    const result = await getSessionByIdHash("hash:session-123");
    expect(result?.accessToken).toBe(mock.accessToken);
    expect(result?.userId).toBe(mock.userId);
  });

  it("returns null for an unknown hash", async () => {
    expect(await getSessionByIdHash("hash:missing")).toBeNull();
  });
});

// ─── Cookie security attributes ───────────────────────────────────────────────

describe("SESSION_COOKIE_OPTIONS", () => {
  it("has httpOnly=true", () => {
    expect(SESSION_COOKIE_OPTIONS.httpOnly).toBe(true);
  });

  it("has sameSite=lax", () => {
    expect(SESSION_COOKIE_OPTIONS.sameSite).toBe("lax");
  });

  it("has path=/", () => {
    expect(SESSION_COOKIE_OPTIONS.path).toBe("/");
  });

  it("has positive maxAge", () => {
    expect(SESSION_COOKIE_OPTIONS.maxAge).toBeGreaterThan(0);
  });
});

// ─── computeKiteTokenExpiry ───────────────────────────────────────────────────

describe("computeKiteTokenExpiry", () => {
  it("returns a future date", () => {
    const expiry = computeKiteTokenExpiry();
    expect(expiry.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns the next 06:00 IST (regulatory requirement)", () => {
    const expiry = computeKiteTokenExpiry();
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const expiryIST = new Date(expiry.getTime() + IST_OFFSET_MS);
    expect(expiryIST.getUTCHours()).toBe(6);
    expect(expiryIST.getUTCMinutes()).toBe(0);
  });
});
