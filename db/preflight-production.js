#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node entry point */
/**
 * DemandScan — read-only production Live Trade preflight.
 *
 * Uses the production guard (direct host, expected host, no inherited
 * DATABASE_URL) and the same catalog evaluation as the staging preflight. It
 * writes nothing.
 *
 * Exit codes:
 *   0  READY_FRESH (migration can be applied) or READY_MIGRATED (already applied)
 *   1  connection or unexpected failure
 *   2  blocked: prerequisites missing, partial tables, or incompatible objects
 *   3  production guard rejected the environment or target
 */

const {
  LIVE_TRADE_TABLES,
  runPreflight,
  formatPreflight,
  sanitizeError,
} = require('./preflight-staging');
const {
  loadProductionEnvironment,
  formatTarget,
  ProductionGuardError,
} = require('./production-guard');

/** True only when every Live Trade table, column, index, constraint and type matches. */
function isLiveTradeComplete(result) {
  const liveTrade = result.liveTrade;
  return (
    liveTrade.present.length === LIVE_TRADE_TABLES.length &&
    liveTrade.missing.length === 0 &&
    liveTrade.missingColumns.length === 0 &&
    liveTrade.missingIndexes.length === 0 &&
    liveTrade.missingConstraints.length === 0 &&
    liveTrade.typeMismatches.length === 0
  );
}

/**
 * Maps a preflight status to the production write decision.
 *
 * Only a clean, fresh schema is writable. A complete schema means the migration
 * was already applied, so the command reports it and writes nothing. Every
 * blocked state refuses.
 */
function decideAction(status) {
  if (status === 'READY_FRESH') {
    return {
      write: true,
      exitCode: 0,
      reason: 'APPLY',
      message:
        'Prerequisites are present and no Live Trade table exists. ' +
        'The migration may be applied.',
    };
  }
  if (status === 'READY_MIGRATED') {
    return {
      write: false,
      exitCode: 0,
      reason: 'ALREADY_APPLIED',
      message:
        'All Live Trade tables, columns, indexes and constraints already ' +
        'exist. The migration may already have been applied; nothing will be ' +
        'written.',
    };
  }
  return {
    write: false,
    exitCode: 2,
    reason: status,
    message:
      'Refusing to write: the schema is not a clean fresh state and not a ' +
      'complete Live Trade state. Resolve the reported objects first.',
  };
}

async function main() {
  const env = loadProductionEnvironment({ write: false });

  console.log(formatTarget(env));
  console.log('');

  const { neon } = require('@neondatabase/serverless');
  const sql = neon(env.url);

  const result = await runPreflight(sql);
  console.log(formatPreflight(result));

  const decision = decideAction(result.status);
  console.log(`\n${decision.message}`);
  process.exit(decision.exitCode);
}

if (require.main === module) {
  main().catch((error) => {
    if (error instanceof ProductionGuardError) {
      console.error(`Production guard: ${error.message}`);
      process.exit(3);
    }
    console.error(`Production preflight failed: ${sanitizeError(error)}`);
    process.exit(1);
  });
}

module.exports = { isLiveTradeComplete, decideAction };
