import type { NextRequest } from 'next/server';
import type { KiteSession } from '@/lib/types';

jest.mock('@/lib/env', () => ({
  getCronSecret: jest.fn(),
}));

jest.mock('@/lib/kite-session', () => ({
  getSessionFromRequest: jest.fn(),
  getSessionIdFromCookies: jest.fn(),
}));

jest.mock('@/lib/crypto', () => ({
  hashSessionId: (id: string) => `hash:${id}`,
}));

import { getCronSecret } from '@/lib/env';
import { getSessionFromRequest, getSessionIdFromCookies } from '@/lib/kite-session';
import { authorizeScanWorker } from '@/lib/scanner/scanAuth';

const session: KiteSession = {
  accessToken: 'token',
  userId: 'user',
  userName: 'User',
  email: 'u@example.com',
  loginTime: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

function mockReq(headers: Record<string, string>): NextRequest {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: {
      get: (name: string) => map.get(name.toLowerCase()) ?? null,
    },
  } as unknown as NextRequest;
}

describe('authorizeScanWorker', () => {
  beforeEach(() => {
    jest.mocked(getCronSecret).mockReturnValue(null);
    jest.mocked(getSessionFromRequest).mockResolvedValue(null);
    jest.mocked(getSessionIdFromCookies).mockReturnValue(null);
  });

  test('accepts a Vercel Cron bearer token without a session cookie', async () => {
    jest.mocked(getCronSecret).mockReturnValue('cron-secret-value');
    const auth = await authorizeScanWorker(
      mockReq({ authorization: 'Bearer cron-secret-value' })
    );
    expect(auth).toEqual({
      ok: true,
      mode: 'cron',
      session: null,
      sessionIdHash: null,
    });
  });

  test('rejects unauthenticated public requests', async () => {
    const auth = await authorizeScanWorker(mockReq({}));
    expect(auth.ok).toBe(false);
    if (!auth.ok) {
      expect(auth.status).toBe(401);
      expect(auth.error).toBe('UNAUTHENTICATED');
    }
  });

  test('rejects a wrong bearer token without a session', async () => {
    jest.mocked(getCronSecret).mockReturnValue('cron-secret-value');
    const auth = await authorizeScanWorker(
      mockReq({ authorization: 'Bearer not-the-secret' })
    );
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.status).toBe(401);
  });

  test('accepts an authenticated UI session cookie', async () => {
    jest.mocked(getSessionFromRequest).mockResolvedValue(session);
    jest.mocked(getSessionIdFromCookies).mockReturnValue('sid-1');
    const auth = await authorizeScanWorker(mockReq({ cookie: 'ds_sid=sid-1' }));
    expect(auth).toEqual({
      ok: true,
      mode: 'session',
      session,
      sessionIdHash: 'hash:sid-1',
    });
  });
});
