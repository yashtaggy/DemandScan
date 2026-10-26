#!/usr/bin/env node
/**
 * DemandScan — sanitized database target reporting.
 *
 * Prints the HOST, DATABASE, and sslmode of the DATABASE_URL the app would
 * use, but NEVER prints the username, password, or raw connection string.
 *
 * Usage:
 *   npm run db:target
 *   DB_ENV_FILE=.env.production.local npm run db:target
 *   DATABASE_URL="postgres://..." node db/target.js
 *
 * This only identifies the configured target. It does not connect, and it is
 * not proof that Vercel production uses the same database. For a read-only
 * schema check against the configured target, run `npm run db:verify`.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const PROJECT_ROOT = path.join(__dirname, '..');

function resolveEnvFile() {
  const explicit = process.env.DB_ENV_FILE;
  if (explicit) return path.resolve(explicit);
  return path.join(PROJECT_ROOT, '.env.local');
}

/**
 * Load DATABASE_URL the same way the app does: an explicit process env value
 * wins, otherwise `.env.local` (or DB_ENV_FILE) is loaded.
 */
function loadDatabaseUrl() {
  const envFile = resolveEnvFile();
  const hadEnv =
    typeof process.env.DATABASE_URL === 'string' &&
    process.env.DATABASE_URL.trim() !== '';

  let source = hadEnv ? 'process environment (overrides env file)' : null;
  if (!hadEnv && fs.existsSync(envFile)) {
    const result = dotenv.config({ path: envFile, quiet: true });
    if (!result.error && result.parsed && result.parsed.DATABASE_URL) {
      source = envFile;
    }
  }

  return {
    url: process.env.DATABASE_URL,
    source,
    envFile,
  };
}

/**
 * Parse a Postgres URL into a credential-free description.
 * Throws for an invalid or non-Postgres URL.
 */
function describeTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL has unsupported protocol "${url.protocol}"`);
  }

  return {
    host: url.hostname || '(none)',
    port: url.port || '(default)',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || '(none)',
    sslmode: url.searchParams.get('sslmode') || '(not set)',
    isNeon: /\.neon\.tech$/i.test(url.hostname),
    pooled: /-pooler\./i.test(url.hostname),
  };
}

function main() {
  const { url, source, envFile } = loadDatabaseUrl();
  if (!url || url.trim() === '') {
    console.error(
      'ERROR: DATABASE_URL is not set.\n' +
        'Add it to .env.local (local), set it in the Vercel project, or pass it inline:\n' +
        '  DATABASE_URL="postgres://..." node db/target.js'
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

  console.log('Database target (credentials omitted):');
  console.log(`  source:    ${source ?? 'unknown'}`);
  console.log(`  host:      ${target.host}`);
  console.log(`  port:      ${target.port}`);
  console.log(`  database:  ${target.database}`);
  console.log(`  sslmode:   ${target.sslmode}`);
  console.log(`  neon:      ${target.isNeon ? 'yes' : 'no'}`);
  console.log(`  pooled:    ${target.pooled ? 'yes' : 'no'}`);
  if (source === envFile) {
    console.log(`  env file:  ${path.relative(process.cwd(), envFile) || envFile}`);
  }
  console.log(
    '\nThis identifies only the configured target. It does not connect and does\n' +
      'not prove the schema exists. Run `npm run db:verify` for a read-only\n' +
      'schema check against this target.'
  );
}

if (require.main === module) {
  main();
}

module.exports = { loadDatabaseUrl, describeTarget };
