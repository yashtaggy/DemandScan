import type { KiteSession } from '@/lib/types';
import type { ScanJobRow, ScanJobStatus, ScanStage } from '@/lib/scanner/jobs';
import {
  nextStage,
  processScanBatch,
  progressForStage,
  selectNextInstrumentBatch,
  type ScanJobStore,
  type ScanWorkers,
} from '@/lib/scanner/batchRunner';

function makeJob(overrides: Partial<ScanJobRow> = {}): ScanJobRow {
  return {
    job_id: 'job-1',
    started_at: new Date(),
    completed_at: null,
    status: 'PENDING',
    progress_percent: 0,
    error_message: null,
    config_id: 'cfg-1',
    session_id_hash: 'hash:sid',
    from_date: new Date('2024-10-01'),
    to_date: new Date('2024-10-15'),
    concurrency: 5,
    current_stage: 'INGEST_DAILY',
    cursor_instrument_id: 0,
    instrument_ids: [101, 102, 103],
    requested_symbols: null,
    retry_count: 0,
    max_retries: 3,
    lease_owner: null,
    lease_expires_at: null,
    total_instruments: 3,
    processed_instruments: 0,
    ...overrides,
  };
}

const session: KiteSession = {
  accessToken: 'token',
  userId: 'user',
  userName: 'User',
  email: 'u@example.com',
  loginTime: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
};

class MemoryStore implements ScanJobStore {
  jobs = new Map<string, ScanJobRow>();
  batches: Array<{ id: string; status: string; error?: string }> = [];
  persistCalls: any[] = [];
  claimCalls = 0;

  constructor(job: ScanJobRow) {
    this.jobs.set(job.job_id, { ...job });
  }

  claim: ScanJobStore['claim'] = async ({ jobId, sessionIdHash, leaseOwner }) => {
    this.claimCalls += 1;
    const job = jobId
      ? this.jobs.get(jobId)
      : [...this.jobs.values()].find(
          (j) =>
            (j.status === 'PENDING' || j.status === 'RUNNING') &&
            (!sessionIdHash || !j.session_id_hash || j.session_id_hash === sessionIdHash)
        );
    if (!job) return null;
    if (job.status !== 'PENDING' && job.status !== 'RUNNING') return null;
    if (sessionIdHash && job.session_id_hash && job.session_id_hash !== sessionIdHash) {
      return null;
    }
    const leaseExpiry = job.lease_expires_at ? new Date(job.lease_expires_at) : null;
    if (job.lease_owner && leaseExpiry && leaseExpiry > new Date()) {
      return null;
    }
    const claimed: ScanJobRow = {
      ...job,
      status: 'RUNNING',
      lease_owner: leaseOwner,
      lease_expires_at: new Date(Date.now() + 90_000),
    };
    this.jobs.set(claimed.job_id, claimed);
    return claimed;
  };

  insertBatch: ScanJobStore['insertBatch'] = async () => {
    const id = `batch-${this.batches.length + 1}`;
    this.batches.push({ id, status: 'RUNNING' });
    return id;
  };

  completeBatch: ScanJobStore['completeBatch'] = async (batchId) => {
    const b = this.batches.find((x) => x.id === batchId);
    if (b) b.status = 'SUCCESS';
  };

  failBatch: ScanJobStore['failBatch'] = async (batchId, errorMessage) => {
    const b = this.batches.find((x) => x.id === batchId);
    if (b) {
      b.status = 'FAILED';
      b.error = errorMessage;
    }
  };

  persist: ScanJobStore['persist'] = async (opts) => {
    this.persistCalls.push(opts);
    const job = this.jobs.get(opts.jobId);
    if (!job) return;
    this.jobs.set(opts.jobId, {
      ...job,
      status: opts.status,
      current_stage: opts.stage,
      cursor_instrument_id: opts.cursorInstrumentId,
      processed_instruments: opts.processedInstruments,
      total_instruments: opts.totalInstruments,
      progress_percent: opts.progressPercent,
      retry_count: opts.retryCount,
      instrument_ids: opts.instrumentIds ?? job.instrument_ids,
      error_message: opts.errorMessage ?? null,
      completed_at: opts.completedAt ?? null,
      lease_owner: null,
      lease_expires_at: null,
    });
  };

