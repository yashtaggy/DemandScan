/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Jest setup file */
/**
 * Staging integration test bootstrap.
 *
 * Runs before any test module is loaded, so lib/db.ts caches the staging
 * client. The guard requires RUN_STAGING_INTEGRATION=1, an explicit runtime
 * env file outside the repository, EXPECTED_STAGING_HOST and
 * FORBIDDEN_DATABASE_HOST.
 *
 * Nothing secret is printed.
 */

const { randomUUID } = require('crypto');
const {
  loadStagingEnvironment,
  formatTarget,
} = require('../../db/staging-guard');

let env;
try {
  env = loadStagingEnvironment({ mode: 'runtime', integration: true });
} catch (error) {
  const message =
    error && typeof error.message === 'string' ? error.message : String(error);
  console.error(`\nStaging integration preflight failed:\n${message}\n`);
  throw error;
}

for (const [key, value] of Object.entries(env.values)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

process.env.DATABASE_URL = env.url;
process.env.KITE_TOKEN_ENCRYPTION_KEY = env.encryptionKey;

// Always mint a fresh run id. Reusing an inherited value would let a crashed
// or concurrent run share the same synthetic owners and instrument ids.
process.env.STAGING_TEST_RUN_ID = randomUUID();

if (!process.env.NEXT_PUBLIC_APP_URL) {
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
}

console.log(formatTarget(env));
console.log(`  run id:   ${process.env.STAGING_TEST_RUN_ID}`);
