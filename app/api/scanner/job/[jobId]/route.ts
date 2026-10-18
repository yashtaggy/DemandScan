import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireSession } from '@/lib/kite-session';
import { getScanJob } from '@/lib/scanner/jobs';

/**
 * GET /api/scanner/job/[jobId]
 * Returns the scan job record (status, progress, errors, timestamps).
 */
export async function GET(req: NextRequest) {
  // Ensure request is authenticated.
  let session;
  try {
    session = await requireSession(req.headers.get('cookie'));
  } catch (e) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  // Extract jobId from the URL pathname.
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // Expected parts: ['api','scanner','job','<jobId>']
  const jobId = parts[3];
  if (!jobId) {
    return NextResponse.json({ error: 'Job ID missing', code: 'MISSING_JOB_ID' }, { status: 400 });
  }

  const job = await getScanJob(jobId);
  if (!job) {
    return NextResponse.json({ error: 'Job not found', code: 'JOB_NOT_FOUND' }, { status: 404 });
  }

  return NextResponse.json({ job });
}
