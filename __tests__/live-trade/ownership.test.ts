/**
 * Live Trade owner resolution tests.
 *
 * The session module is mocked; this verifies the resolver's contract, not the
 * session store (covered by __tests__/kite-session.test.ts).
 */

import type { KiteSession } from "@/lib/types";

jest.mock("@/lib/kite-session", () => ({
  getSessionFromRequest: jest.fn(),
}));

import { getSessionFromRequest } from "@/lib/kite-session";
import {
  resolveLiveTradeOwner,
  resolveLiveTradeOwnerId,
} from "@/lib/live-trade/ownership";
import { LiveTradeError } from "@/lib/live-trade/errors";

const mockGetSession = getSessionFromRequest as jest.MockedFunction<
  typeof getSessionFromRequest
>;

function makeSession(overrides: Partial<KiteSession> = {}): KiteSession {
  return {
    accessToken: "mock_access_token",
    userId: "ZP0001",
    userName: "Test User",
    email: "test@example.com",
    loginTime: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mockGetSession.mockReset();
});

describe("resolveLiveTradeOwner", () => {
  it("returns the session user id as the owner", async () => {
    const session = makeSession();
    mockGetSession.mockResolvedValue(session);

    const context = await resolveLiveTradeOwner("ds_sid=abc");

    expect(mockGetSession).toHaveBeenCalledWith("ds_sid=abc");
    expect(context.ownerId).toBe("ZP0001");
    expect(context.session).toBe(session);
  });

  it("throws UNAUTHENTICATED when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(resolveLiveTradeOwner(null)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("throws UNAUTHENTICATED when the session has a blank user id", async () => {
    mockGetSession.mockResolvedValue(makeSession({ userId: "   " }));

    await expect(resolveLiveTradeOwner("ds_sid=abc")).rejects.toBeInstanceOf(
      LiveTradeError
    );
  });

  it("throws UNAUTHENTICATED when the user id is missing", async () => {
    mockGetSession.mockResolvedValue(
      makeSession({ userId: undefined as unknown as string })
    );

    await expect(resolveLiveTradeOwner("ds_sid=abc")).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("propagates session-store failures instead of misreporting a 401", async () => {
    const dbError = new Error("database unavailable");
    mockGetSession.mockRejectedValue(dbError);

    await expect(resolveLiveTradeOwner("ds_sid=abc")).rejects.toBe(dbError);
  });

  it("does not leak the owner id in the public error body", async () => {
    mockGetSession.mockResolvedValue(null);
    try {
      await resolveLiveTradeOwner(null);
      throw new Error("expected rejection");
    } catch (error) {
      const body = (error as LiveTradeError).toBody();
      expect(body).toEqual({
        error: "Authentication required.",
        code: "UNAUTHENTICATED",
      });
    }
  });
});

describe("resolveLiveTradeOwnerId", () => {
  it("returns only the owner id", async () => {
    mockGetSession.mockResolvedValue(makeSession({ userId: "AB1234" }));
    await expect(resolveLiveTradeOwnerId("ds_sid=abc")).resolves.toBe("AB1234");
  });
});
