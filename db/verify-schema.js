#!/usr/bin/env node
/**
 * DemandScan — read-only schema verification.
 *
 * Checks that every table/column the application code expects actually exists
 * in the database configured via DATABASE_URL. Intended to catch schema drift
 * between the repo migrations (db/schema.sql + db/migrations/*.sql) and a live
 * database — e.g. a migration that was committed but never applied.
 *
 * This script NEVER modifies data. It only queries information_schema.
 *
 * Usage:
 *   node db/verify-schema.js                              (uses .env.local)
 *   DATABASE_URL="postgres://..." node db/verify-schema.js (check production)
 *
 * Exit code 0 = schema matches, 1 = missing objects or connection error.
 */

// Load .env.local manually for local dev (same behaviour as db/migrate.js)
try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
} catch {
  // dotenv not installed or .env.local missing — rely on process.env
}

/**
 * The schema contract the current code requires.
 * Keep in sync with lib/scanner/jobs.ts, lib/kite-session.ts,
 * lib/scanner/score.ts / confluence.ts (zone scoring columns).
 */
const EXPECTED_SCHEMA = {
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
  scan_jobs: [
    'job_id',
    'started_at',
    'completed_at',
    'status',
    'progress_percent',
    'error_message',
    'config_id',
    // 2026-10-20 resumable batch checkpoints — the columns missing in production
    // when POST /api/scanner/run fails with 42703 "session_id_hash does not exist".
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
  zones: [
    // v1 composite scoring columns
    'composite_score',
    'score_components',
    'distance_pct',
    'confluence_score',
    'opposition_risk',
    'data_quality_score',
  ],
  scanner_configs: ['config_id', 'version', 'created_at', 'config_json'],
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'ERROR: DATABASE_URL is not set.\n' +
        'Add it to .env.local (local) or pass it inline:\n' +
        '  DATABASE_URL="postgres://..." node db/verify-schema.js'
    );
    process.exit(1);
  }

  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);

  const tables = Object.keys(EXPECTED_SCHEMA);
  const rows = await sql.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1)`,
    [tables]
  );

  const actual = new Map(tables.map((t) => [t, new Set()]));
  for (const row of rows) {
    actual.get(row.table_name)?.add(row.column_name);
  }

  let missingCount = 0;
  for (const [table, expectedCols] of Object.entries(EXPECTED_SCHEMA)) {
    const have = actual.get(table);
    if (!have || have.size === 0) {
      console.error(`MISSING TABLE  ${table}`);
      missingCount += expectedCols.length;
      continue;
    }
    const missing = expectedCols.filter((c) => !have.has(c));
    if (missing.length === 0) {
      console.log(`ok             ${table} (${expectedCols.length} expected columns present)`);
    } else {
      for (const col of missing) {
        console.error(`MISSING COLUMN ${table}.${col}`);
      }
      missingCount += missing.length;
    }
  }

  if (missingCount > 0) {
    console.error(
      `\n${missingCount} schema object(s) missing. Apply the repo migrations:\n` +
        '  node db/migrate.js\n' +
        '(or run db/migrations/*.sql in the Neon SQL Editor), then re-run this check.'
    );
    process.exit(1);
  }

  console.log('\nSchema verification passed.');
}

main().catch((err) => {
  console.error('Schema verification failed:', err.message);
  process.exit(1);
});
