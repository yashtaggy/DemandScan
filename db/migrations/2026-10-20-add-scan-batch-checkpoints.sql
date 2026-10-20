-- 2026-10-20 Additive scan-job checkpointing for resumable serverless batches.
-- Safe to re-run. Does not drop or truncate existing tables or data.

ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS session_id_hash TEXT;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS from_date DATE;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS to_date DATE;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS concurrency INTEGER NOT NULL DEFAULT 5;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS current_stage TEXT NOT NULL DEFAULT 'SYNC_INSTRUMENTS';
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS cursor_instrument_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS instrument_ids JSONB;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS requested_symbols JSONB;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 5;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS total_instruments INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS processed_instruments INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_scan_jobs_status_lease
  ON scan_jobs (status, lease_expires_at);

CREATE TABLE IF NOT EXISTS scan_job_batches (
  batch_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                UUID NOT NULL REFERENCES scan_jobs(job_id),
  stage                 TEXT NOT NULL,
  cursor_start          BIGINT NOT NULL DEFAULT 0,
  cursor_end            BIGINT NOT NULL DEFAULT 0,
  instrument_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
  status                TEXT NOT NULL, -- PENDING, RUNNING, SUCCESS, FAILED
  attempt               INTEGER NOT NULL DEFAULT 1,
  error_message         TEXT,
  lease_owner           TEXT,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_scan_job_batches_job_stage
  ON scan_job_batches (job_id, stage, status);