  getJob: ScanJobStore['getJob'] = async (jobId) => this.jobs.get(jobId) ?? null;
}

function makeWorkers(overrides: Partial<ScanWorkers> = {}): ScanWorkers & { ingestDailyIds: number[] } {
  const ingestDailyIds: number[] = [];
  const workers = {
    syncChunk: jest.fn(async () => ({ upserted: 1, lastId: 50, done: true })),
    listActiveIds: jest.fn(async (ids?: number[]) => ids ?? [101, 102, 103]),
    resolveSymbols: jest.fn(async () => [101]),
    ingestDaily: jest.fn(async (_s, id) => {
      ingestDailyIds.push(id);
      return 0;
    }),
    ingestHourly: jest.fn(async () => 0),
    aggregateDaily: jest.fn(async () => undefined),
    aggregate4H: jest.fn(async () => 0),
    detectZones: jest.fn(async () => undefined),
    snapshots: jest.fn(async (ids?: number[]) =>
      (ids ?? []).map((instrumentId) => ({
        instrumentId,
        close: 100,
        high: 101,
        low: 99,
        date: new Date('2024-10-15'),
      }))
    ),
    lifecycles: jest.fn(async () => undefined),
    loadSession: jest.fn(async () => session),
    ...overrides,
  };
  return Object.assign(workers, { ingestDailyIds });
}

describe('selectNextInstrumentBatch', () => {
  test('returns the next bounded slice after the cursor', () => {
    const ids = [10, 20, 30, 40, 50];
    expect(selectNextInstrumentBatch(ids, 20, 2)).toEqual({
      batch: [30, 40],
      nextCursor: 40,
      done: false,
    });
  });

  test('marks the stage done when the remaining set fits in one batch', () => {
    expect(selectNextInstrumentBatch([10, 20], 10, 5)).toEqual({
      batch: [20],
      nextCursor: 20,
      done: true,
    });
  });
});

describe('progressForStage / nextStage', () => {
  test('scales progress inside the stage band after work succeeds', () => {
    expect(progressForStage('INGEST_DAILY', 0, 3)).toBe(5);
    expect(progressForStage('INGEST_DAILY', 3, 3)).toBe(20);
    expect(progressForStage('DETECT_ZONES', 1, 2)).toBe(73);
  });

  test('walks stages in pipeline order', () => {
    expect(nextStage('SYNC_INSTRUMENTS')).toBe('INGEST_DAILY');
    expect(nextStage('DETECT_ZONES')).toBe('LIFECYCLE');
    expect(nextStage('LIFECYCLE')).toBeNull();
  });
});

