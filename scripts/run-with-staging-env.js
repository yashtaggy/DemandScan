#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node entry point */
/**
 * Runs a Next.js command with the guarded staging runtime environment.
 *
 * Usage:
 *   STAGING_RUNTIME_ENV="$HOME/.config/demandscan/staging-runtime.env" \
 *   EXPECTED_STAGING_HOST="ep-....aws.neon.tech" \
 *   FORBIDDEN_DATABASE_HOST="<production-host>" \
 *   node scripts/run-with-staging-env.js dev
 *
 * The guard validates the pooled staging target before anything starts. The
 * connection string is passed only through the child process environment and is
 * never printed.
 */

const { spawn } = require('child_process');

const {
  loadStagingEnvironment,
  formatTarget,
  StagingGuardError,
} = require('../db/staging-guard');

function main() {
  const command = process.argv[2];
  if (command !== 'dev' && command !== 'start') {
    console.error('Usage: node scripts/run-with-staging-env.js <dev|start>');
    process.exit(2);
  }

  let env;
  try {
    env = loadStagingEnvironment({ mode: 'runtime' });
  } catch (error) {
    if (error instanceof StagingGuardError) {
      console.error(`Staging guard: ${error.message}`);
      process.exit(3);
    }
    throw error;
  }

  console.log(formatTarget(env));

  const childEnv = {
    ...process.env,
    ...env.values,
    DATABASE_URL: env.url,
    KITE_TOKEN_ENCRYPTION_KEY: env.encryptionKey,
  };
  delete childEnv.DB_ENV_FILE;

  let nextBin;
  try {
    nextBin = require.resolve('next/dist/bin/next');
  } catch {
    console.error('Cannot locate the Next.js CLI. Run `npm install` first.');
    process.exit(1);
  }

  const child = spawn(process.execPath, [nextBin, command], {
    env: childEnv,
    stdio: 'inherit',
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

main();
