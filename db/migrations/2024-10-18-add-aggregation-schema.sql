-- Add aggregation table for multi‑timeframe candles
CREATE TABLE IF NOT EXISTS aggregated_candles (
  agg_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_token BIGINT NOT NULL,
  timeframe TEXT NOT NULL CHECK (timeframe IN ('1W','1M','3M','6M','1Y')),
  period_start DATE NOT NULL,
  open NUMERIC(15,4) NOT NULL,
  high NUMERIC(15,4) NOT NULL,
  low NUMERIC(15,4) NOT NULL,
  close NUMERIC(15,4) NOT NULL,
  volume BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (instrument_token, timeframe, period_start)
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_agg_candles_instrument_timeframe ON aggregated_candles (instrument_token, timeframe);
CREATE INDEX IF NOT EXISTS idx_agg_candles_period_start ON aggregated_candles (period_start);
