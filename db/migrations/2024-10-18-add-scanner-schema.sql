-- 2024-10-18 Add scanner domain tables
-- Additive migration for Supply/Demand zone scanner (Phase 2)

-- Instruments master (versioned)
CREATE TABLE IF NOT EXISTS instruments (
  instrument_id      BIGINT PRIMARY KEY,                -- Kite instrument token
  symbol             TEXT   NOT NULL,
  exchange           TEXT   NOT NULL,
  company_name       TEXT,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  source             TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Daily OHLCV candles (immutable after validation)
CREATE TABLE IF NOT EXISTS daily_candles (
  instrument_id   BIGINT NOT NULL REFERENCES instruments(instrument_id),
  candle_date     DATE   NOT NULL,
  open            NUMERIC(12,4) NOT NULL,
  high            NUMERIC(12,4) NOT NULL,
  low             NUMERIC(12,4) NOT NULL,
  close           NUMERIC(12,4) NOT NULL,
  volume          BIGINT NOT NULL,
  source          TEXT NOT NULL,               -- e.g. "kite"
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (instrument_id, candle_date)
);

-- Scanner configuration snapshots (versioned JSON)
CREATE TABLE IF NOT EXISTS scanner_configs (
  config_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version          INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  config_json      JSONB NOT NULL               -- full rule set, thresholds
);

-- Detected zones (materialised projection)
CREATE TABLE IF NOT EXISTS zones (
  zone_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id    BIGINT NOT NULL REFERENCES instruments(instrument_id),
  timeframe        TEXT   NOT NULL,            -- 1D,1W,1M,3M,6M,1Y
  pattern          TEXT   NOT NULL,            -- DBR,RBR,RBD,DBD
  side             TEXT   NOT NULL,            -- DEMAND or SUPPLY
  base_start       TIMESTAMPTZ NOT NULL,
  base_end         TIMESTAMPTZ NOT NULL,
  leg_in_ts        TIMESTAMPTZ NOT NULL,
  leg_out_ts       TIMESTAMPTZ NOT NULL,
  zone_low         NUMERIC(12,4) NOT NULL,
  zone_high        NUMERIC(12,4) NOT NULL,
  proximal         NUMERIC(12,4) NOT NULL,
  distal           NUMERIC(12,4) NOT NULL,
  formation_ts     TIMESTAMPTZ NOT NULL,
  config_version   INTEGER NOT NULL,
  score            INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  lifecycle_state  TEXT NOT NULL,           -- CONFIRMED_FRESH, TOUCHED_ONCE, RETESTED, BROKEN
  last_touch_ts    TIMESTAMPTZ,
  touch_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Immutable zone events (append‑only)
CREATE TABLE IF NOT EXISTS zone_events (
  event_id         BIGSERIAL PRIMARY KEY,
  zone_id          UUID NOT NULL REFERENCES zones(zone_id),
  event_type       TEXT NOT NULL,               -- TOUCH, BREAK, RETEST
  candle_ts        TIMESTAMPTZ NOT NULL,
  details_json     JSONB,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Scan job bookkeeping
CREATE TABLE IF NOT EXISTS scan_jobs (
  job_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  status           TEXT NOT NULL,               -- PENDING, RUNNING, SUCCESS, FAILED
  progress_percent INTEGER NOT NULL DEFAULT 0,
  error_message    TEXT,
  config_id        UUID NOT NULL REFERENCES scanner_configs(config_id)
);

-- Per‑instrument ingestion checkpoint for incremental historic fetch
CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
  instrument_id    BIGINT PRIMARY KEY REFERENCES instruments(instrument_id),
  last_candle_date DATE NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_daily_candles_instr_date ON daily_candles(instrument_id, candle_date);
CREATE INDEX IF NOT EXISTS idx_zones_instrument_timeframe ON zones(instrument_id, timeframe, side);
CREATE INDEX IF NOT EXISTS idx_zone_events_zone_type ON zone_events(zone_id, event_type);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(status);
