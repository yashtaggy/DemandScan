-- 2024-10-18 DemandScan v1 — 1H/4H timeframes, coverage tracking, composite scoring, historical backfill
-- All statements use IF NOT EXISTS / IF EXISTS — safe to re-run.

-- ─── A. Hourly candles (raw 60-minute bars from Kite) ─────────────────────────
CREATE TABLE IF NOT EXISTS hourly_candles (
  instrument_id       BIGINT      NOT NULL REFERENCES instruments(instrument_id),
  candle_ts           TIMESTAMPTZ NOT NULL,  -- exact IST start of the 60-min bar
  open                NUMERIC(12,4) NOT NULL,
  high                NUMERIC(12,4) NOT NULL,
  low                 NUMERIC(12,4) NOT NULL,
  close               NUMERIC(12,4) NOT NULL,
  volume              BIGINT      NOT NULL,
  is_session_complete BOOLEAN     NOT NULL DEFAULT TRUE, -- false for candles outside normal session
  source              TEXT        NOT NULL,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (instrument_id, candle_ts)
);

-- ─── B. 4-hour candles (aggregated from hourly, session-aware) ────────────────
--
-- NSE session alignment (Asia/Kolkata):
--   AM session: 09:15 – 13:15  (4 full 60-min candles; is_complete = TRUE)
--   PM session: 13:15 – 15:30  (~2.25h, 3 60-min candles; is_complete = FALSE)
-- Cross-session grouping is never performed.
-- Zones may only form from candles where is_complete = TRUE.
CREATE TABLE IF NOT EXISTS four_hour_candles (
  instrument_id BIGINT      NOT NULL REFERENCES instruments(instrument_id),
  session_ts    TIMESTAMPTZ NOT NULL,  -- start of the 4H session (09:15 or 13:15 IST)
  session_label TEXT        NOT NULL CHECK (session_label IN ('AM','PM')),
  open          NUMERIC(12,4) NOT NULL,
  high          NUMERIC(12,4) NOT NULL,
  low           NUMERIC(12,4) NOT NULL,
  close         NUMERIC(12,4) NOT NULL,
  volume        BIGINT      NOT NULL,
  candle_count  INTEGER     NOT NULL,   -- number of 1H candles that contributed
  is_complete   BOOLEAN     NOT NULL,   -- TRUE only for full AM sessions
  source        TEXT        NOT NULL DEFAULT 'derived',
  PRIMARY KEY (instrument_id, session_ts)
);

-- ─── C. Candle coverage metadata (per instrument per timeframe) ───────────────
CREATE TABLE IF NOT EXISTS candle_coverage (
  instrument_id  BIGINT      NOT NULL REFERENCES instruments(instrument_id),
  timeframe      TEXT        NOT NULL CHECK (timeframe IN ('1H','4H','1D','1W','1M','3M','6M','1Y')),
  first_candle   DATE,
  last_candle    DATE,
  total_candles  INTEGER     NOT NULL DEFAULT 0,
  missing_gaps   INTEGER     NOT NULL DEFAULT 0,  -- estimated gap count
  last_updated   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (instrument_id, timeframe)
);

-- ─── D. Historical backfill job tracking ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS backfill_jobs (
  job_id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id       BIGINT      NOT NULL REFERENCES instruments(instrument_id),
  timeframe           TEXT        NOT NULL,
  from_date           DATE        NOT NULL,
  to_date             DATE        NOT NULL,
  last_processed_ts   TIMESTAMPTZ,          -- checkpoint for resumable replay
  status              TEXT        NOT NULL DEFAULT 'PENDING',
  candles_processed   INTEGER     NOT NULL DEFAULT 0,
  zones_formed        INTEGER     NOT NULL DEFAULT 0,
  error_message       TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

-- ─── E. Nifty 500 constituent membership history ──────────────────────────────
CREATE TABLE IF NOT EXISTS nifty500_membership (
  instrument_id  BIGINT  NOT NULL REFERENCES instruments(instrument_id),
  effective_from DATE    NOT NULL,
  effective_to   DATE,               -- NULL = currently a member
  added_reason   TEXT,
  removed_reason TEXT,
  PRIMARY KEY (instrument_id, effective_from)
);

-- ─── F. Extend zones table with composite scoring columns ────────────────────
ALTER TABLE zones ADD COLUMN IF NOT EXISTS composite_score   INTEGER;
ALTER TABLE zones ADD COLUMN IF NOT EXISTS score_components  JSONB;      -- per-component breakdown
ALTER TABLE zones ADD COLUMN IF NOT EXISTS distance_pct      NUMERIC(8,4); -- distance from current price %
ALTER TABLE zones ADD COLUMN IF NOT EXISTS confluence_score  INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE zones ADD COLUMN IF NOT EXISTS opposition_risk   INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE zones ADD COLUMN IF NOT EXISTS data_quality_score INTEGER    NOT NULL DEFAULT 5;

-- ─── G. Extend zone_events for historical replay ──────────────────────────────
ALTER TABLE zone_events ADD COLUMN IF NOT EXISTS is_historical BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE zone_events ADD COLUMN IF NOT EXISTS as_of_date    DATE;

-- ─── H. Hourly ingestion checkpoints ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hourly_ingestion_checkpoints (
  instrument_id  BIGINT      PRIMARY KEY REFERENCES instruments(instrument_id),
  last_candle_ts TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_hourly_candles_instr_ts   ON hourly_candles (instrument_id, candle_ts);
CREATE INDEX IF NOT EXISTS idx_4h_candles_instr_ts       ON four_hour_candles (instrument_id, session_ts);
CREATE INDEX IF NOT EXISTS idx_candle_coverage_tf        ON candle_coverage (timeframe);
CREATE INDEX IF NOT EXISTS idx_backfill_jobs_status      ON backfill_jobs (status);
CREATE INDEX IF NOT EXISTS idx_backfill_jobs_instr_tf    ON backfill_jobs (instrument_id, timeframe);
CREATE INDEX IF NOT EXISTS idx_nifty500_effective        ON nifty500_membership (effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_zones_composite           ON zones (composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_zones_distance            ON zones (distance_pct);
CREATE INDEX IF NOT EXISTS idx_zone_events_historical    ON zone_events (is_historical, as_of_date);
