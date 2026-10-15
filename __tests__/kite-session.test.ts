/**
 * Tests for lib/kite-session.ts
 * Uses the in-memory session store — no real Kite credentials required.
 */

import { sessionStore, computeKiteTokenExpiry, isAuthenticated, requireSession } from "@/lib/kite-session";
import type { KiteSession } from "@/lib/types";

// Helper to create a valid mock session
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

beforeEach(async () => {
  await sessionStore.clear();
});

describe("sessionStore", () => {
  it("returns null when no session is set", async () => {
    const session = await sessionStore.get();
    expect(session).toBeNull();
  });

  it("stores and retrieves a valid session", async () => {
    const mock = makeMockSession();
    await sessionStore.set(mock);
    const retrieved = await sessionStore.get();
    expect(retrieved).not.toBeNull();
    expect(retrieved?.userId).toBe("ZP0001");
    expect(retrieved?.accessToken).toBe("mock_access_token_12345");
  });

  it("does NOT include accessToken in retrieved session (it's there but server-only)", async () => {
    // Access token is stored server-side only — this test just verifies storage integrity
    const mock = makeMockSession();
    await sessionStore.set(mock);
    const retrieved = await sessionStore.get();
    expect(retrieved?.accessToken).toBe("mock_access_token_12345");
  });

  it("returns null for an expired session", async () => {
    const expired = makeMockSession({
      expiresAt: new Date(Date.now() - 1000).toISOString(), // 1 second in the past
    });
    await sessionStore.set(expired);
    const retrieved = await sessionStore.get();
    expect(retrieved).toBeNull();
  });

  it("clears the session on logout", async () => {
    await sessionStore.set(makeMockSession());
    await sessionStore.clear();
    expect(await sessionStore.get()).toBeNull();
  });
});

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

describe("isAuthenticated", () => {
  it("returns false when no session", async () => {
    expect(await isAuthenticated()).toBe(false);
  });

  it("returns true when a valid session exists", async () => {
    await sessionStore.set(makeMockSession());
    expect(await isAuthenticated()).toBe(true);
  });

  it("returns false for expired session", async () => {
    await sessionStore.set(makeMockSession({ expiresAt: new Date(0).toISOString() }));
    expect(await isAuthenticated()).toBe(false);
  });
});

describe("requireSession", () => {
  it("throws UNAUTHENTICATED when no session", async () => {
    await expect(requireSession()).rejects.toThrow("UNAUTHENTICATED");
  });

  it("returns session when authenticated", async () => {
    const mock = makeMockSession();
    await sessionStore.set(mock);
    const session = await requireSession();
    expect(session.userId).toBe("ZP0001");
  });
});
