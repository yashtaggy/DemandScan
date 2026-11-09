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
 * The follow-up production failure (`relation "hourly_ingestion_checkpoints"
 * does not exist`, code 42P01, during INGEST_HOURLY) had a deeper cause: the
 * old db/migrate.js split migration files on ';' BEFORE stripping '--' comment
 * lines. Semicolons inside the v1 migration's own comments produced garbage
 * statements that crashed the runner mid-file, so NO database ever received
 * the tables after the crash point — including hourly_ingestion_checkpoints.
 *
 * These tests parse db/schema.sql + db/migrations/*.sql and assert:
 *   1. Every table/column in the shared contract (db/expected-schema.js) is
 *      provided by the repo migrations.
 *   2. The fixed statement splitter used by db/migrate.js produces only valid
 *      statements for every .sql file — the comment-semicolon bug stays fixed.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Shared contract (also used by db/verify-schema.js at runtime) and the fixed
// statement splitter used by db/migrate.js. Both are CommonJS — require() them.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EXPECTED_SCHEMA } = require(join(__dirname, '..', '..', 'db', 'expected-schema'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { splitStatements } = require(join(__dirname, '..', '..', 'db', 'sql-statements'));

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

  test('every table/column in the shared contract is created by the repo migrations', () => {
    for (const [table, columns] of Object.entries(
      EXPECTED_SCHEMA as Record<string, string[]>
    )) {
      expectColumns(table, columns);
    }
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

describe('Live Trade schema contract (2026-11-06)', () => {
  const files = loadSqlFiles();
  const migration = files.find((f) =>
    f.name.includes('2026-11-06-add-live-trade')
  );
  const rawSql = migration?.sql ?? '';
  const sql = stripCommentLines(rawSql);

  test('the Live Trade migration exists', () => {
    expect(migration).toBeDefined();
  });

  test('the migration is additive and idempotent', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|INDEX)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);

    const statements: string[] = splitStatements(rawSql);
    const creates = statements.filter((s) =>
      /^CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX)\b/i.test(s)
    );
    expect(creates.length).toBeGreaterThan(0);
    for (const stmt of creates) {
      expect(stmt).toMatch(/IF\s+NOT\s+EXISTS/i);
    }
  });

  test('group ownership is enforced by a composite unique target and composite FK', () => {
    expect(sql).toMatch(
      /CONSTRAINT\s+live_trade_groups_group_owner_uq\s+UNIQUE\s*\(\s*group_id\s*,\s*owner_user_id\s*\)/i
    );
    expect(sql).toMatch(
      /CONSTRAINT\s+live_trade_items_group_owner_fk\s+FOREIGN\s+KEY\s*\(\s*group_id\s*,\s*owner_user_id\s*\)\s+REFERENCES\s+live_trade_groups\s*\(\s*group_id\s*,\s*owner_user_id\s*\)/i
    );
    // The composite FK intentionally uses NO ACTION; the service ungroups
    // items before deleting a group so owner_user_id is never nulled.
    expect(sql).not.toMatch(
      /live_trade_items_group_owner_fk[\s\S]{0,300}?ON\s+DELETE/i
    );
  });

  test('group_id and timeframe are nullable for ungrouped items and Any timeframe', () => {
    const groupLine = sql
      .split('\n')
      .find((line) => /^\s*group_id\s+UUID/i.test(line));
    const timeframeLine = sql
      .split('\n')
      .find((line) => /^\s*timeframe\s+TEXT/i.test(line));

    expect(groupLine).toBeDefined();
    expect(timeframeLine).toBeDefined();
    expect(groupLine).not.toMatch(/NOT\s+NULL/i);
    expect(timeframeLine).not.toMatch(/NOT\s+NULL/i);
    expect(sql).toMatch(/timeframe\s+IS\s+NULL\s+OR\s+timeframe\s+IN/i);
  });

  test('versioning, notes limit and status enum are present', () => {
    expect(sql).toMatch(
      /live_trade_items_version_pos\s+CHECK\s*\(\s*version\s*>=\s*1\s*\)/i
    );
    expect(sql).toMatch(
      /live_trade_groups_version_pos\s+CHECK\s*\(\s*version\s*>=\s*1\s*\)/i
    );
    expect(sql).toMatch(
      /live_trade_items_notes_len\s+CHECK\s*\(\s*char_length\s*\(\s*notes\s*\)\s*<=\s*2000\s*\)/i
    );
    for (const status of [
      'WATCHING',
      'WAITING_FOR_ENTRY',
      'ACTIVE_TRADE',
      'TARGET_HIT',
      'STOP_LOSS_HIT',
      'CLOSED',
    ]) {
      expect(sql).toContain(status);
    }
  });

  test('quote cooldown state is one row per owner', () => {
    const columns = parseCreatedTables(rawSql).get('live_trade_quote_state');
    expect(columns).toBeDefined();
    expect(columns!.has('owner_user_id')).toBe(true);
    expect(columns!.has('last_request_at')).toBe(true);
    expect(columns!.has('updated_at')).toBe(true);
    expect(sql).toMatch(/owner_user_id\s+TEXT\s+PRIMARY\s+KEY/i);
  });
});

describe('Live Trade repeated-entry migration (2026-11-09)', () => {
  const migration = loadSqlFiles().find((f) =>
    f.name.includes('2026-11-09-live-trade-allow-repeat-instruments')
  );
  const rawSql = migration?.sql ?? '';
  const sql = stripCommentLines(rawSql);

  test('the migration exists and only drops the legacy uniqueness index', () => {
    expect(migration).toBeDefined();
    expect(sql).toMatch(
      /DROP\s+INDEX\s+IF\s+EXISTS\s+live_trade_items_owner_instrument_uq\s*;/i
    );
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+live_trade_items\b/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  test('no trade_date column or date-based uniqueness is introduced', () => {
    expect(sql).not.toMatch(/trade_date/i);
    expect(sql).not.toMatch(/UNIQUE|CONSTRAINT/i);
  });

  test('the retained owner-scoped indexes are not dropped', () => {
    for (const index of [
      'live_trade_items_owner_sort_idx',
      'live_trade_items_owner_group_idx',
      'live_trade_items_instrument_idx',
    ]) {
      expect(sql).not.toContain(index);
    }
  });

  test('the ordered migration set drops the index after creating it', () => {
    const files = loadSqlFiles();
    const createIndexAt = files.findIndex((f) =>
      f.name.includes('2026-11-06-add-live-trade')
    );
    const dropIndexAt = files.findIndex((f) =>
      f.name.includes('2026-11-09-live-trade-allow-repeat-instruments')
    );
    expect(createIndexAt).toBeGreaterThan(-1);
    expect(dropIndexAt).toBeGreaterThan(createIndexAt);

    const all = files.map((f) => stripCommentLines(f.sql)).join('\n');
    const create = all.indexOf(
      'CREATE UNIQUE INDEX IF NOT EXISTS live_trade_items_owner_instrument_uq'
    );
    const drop = all.indexOf(
      'DROP INDEX IF EXISTS live_trade_items_owner_instrument_uq'
    );
    expect(create).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(create);
    expect(all).toMatch(
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+live_trade_items[\s\S]*?item_id\s+UUID\s+PRIMARY\s+KEY/i
    );
  });
});

describe('db/migrate.js statement splitter (db/sql-statements.js)', () => {
  // Root cause of the production `relation "hourly_ingestion_checkpoints" does
  // not exist` failure: the old migrate.js split the whole file on ';' FIRST,
  // then stripped comment lines. Comment text in the v1 migration contains
  // semicolons ("(4 full 60-min candles; is_complete = TRUE)"), which produced
  // garbage statements and crashed the runner mid-file — so every database
  // stopped applying migrations at that point and never reached section H
  // (hourly_ingestion_checkpoints).
  const files = loadSqlFiles();

  test('every .sql file splits into at least one statement', () => {
    for (const { name, sql } of files) {
      expect(splitStatements(sql).length).toBeGreaterThan(0);
    }
  });

  test('no statement is garbage left over from a comment (v1 regression)', () => {
    const v1 = files.find((f) => f.name.includes('v1-intraday-scoring-history'));
    expect(v1).toBeDefined();
    const statements: string[] = splitStatements(v1!.sql);
    // The comment fragments the old splitter produced:
    expect(statements).not.toContain('is_complete = TRUE)');
    expect(statements.some((s) => s.startsWith('is_complete'))).toBe(false);
    // The section that follows the offending comment must survive intact:
    expect(statements.some((s) => /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+four_hour_candles/i.test(s))).toBe(true);
  });

  test('every statement starts with a known SQL keyword', () => {
    const starter = /^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|SELECT|COMMENT|GRANT)\b/i;
    for (const { name, sql } of files) {
      for (const stmt of splitStatements(sql)) {
        expect({ file: name, statement: stmt }).toEqual(
          expect.objectContaining({ statement: expect.stringMatching(starter) })
        );
      }
    }
  });

  test('the v1 migration produces one CREATE TABLE per pipeline table it defines', () => {
    const v1 = files.find((f) => f.name.includes('v1-intraday-scoring-history'));
    const statements: string[] = splitStatements(v1!.sql);
    for (const table of [
      'hourly_candles',
      'four_hour_candles',
      'candle_coverage',
      'backfill_jobs',
      'nifty500_membership',
      'hourly_ingestion_checkpoints',
    ]) {
      const found = statements.some((s) =>
        new RegExp(`^CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, 'i').test(s)
      );
      expect({ table, found }).toEqual({ table, found: true });
    }
  });
});
