import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import { getCronSecret } from '@/lib/env';
import {
  getSessionFromRequest,
  getSessionIdFromCookies,
} from '@/lib/kite-session';
import { hashSessionId } from '@/lib/crypto';
import type { KiteSession } from '@/lib/types';

export type ScanAuth =
  | { ok: true; mode: 'cron'; session: null; sessionIdHash: null }
  | { ok: true; mode: 'session'; session: KiteSession; sessionIdHash: string }
  | { ok: false; status: number; error: string };

function bearerMatchesCronSecret(header: string | null, secret: string): boolean {
  if (!header) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const token = header.slice(prefix.length).trim();
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function authorizeScanWorker(req: NextRequest): Promise<ScanAuth> {
  const secret = getCronSecret();
  if (secret && bearerMatchesCronSecret(req.headers.get('authorization'), secret)) {
    return { ok: true, mode: 'cron', session: null, sessionIdHash: null };
  }

  const cookie = req.headers.get('cookie');
  const session = await getSessionFromRequest(cookie);
  const sessionId = getSessionIdFromCookies(cookie);
  if (!session || !sessionId) {
    return { ok: false, status: 401, error: 'UNAUTHENTICATED' };
  }

  return {
    ok: true,
    mode: 'session',
    session,
    sessionIdHash: hashSessionId(sessionId),
  };
}
