#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node entry point */
/**
 * DemandScan — read-only production Live Trade verification.
 *
 * Uses the same production target guard as the preflight and migration
 * commands, then reports the three Live Trade tables with their columns,
 * indexes, foreign keys, unique constraints, check constraints and key column
 * types. Nothing is written; no approval flag is required.
 *
 * Exit codes:
 *   0  every Live Trade object is present and compatible
 *   1  missing/incompatible objects, or a connection failure
 *   3  production guard rejected the environment or target
 */

const {
  LIVE_TRADE_TABLES,
  formatPreflight,
  runPreflight,
  sanitizeError,
} = require('./preflight-staging');
const { isLiveTradeComplete } = require('./preflight-production');
const {
  loadProductionEnvironment,
  formatTarget,
  ProductionGuardError,
} = require('./production-guard');

async function main() {
  const env = loadProductionEnvironment({ write: false });

  console.log(formatTarget(env));
  console.log('');

  const { neon } = require('@neondatabase/serverless');
  const sql = neon(env.url);

  const result = await runPreflight(sql);
  console.log(formatPreflight(result));

  if (!isLiveTradeComplete(result)) {
    console.error(
      `\nLive Trade verification failed: expected ${LIVE_TRADE_TABLES.length} ` +
        'complete tables. See the MISSING/TYPE MISMATCH lines above.'
    );
    process.exit(1);
  }

  console.log(
    `\nLive Trade verification passed: ${LIVE_TRADE_TABLES.join(', ')} ` +
      'columns, indexes, foreign keys, unique and check constraints present.'
  );
}

if (require.main === module) {
  main().catch((error) => {
    if (error instanceof ProductionGuardError) {
      console.error(`Production guard: ${error.message}`);
      process.exit(3);
    }
    console.error(`Live Trade verification failed: ${sanitizeError(error)}`);
    process.exit(1);
  });
}
