#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node entry point */
/**
 * DemandScan — guarded, read-only staging schema verification.
 *
 * Reuses the same strict environment guard as staging preflight and migration:
 * it loads only STAGING_MIGRATE_ENV (a file outside the repository), requires
 * the direct Neon host to equal EXPECTED_STAGING_HOST, rejects the forbidden
 * production host, refuses an inherited conflicting DATABASE_URL, and never
 * falls back to .env.local or DB_ENV_FILE.
 *
 * The check itself is the same information_schema query used by db:verify.
 * Nothing is written; no migration is applied.
 *
 * Exit codes:
 *   0  every expected table/column is present
 *   1  missing objects or a connection/query failure
 *   3  staging guard rejected the environment or target
 */

const {
  loadStagingEnvironment,
  formatTarget,
  StagingGuardError,
} = require('./staging-guard');
const { verifySchema } = require('./verify-schema');
const { sanitizeError } = require('./preflight-staging');

async function main() {
  const env = loadStagingEnvironment({ mode: 'migrate' });

  console.log(formatTarget(env));
  console.log('');

  const missingCount = await verifySchema(env.url);

  if (missingCount > 0) {
    console.error(
      `\n${missingCount} schema object(s) missing on staging.\n` +
        'Do not deploy against this database. Apply the approved staging ' +
        'migration (db:staging:migrate) and re-run this check.'
    );
    process.exit(1);
  }

  console.log('\nStaging schema verification passed.');
}

main().catch((error) => {
  if (error instanceof StagingGuardError) {
    console.error(`Staging guard: ${error.message}`);
    process.exit(3);
  }
  console.error(`Staging schema verification failed: ${sanitizeError(error)}`);
  process.exit(1);
});
