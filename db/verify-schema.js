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
 * Single source of truth lives in db/expected-schema.js (also asserted by
 * __tests__/scanner/schema.test.ts against the repo migration files).
 */
const { EXPECTED_SCHEMA } = require('./expected-schema');

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
