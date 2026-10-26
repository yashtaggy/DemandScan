#!/usr/bin/env node
/**
 * DemandScan — Database migration runner
 *
 * Applies db/schema.sql and any additional *.sql files in db/migrations/ to the
 * Neon Postgres database configured via DATABASE_URL. The URL is read from the
 * process environment first, then `.env.local` (or the file named by
 * DB_ENV_FILE). The sanitized target is printed before anything is applied.
 *
 * Usage:
 *   node db/migrate.js
 *   DB_ENV_FILE=.env.production.local node db/migrate.js
 *
 * This script is IDEMPOTENT — safe to run multiple times. It does NOT drop or truncate any existing tables.
 */

const { readFileSync, readdirSync } = require('fs');
const { join } = require('path');
const { loadDatabaseUrl, describeTarget } = require('./target');

async function migrate() {
  const { url, source } = loadDatabaseUrl();
  if (!url) {
    console.error(
      'ERROR: DATABASE_URL is not set.\n' +
        'Add it to .env.local (local), set DB_ENV_FILE, or pass it inline.'
    );
    process.exit(1);
  }

  let target;
  try {
    target = describeTarget(url);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
  console.log(
    `Database target: host=${target.host} database=${target.database} ` +
      `sslmode=${target.sslmode} source=${source ?? 'unknown'} (credentials omitted)`
  );

  const { neon } = require('@neondatabase/serverless');
  const sql = neon(url);

  // Helper to execute a .sql file (may contain multiple statements separated by ';')
  // Comments must be stripped BEFORE splitting on ';' — comment text can itself
  // contain ';' (see db/migrations/2024-10-18-v1-*.sql), which produced garbage
  // statements and crashed the runner mid-file, leaving databases partially migrated.
  const { splitStatements } = require('./sql-statements');
  async function applySqlFile(filePath) {
    const statements = splitStatements(readFileSync(filePath, 'utf8'));
    for (const stmt of statements) {
      await sql.query(stmt, []);
    }
  }

  // Apply the base schema (creates kite_sessions)
  const schemaPath = join(__dirname, 'schema.sql');
  console.log('Applying db/schema.sql …');
  await applySqlFile(schemaPath);

  // Apply any additional migration scripts (sorted alphabetically for deterministic order)
  const migrationsDir = join(__dirname, 'migrations');
  try {
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const f of files) {
      const fullPath = join(migrationsDir, f);
      console.log(`Applying migration ${f} …`);
      await applySqlFile(fullPath);
    }
  } catch (e) {
    // migrations directory may not exist – that's fine.
  }

  console.log('Migration complete. All schema files applied.');
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
