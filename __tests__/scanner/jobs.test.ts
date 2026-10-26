const statements: Array<{ text: string; values: unknown[] }> = [];
let mockRows: any[] = [];

jest.mock('@/lib/db', () => ({
  getDb: () => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ text: strings.join('?'), values });
    return mockRows;
  },
}));

import {
  findActiveScanJob,
  getScanBatchStats,
  retireStaleScanJobs,
  STALE_JOB_AFTER_MS,
} from '@/lib/scanner/jobs';

beforeEach(() => {
  statements.length = 0;
  mockRows = [];
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('findActiveScanJob', () => {
  test('returns the newest runnable job scoped to the session', async () => {
    await findActiveScanJob('hash:sid');
    expect(statements).toHaveLength(1);
    expect(statements[0].text).toContain("status IN ('PENDING', 'RUNNING')");
    expect(statements[0].text).toContain('session_id_hash = ?');
    expect(statements[0].text).toContain('ORDER BY started_at DESC');
    expect(statements[0].values).toEqual(['hash:sid']);
  });

  test('does not add a session filter when no hash is given (legacy jobs)', async () => {
    await findActiveScanJob();
    expect(statements[0].text).not.toContain('session_id_hash = ?');
    expect(statements[0].text).toContain('ORDER BY started_at DESC');
  });
});

describe('retireStaleScanJobs', () => {
  test('retires old, unleased jobs and returns the count', async () => {
    mockRows = [{ job_id: 'a' }, { job_id: 'b' }];

    const count = await retireStaleScanJobs('hash:sid');

    expect(count).toBe(2);
    const { text, values } = statements[0];
    expect(text).toContain('SET status');
    expect(text).toContain("'FAILED'");
    expect(text).toContain("status IN ('PENDING', 'RUNNING')");
    expect(text).toContain('session_id_hash = ?');
    expect(text).toContain('started_at < ?');
    expect(text).toContain('lease_expires_at < NOW()');
    // Template order: message (SET), session hash, cutoff (WHERE).
    expect(values[0]).toContain('Abandoned');
    expect(values[1]).toBe('hash:sid');
    const cutoff = values[2] as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(STALE_JOB_AFTER_MS - 1000);
  });

  test('can retire stale jobs across sessions', async () => {
    mockRows = [];
    const count = await retireStaleScanJobs();
    expect(count).toBe(0);
    expect(statements[0].text).not.toContain('session_id_hash = ?');
    expect(statements[0].text).toContain('lease_expires_at < NOW()');
  });
});

describe('getScanBatchStats', () => {
  test('returns overall and per-stage counters from one grouped query', async () => {
    mockRows = [
      { stage: null, total: 9, completed: 7, failed: 2, avg_duration_ms: 1200, max_duration_ms: 3100 },
      { stage: 'INGEST_DAILY', total: 5, completed: 4, failed: 1, avg_duration_ms: 900, max_duration_ms: 1800 },
      { stage: 'DETECT_ZONES', total: 4, completed: 3, failed: 1, avg_duration_ms: 1600, max_duration_ms: 3100 },
    ];

    const stats = await getScanBatchStats('job-1');

    expect(statements).toHaveLength(1);
    expect(statements[0].text).toContain('GROUP BY GROUPING SETS ((), (stage))');
    expect(statements[0].text).toContain('max_duration_ms');
    expect(statements[0].values).toEqual(['job-1']);
    expect(stats).toEqual({
      total: 9,
      completed: 7,
      failed: 2,
      avgDurationMs: 1200,
      maxDurationMs: 3100,
      byStage: [
        {
          stage: 'INGEST_DAILY',
          total: 5,
          completed: 4,
          failed: 1,
          avgDurationMs: 900,
          maxDurationMs: 1800,
        },
        {
          stage: 'DETECT_ZONES',
          total: 4,
          completed: 3,
          failed: 1,
          avgDurationMs: 1600,
          maxDurationMs: 3100,
        },
      ],
    });
  });

  test('returns zeroed stats when a job has no batches yet', async () => {
    const stats = await getScanBatchStats('job-empty');
    expect(stats).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      avgDurationMs: 0,
      maxDurationMs: 0,
      byStage: [],
    });
  });
});
