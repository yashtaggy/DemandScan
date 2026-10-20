/**
 * Schema-drift regression tests.
 *
 * The production 500 on POST /api/scanner/run
 * (`NeonDbError: column "session_id_hash" does not exist`, code 42703) happened
 * because db/migrations/2026-10-20-add-scan-batch-checkpoints.sql was committed
 * to the repo but never applied to the production database. Vercel deploys do
 * not run migrations — db/migrate.js is manual — so the live scan_jobs table
 * stayed in its 2024-10-18 shape while the code queried the new columns.
 *
 * These tests parse db/schema.sql + db/migrations/*.sql the same way
 * db/migrate.js applies them and assert that every table/column the code
 * expects is provided by the repo migrations. They fail loudly if code and
 * migrations drift apart again.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DB_DIR = join(__dirname, '..', '..', 'db');
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');

function loadSqlFiles(): Array<{ name: string; sql: string }> {
  const files = [{ name: 'schema.sql', sql: readFileSync(join(DB_DIR, 'schema.sql'), 'utf8') }];
  for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) {
    files.push({ name: `migrations/${f}`, sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') });
  }
  return files;
}

function stripCommentLines(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

const CONSTRAINT_KEYWORDS = new Set([
  'PRIMARY',
  'CONSTRAINT',
  'UNIQUE',
  'FOREIGN',
  'CHECK',
  'EXCLUDE',
  'LIKE',
]);

/** Parse `CREATE TABLE IF NOT EXISTS name (...)` bodies (one column per line). */
function parseCreatedTables(sql: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const withoutComments = stripCommentLines(sql);
  const createRe = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(([\s\S]*?)\);/gi;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(withoutComments)) !== null) {
    const [, name, body] = m;
    const columns = tables.get(name) ?? new Set<string>();
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line) continue;
      const token = (line.match(/^"?([A-Za-z_][A-Za-z0-9_]*)"?/) ?? [])[1];
      if (!token || CONSTRAINT_KEYWORDS.has(token.toUpperCase())) continue;
      columns.add(token);
    }
    tables.set(name, columns);
  }
  return tables;
}

/** Parse `ALTER TABLE name ADD COLUMN IF NOT EXISTS col ...` statements. */
function parseAddedColumns(sql: string): Map<string, Set<string>> {
  const added = new Map<string, Set<string>>();
  const alterRe =
    /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = alterRe.exec(sql)) !== null) {
    const [, table, column] = m;
    const cols = added.get(table) ?? new Set<string>();
    cols.add(column);
    added.set(table, cols);
  }
  return added;
}

/** Merge schema.sql + all migrations in the order db/migrate.js applies them. */
function buildEffectiveSchema(): Map<string, Set<string>> {
  const effective = new Map<string, Set<string>>();
  const merge = (patch: Map<string, Set<string>>) => {
    for (const [table, columns] of patch) {
      const existing = effective.get(table) ?? new Set<string>();
      for (const c of columns) existing.add(c);
      effective.set(table, existing);
    }
  };
  for (const { sql } of loadSqlFiles()) {
    merge(parseCreatedTables(sql));
    merge(parseAddedColumns(sql));
  }
  return effective;
}

describe('database schema matches application code (schema-drift guard)', () => {
  const schema = buildEffectiveSchema();
  const expectColumns = (table: string, columns: string[]) => {
    const have = schema.get(table);
    if (!have) {
      throw new Error(`table ${table} should be created by schema.sql or a migration`);
    }
    const missing = columns.filter((col) => !have.has(col));
    expect(missing).toEqual([]);
  };

  test('kite_sessions has every column used by lib/kite-session.ts', () => {
    expectColumns('kite_sessions', [
      'session_id_hash', // SHA-256 of ds_sid cookie — PRIMARY KEY
      'encrypted_access_token', // AES-256-GCM encrypted Kite token
      'user_id',
      'user_name',
      'email',
      'login_time',
      'expires_at',
      'created_at',
    ]);
  });

  test('scan_jobs has every column used by lib/scanner/jobs.ts (incl. session_id_hash)', () => {
    expectColumns('scan_jobs', [
      'job_id',
      'started_at',
      'completed_at',
      'status',
      'progress_percent',
      'error_message',
      'config_id',
      // Ownership + resumable-checkpoint columns added for the browser-driven
      // scan worker. session_id_hash is the column production was missing
      // when POST /api/scanner/run returned HTTP 500 (NeonDbError 42703).
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
    ]);
  });

  test('scan_job_batches has every column used by lib/scanner/jobs.ts', () => {
    expectColumns('scan_job_batches', [
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
    ]);
  });

  test('zones has the v1 composite-scoring columns used by score/confluence', () => {
    expectColumns('zones', [
      'composite_score',
      'score_components',
      'distance_pct',
      'confluence_score',
      'opposition_risk',
      'data_quality_score',
    ]);
  });

  test('scan_job_batches.job_id references scan_jobs(job_id) for checkpoint integrity', () => {
    const allSql = loadSqlFiles()
      .map((f) => stripCommentLines(f.sql))
      .join('\n');
    expect(allSql).toMatch(/REFERENCES\s+scan_jobs\s*\(\s*job_id\s*\)/i);
  });

  test('the scan-job checkpoint migration is additive and idempotent', () => {
    const migration = loadSqlFiles().find((f) =>
      f.name.includes('2026-10-20-add-scan-batch-checkpoints')
    );
    expect(migration).toBeDefined();
    const sql = stripCommentLines(migration!.sql);
    // Must use IF NOT EXISTS so re-runs against an already-migrated DB are safe.
    expect(sql).toMatch(
      /ALTER\s+TABLE\s+scan_jobs\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+session_id_hash/i
    );
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });
});
