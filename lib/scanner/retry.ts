/**
 * lib/scanner/retry.ts
 *
 * Error classification, bounded backoff, and a per-process throttle for Kite
 * historical-data requests.
 *
 * Kite historical API: 3 requests/second (documented). The browser drives one
 * batch at a time, so a process-local throttle is sufficient to avoid bursts.
 */

const HISTORICAL_MIN_INTERVAL_MS = 350;

let nextHistoricalSlot = 0;

/** Resolve when the next historical-data request slot is available. */
export async function throttleHistoricalRequests(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextHistoricalSlot - now);
  nextHistoricalSlot = Math.max(now, nextHistoricalSlot) + HISTORICAL_MIN_INTERVAL_MS;
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** Bounded exponential backoff with jitter. */
export function backoffMs(attempt: number, cap = 15_000): number {
  const base = Math.min(cap, Math.pow(2, attempt) * 1000);
  return base + Math.floor(Math.random() * 500);
}

/**
 * True for errors worth retrying: Kite rate limits, transient network
 * failures, and 5xx responses.
 */
export function isTransientError(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: unknown; error_type?: unknown } | null;
  const message = String(e?.message ?? '');
  if (e?.statusCode === 429 || (typeof e?.statusCode === 'number' && e.statusCode >= 500)) {
    return true;
  }
  if (/rate limit|too many requests/i.test(message)) return true;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|socket hang up|fetch failed|network|timeout/i.test(message)) {
    return true;
  }
  return false;
}

/**
 * Make an error safe for logs, API responses, and persisted job rows: cap the
 * length and redact credential-shaped text (Kite tokens, API keys, Postgres
 * URLs). Never log raw driver objects — they can carry connection strings.
 */
export function sanitizeErrorMessage(raw: unknown): string {
  const text = String(
    (raw as { message?: unknown } | null | undefined)?.message ?? raw ?? 'Unknown batch error'
  );
  return text
    .replace(/(access_token|api_key|request_token|public_token|enctoken)=([^\s&]+)/gi, '$1=<redacted>')
    .replace(/postgres(ql)?:\/\/[^\s"']+@[^\s"']+/gi, 'postgres://<redacted>')
    .slice(0, 500);
}

/**
 * True for permanent failures that must NOT consume the retry budget:
 * schema drift (Postgres 42xxx), auth/permission errors, and Kite token or
 * invalid-credential errors.
 */
export function isPermanentError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; permanent?: unknown } | null;
  if (e?.permanent === true) return true;
  const code = typeof e?.code === 'string' ? e.code : '';
  if (/^42/.test(code)) return true; // undefined_table/column, syntax_error, etc.
  if (code === '42501' || code === '28P01' || code === '3D000') return true;

  const message = String(e?.message ?? '');
  return /does not exist|permission denied|Invalid `api_key`|Invalid `access_token`|TokenException|token is invalid|session expired|Kite session expired|No instruments available/i.test(
    message
  );
}
