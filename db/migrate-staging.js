#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node entry point */
/**
 * DemandScan — guarded staging migration.
 *
 * Validates the staging target, runs the read-only preflight, and only then
 * delegates to the unmodified db/migrate.js runner with the validated
 * DATABASE_URL injected for the child process.
 *
 * Production migration behavior is intentionally unchanged: this wrapper is
 * the only staging-specific entry point.
 *
 * Required environment:
 *   STAGING_MIGRATE_ENV, EXPECTED_STAGING_HOST, FORBIDDEN_DATABASE_HOST
 *
 * Usage:
 *   STAGING_MIGRATE_ENV="$HOME/.config/demandscan/staging-migrate.env" \
 *   EXPECTED_STAGING_HOST="ep-....aws.neon.tech" \
 *   FORBIDDEN_DATABASE_HOST="<production-host>" \
 *   npm run db:staging:migrate
 */

const path = require('path');
const { spawnSync } = require('child_process');

const {
  loadStagingEnvironment,
  formatTarget,
  StagingGuardError,
} = require('./staging-guard');
const { runPreflight, formatPreflight, sanitizeError } = require('./preflight-staging');

async function main() {
  const env = loadStagingEnvironment({ mode: 'migrate' });
  console.log(formatTarget(env));
  console.log('');

  const { neon } = require('@neondatabase/serverless');
  const sql = neon(env.url);

  const result = await runPreflight(sql);
  console.log(formatPreflight(result));

  if (!result.ready) {
    console.error(
      '\nStaging migration refused: preflight did not pass. Nothing was applied.'
    );
    process.exit(2);
  }

  console.log(
    '\nPreflight passed. Delegating to the existing migration runner (unmodified).\n'
  );

  const childEnv = { ...process.env, DATABASE_URL: env.url };
  delete childEnv.DB_ENV_FILE;
  delete childEnv.STAGING_RUNTIME_ENV;

  const child = spawnSync(process.execPath, [path.join(__dirname, 'migrate.js')], {
    env: childEnv,
    stdio: 'inherit',
  });

  if (child.error) {
    console.error(`Staging migration failed to start: ${child.error.message}`);
    process.exit(1);
  }

  process.exit(child.status === null ? 1 : child.status);
}

main().catch((error) => {
  if (error instanceof StagingGuardError) {
    console.error(`Staging guard: ${error.message}`);
    process.exit(3);
  }
  console.error(`Staging migration failed: ${sanitizeError(error)}`);
  process.exit(1);
});