describe('processScanBatch', () => {
  test('claims a job, processes one bounded ingest slice, and advances the cursor only after success', async () => {
    const store = new MemoryStore(
      makeJob({
        current_stage: 'INGEST_DAILY',
        instrument_ids: [101, 102, 103, 104, 105],
        total_instruments: 5,
      })
    );
    const workers = makeWorkers();
    const result = await processScanBatch(
      { jobId: 'job-1', session, sessionIdHash: 'hash:sid' },
      store,
      workers
    );

    expect(result.claimed).toBe(true);
    expect(result.status).toBe('RUNNING');
    expect(workers.ingestDaily).toHaveBeenCalledTimes(3);
    expect(store.batches[0].status).toBe('SUCCESS');
    expect(store.persistCalls).toHaveLength(1);
    expect(store.persistCalls[0].cursorInstrumentId).toBe(103);
    expect(store.persistCalls[0].progressPercent).toBeGreaterThan(0);
    expect(store.jobs.get('job-1')?.current_stage).toBe('INGEST_DAILY');
    expect(store.jobs.get('job-1')?.cursor_instrument_id).toBe(103);
    expect(store.jobs.get('job-1')?.status).toBe('RUNNING');
  });

  test('does not advance the checkpoint when a batch throws', async () => {
    const store = new MemoryStore(makeJob({ current_stage: 'INGEST_DAILY', max_retries: 3 }));
    const workers = makeWorkers({
      ingestDaily: jest.fn(async () => {
        throw new Error('UND_ERR_SOCKET');
      }),
    });

    const result = await processScanBatch({ jobId: 'job-1', session }, store, workers);

    expect(result.status).toBe('RUNNING');
    expect(result.moreRemaining).toBe(true);
    expect(result.errorMessage).toBe('UND_ERR_SOCKET');
    expect(store.batches[0].status).toBe('FAILED');
    expect(store.jobs.get('job-1')?.cursor_instrument_id).toBe(0);
    expect(store.jobs.get('job-1')?.progress_percent).toBe(0);
    expect(store.jobs.get('job-1')?.retry_count).toBe(1);
    expect(store.jobs.get('job-1')?.status).toBe('RUNNING');
  });

  test('fails the parent job after retry limits are exhausted', async () => {
    const store = new MemoryStore(
      makeJob({ current_stage: 'INGEST_HOURLY', retry_count: 2, max_retries: 3 })
    );
    const workers = makeWorkers({
      ingestHourly: jest.fn(async () => {
        throw new Error('rate limit');
      }),
    });

    const result = await processScanBatch({ jobId: 'job-1', session }, store, workers);
    expect(result.status).toBe('FAILED');
    expect(result.moreRemaining).toBe(false);
    expect(store.jobs.get('job-1')?.status).toBe('FAILED');
    expect(store.jobs.get('job-1')?.completed_at).toBeTruthy();
    expect(store.jobs.get('job-1')?.cursor_instrument_id).toBe(0);
  });

  test('prevents a second worker from processing the same leased job', async () => {
    const store = new MemoryStore(makeJob());
    const workers = makeWorkers({
      ingestDaily: jest.fn(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return 0;
      }),
    });

    const firstClaim = store.claim({ jobId: 'job-1', leaseOwner: 'w1' });
    await firstClaim;
    const second = await processScanBatch({ jobId: 'job-1', session }, store, workers);
    expect(second.claimed).toBe(false);
    expect(second.moreRemaining).toBe(true);
    expect(second.status).toBe('RUNNING');
    expect(workers.ingestDaily).not.toHaveBeenCalled();
  });

  test('does not report remaining work for another session\'s job when the claim misses', async () => {
    const store = new MemoryStore(makeJob({ session_id_hash: 'hash:other' }));
    const workers = makeWorkers();
    const result = await processScanBatch(
      { jobId: 'job-1', sessionIdHash: 'hash:sid', session },
      store,
      workers
    );
    expect(result.claimed).toBe(false);
    expect(result.moreRemaining).toBe(false);
    expect(workers.ingestDaily).not.toHaveBeenCalled();
  });

  test('allows another worker to resume after the lease is released', async () => {
    const store = new MemoryStore(makeJob({ current_stage: 'AGGREGATE_DAILY' }));
    const workers = makeWorkers();
    await processScanBatch({ jobId: 'job-1', session }, store, workers);
    expect(store.jobs.get('job-1')?.lease_owner).toBeNull();

    store.jobs.get('job-1')!.current_stage = 'AGGREGATE_4H';
    const again = await processScanBatch({ jobId: 'job-1', session }, store, workers);
    expect(again.claimed).toBe(true);
    expect(workers.aggregate4H).toHaveBeenCalled();
  });

  test('completes lifecycle as the final stage and reports 100% only then', async () => {
    const store = new MemoryStore(
      makeJob({
        current_stage: 'LIFECYCLE',
        cursor_instrument_id: 0,
        instrument_ids: [101],
        total_instruments: 1,
      })
    );
    const workers = makeWorkers();
    const result = await processScanBatch({ jobId: 'job-1', session }, store, workers);
    expect(result.status).toBe('SUCCESS');
    expect(result.progressPercent).toBe(100);
    expect(result.moreRemaining).toBe(false);
    expect(workers.lifecycles).toHaveBeenCalled();
    expect(store.jobs.get('job-1')?.status).toBe('SUCCESS');
  });

  test('retries the same ingest ids after a failed batch (idempotent checkpoint)', async () => {
    const store = new MemoryStore(makeJob({ current_stage: 'INGEST_DAILY', instrument_ids: [101] }));
    let attempts = 0;
    const workers = makeWorkers({
      ingestDaily: jest.fn(async (_s, id) => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary');
        return 1 as any;
      }),
    });

    await processScanBatch({ jobId: 'job-1', session }, store, workers);
    expect(store.jobs.get('job-1')?.cursor_instrument_id).toBe(0);

    const retry = await processScanBatch({ jobId: 'job-1', session }, store, workers);
    expect(retry.status).toBe('RUNNING');
    expect(workers.ingestDaily).toHaveBeenLastCalledWith(session, 101, expect.any(Date), expect.any(Date));
    expect(store.jobs.get('job-1')?.current_stage).toBe('INGEST_HOURLY');
  });

  test('skips instrument-master sync when requested symbols already resolve', async () => {
    const store = new MemoryStore(
      makeJob({
        current_stage: 'SYNC_INSTRUMENTS',
        instrument_ids: null,
        requested_symbols: ['RELIANCE'],
      })
    );
    const workers = makeWorkers({
      resolveSymbols: jest.fn(async () => [101]),
    });
    const result = await processScanBatch({ jobId: 'job-1', session }, store, workers);
    expect(workers.syncChunk).not.toHaveBeenCalled();
    expect(result.status).toBe('RUNNING');
    expect(store.jobs.get('job-1')?.current_stage).toBe('INGEST_DAILY');
    expect(store.jobs.get('job-1')?.instrument_ids).toEqual([101]);
    expect(store.jobs.get('job-1')?.progress_percent).toBe(5);
  });

  test('does not mark the job complete when requested symbols are still missing after sync', async () => {
    const store = new MemoryStore(
      makeJob({
        current_stage: 'SYNC_INSTRUMENTS',
        instrument_ids: null,
        requested_symbols: ['RELIANCE', 'MISSING'],
      })
    );
    const workers = makeWorkers({
      resolveSymbols: jest.fn(async () => [101]),
      syncChunk: jest.fn(async () => ({ upserted: 2, lastId: 99, done: true })),
    });
    const result = await processScanBatch({ jobId: 'job-1', session }, store, workers);
    expect(result.status).toBe('RUNNING');
    expect(result.moreRemaining).toBe(true);
    expect(store.jobs.get('job-1')?.status).toBe('RUNNING');
    expect(store.jobs.get('job-1')?.progress_percent).toBe(0);
    expect(store.jobs.get('job-1')?.cursor_instrument_id).toBe(0);
    expect(result.errorMessage).toMatch(/not found after instrument sync/i);
  });

  test('runs a one-symbol pipeline from daily ingest through success without marking success early', async () => {
    const store = new MemoryStore(
      makeJob({
        current_stage: 'INGEST_DAILY',
        instrument_ids: [101],
        total_instruments: 1,
      })
    );
    const workers = makeWorkers();
    const seen: Array<{ stage: ScanStage; status: ScanJobStatus; pct: number }> = [];

    let guard = 0;
    while (guard++ < 20) {
      const result = await processScanBatch({ jobId: 'job-1', session }, store, workers);
      const job = store.jobs.get('job-1')!;
      seen.push({ stage: job.current_stage, status: job.status, pct: job.progress_percent });
      if (result.status === 'SUCCESS' || result.status === 'FAILED' || !result.moreRemaining) break;
    }

    expect(seen.some((s) => s.status === 'SUCCESS' && s.pct < 100)).toBe(false);
    expect(seen[seen.length - 1]).toEqual({
      stage: 'LIFECYCLE',
      status: 'SUCCESS',
      pct: 100,
    });
    expect(workers.ingestDaily).toHaveBeenCalled();
    expect(workers.ingestHourly).toHaveBeenCalled();
    expect(workers.aggregateDaily).toHaveBeenCalled();
    expect(workers.aggregate4H).toHaveBeenCalled();
    expect(workers.detectZones).toHaveBeenCalled();
    expect(workers.lifecycles).toHaveBeenCalled();
  });
});
