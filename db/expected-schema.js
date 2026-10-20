/**
 * DemandScan — shared schema contract.
 *
 * Single source of truth for the tables/columns the application code requires.
 * Consumed by:
 *   - db/verify-schema.js   (read-only check against a live database)
 *   - __tests__/scanner/schema.test.ts (asserts the repo migrations actually
 *     create everything the code expects)
 *
 * Every entry here MUST be backed by a CREATE TABLE / ALTER TABLE statement in
 * db/schema.sql or db/migrations/*.sql. The test suite enforces that.
 */

const EXPECTED_SCHEMA = {
  // db/schema.sql
  kite_sessions: [
    'session_id_hash',
    'encrypted_access_token',
    'user_id',
    'user_name',
    'email',
    'login_time',
    'expires_at',
    'created_at',
  ],

  // 2024-10-18-add-scanner-schema.sql
  instruments: [
    'instrument_id',
    'symbol',
    'exchange',
    'company_name',
    'active',
    'source',
    'updated_at',
  ],
  daily_candles: [
    'instrument_id',
    'candle_date',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'source',
    'fetched_at',
  ],
  scanner_configs: ['config_id', 'version', 'created_at', 'config_json'],
  zones: [
    'zone_id',
    'instrument_id',
    'timeframe',
    'pattern',
    'side',
    'base_start',
    'base_end',
    'leg_in_ts',
    'leg_out_ts',
    'zone_low',
    'zone_high',
    'proximal',
    'distal',
    'formation_ts',
    'config_version',
    'score',
    'lifecycle_state',
    'last_touch_ts',
    'touch_count',
    'created_at',
    // v1 composite scoring columns
    'composite_score',
    'score_components',
    'distance_pct',
    'confluence_score',
    'opposition_risk',
    'data_quality_score',
  ],
  zone_events: [
    'event_id',
    'zone_id',
    'event_type',
    'candle_ts',
    'details_json',
    'recorded_at',
    // v1 historical replay columns
    'is_historical',
    'as_of_date',
  ],
  scan_jobs: [
    'job_id',
    'started_at',
    'completed_at',
    'status',
    'progress_percent',
    'error_message',
    'config_id',
    // 2026-10-20 resumable batch checkpoints
    'session_id_hash',
    'from_date',
    'to_date',
    'concurrency',
    'current_stage',
    'cursor_instrument_id',
    'instrument_ids',
    'requested_symbols',
    'retry_count',
    'max_retries',
    'lease_owner',
    'lease_expires_at',
    'total_instruments',
    'processed_instruments',
  ],
  ingestion_checkpoints: ['instrument_id', 'last_candle_date', 'updated_at'],

  // 2024-10-18-add-aggregation-schema.sql
  aggregated_candles: [
    'agg_id',
    'instrument_token',
    'timeframe',
    'period_start',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'created_at',
  ],

  // 2024-10-18-v1-intraday-scoring-history.sql
  hourly_candles: [
    'instrument_id',
    'candle_ts',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'is_session_complete',
    'source',
    'fetched_at',
  ],
  four_hour_candles: [
    'instrument_id',
    'session_ts',
    'session_label',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'candle_count',
    'is_complete',
    'source',
  ],
  candle_coverage: [
    'instrument_id',
    'timeframe',
    'first_candle',
    'last_candle',
    'total_candles',
    'missing_gaps',
    'last_updated',
  ],
  backfill_jobs: [
    'job_id',
    'instrument_id',
    'timeframe',
    'from_date',
    'to_date',
    'last_processed_ts',
    'status',
    'candles_processed',
    'zones_formed',
    'error_message',
    'started_at',
    'completed_at',
  ],
  nifty500_membership: [
    'instrument_id',
    'effective_from',
    'effective_to',
    'added_reason',
    'removed_reason',
  ],
  hourly_ingestion_checkpoints: ['instrument_id', 'last_candle_ts', 'updated_at'],

  // 2026-10-20-add-scan-batch-checkpoints.sql
  scan_job_batches: [
    'batch_id',
    'job_id',
    'stage',
    'cursor_start',
    'cursor_end',
    'instrument_ids',
    'status',
    'attempt',
    'error_message',
    'lease_owner',
    'started_at',
    'completed_at',
  ],
};

module.exports = { EXPECTED_SCHEMA };
