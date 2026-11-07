#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node entry point */
/**
 * DemandScan — guarded production application of ONE migration file:
 *
 *   db/migrations/2026-11-06-add-live-trade.sql
 *
 * This command never runs db/schema.sql, never enumerates db/migrations, and
 * never delegates to db/migrate.js. The single file path is a constant.
 *
 * Safety sequence:
 *   1. Production guard with ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION=YES.
 *   2. Read-only preflight (prerequisites, partial/incompatible detection).
 *   3. A second guard evaluation immediately before the first write, asserting
 *      the host is unchanged.
 *   4. Statement-by-statement application, stopping at the first error.
 *
 * Statements run in autocommit, exactly like the existing runner, so a failure
 * can leave earlier statements committed. This command never claims a rollback.
 *
 * Exit codes:
 *   0  applied, or already applied (nothing written)
 *   1  a statement failed, or an unexpected error occurred
 *   2  preflight refused (partial, incompatible, or missing prerequisites)
 *   3  production guard rejected the environment or target
 */

const fs = require('fs');
const path = require('path');

const { splitStatements } = require('./sql-statements');
const { runPreflight, formatPreflight, sanitizeError } = require('./preflight-staging');
const { decideAction } = require('./preflight-production');
const {
  loadProductionEnvironment,
  formatTarget,
  ProductionGuardError,
} = require('./production-guard');

const LIVE_TRADE_MIGRATION_FILE = '2026-11-06-add-live-trade.sql';
const LIVE_TRADE_MIGRATION_PATH = path.join(
  __dirname,
  'migrations',
  LIVE_TRADE_MIGRATION_FILE
);

/**
 * Reads and splits ONLY the Live Trade migration. Exported so tests can prove
 * the selection without touching a database.
 */
function readMigrationStatements() {
  if (path.basename(LIVE_TRADE_MIGRATION_PATH) !== LIVE_TRADE_MIGRATION_FILE) {
    throw new Error('Migration selection is not the Live Trade file.');
  }
  if (!fs.existsSync(LIVE_TRADE_MIGRATION_PATH)) {
    throw new Error(
      `Migration file not found: db/migrations/${LIVE_TRADE_MIGRATION_FILE}`
    );
  }
  return splitStatements(fs.readFileSync(LIVE_TRADE_MIGRATION_PATH, 'utf8'));
}

async function main() {
  const env = loadProductionEnvironment({ write: true });

  console.log(formatTarget(env));
  console.log('');

  const { neon } = require('@neondatabase/serverless');
  const sql = neon(env.url);

  console.log('Read-only preflight …');
  const result = await runPreflight(sql);
  console.log(formatPreflight(result));

  const decision = decideAction(result.status);
  console.log(`\n${decision.message}`);

  if (!decision.write) {
    process.exit(decision.exitCode);
  }

  // Re-check the target immediately before the first write. A changed shell,
  // a rotated env file or an edited expected host must abort here.
  const finalEnv = loadProductionEnvironment({ write: true });
  if (
    finalEnv.target.host !== env.target.host ||
    finalEnv.url !== env.url
  ) {
    console.error(
      '\nProduction target changed between preflight and execution. ' +
        'Nothing was written.'
    );
    process.exit(3);
  }

  const statements = readMigrationStatements();
  console.log(
    `\nApplying ${statements.length} statement(s) from ` +
      `db/migrations/${LIVE_TRADE_MIGRATION_FILE} …`
  );

  for (let index = 0; index < statements.length; index += 1) {
    try {
      await sql.query(statements[index], []);
    } catch (error) {
      console.error(
        `\nFAILED at statement ${index + 1} of ${statements.length} in ` +
          `db/migrations/${LIVE_TRADE_MIGRATION_FILE}`
      );
      console.error(`Reason: ${sanitizeError(error)}`);
      console.error(
        'Statements are applied in autocommit mode. Earlier statements may ' +
          'already be committed; no rollback is claimed.'
      );
      console.error(
        'Re-run the read-only preflight to inspect the resulting state before ' +
          'taking any further action.'
      );
      process.exit(1);
    }
  }

  console.log(
    '\nLive Trade migration applied. Verify with:\n' +
      '  npm run db:production:live-trade:verify'
  );
}

if (require.main === module) {
  main().catch((error) => {
    if (error instanceof ProductionGuardError) {
      console.error(`Production guard: ${error.message}`);
      process.exit(3);
    }
    console.error(`Production migration failed: ${sanitizeError(error)}`);
    process.exit(1);
  });
}

module.exports = {
  LIVE_TRADE_MIGRATION_FILE,
  LIVE_TRADE_MIGRATION_PATH,
  readMigrationStatements,
};
