#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node entry point */
/**
 * DemandScan — production migration guard (Live Trade only).
 *
 * Loads a production connection string ONLY from the file named by
 * PRODUCTION_MIGRATE_ENV, which must live outside the repository. There is no
 * fallback to `.env.local`, `DB_ENV_FILE`, or an inherited `DATABASE_URL`: an
 * inherited value is treated as an ambiguity and rejected outright.
 *
 * Required environment variables:
 *   PRODUCTION_MIGRATE_ENV    path to the production env file (outside repo)
 *   EXPECTED_PRODUCTION_HOST  the direct (non-pooled) production Neon hostname
 *
 * Write operations additionally require:
 *   ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION=YES   (exact, case-sensitive)
 *
 * This guard is deliberately NOT the staging guard. The staging guard rejects
 * the production hostname; reusing it here would mean weakening that rejection.
 * Only its credential-free parsing helpers are shared.
 *
 * This module never connects to a database and never prints credentials.
 */

const path = require('path');

const {
  expandHome,
  assertExternalFile,
  readDatabaseUrlValues,
  normalizeHost,
  parseTarget,
} = require('./staging-guard');

const PRODUCTION_ENV_VAR = 'PRODUCTION_MIGRATE_ENV';
const EXPECTED_HOST_VAR = 'EXPECTED_PRODUCTION_HOST';
const APPROVAL_VAR = 'ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION';
const APPROVAL_VALUE = 'YES';

class ProductionGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionGuardError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionGuardError(code, message);
}

function assertApproval() {
  const value = process.env[APPROVAL_VAR];
  if (value !== APPROVAL_VALUE) {
    fail(
      'PRODUCTION_APPROVAL_MISSING',
      `${APPROVAL_VAR}=${APPROVAL_VALUE} is required before any production ` +
        'write. Read-only commands do not need it.'
    );
  }
}

function assertNoInheritedTarget(selectedFile) {
  const inherited = process.env.DATABASE_URL;
  if (typeof inherited === 'string' && inherited.trim() !== '') {
    fail(
      'DATABASE_URL_INHERITED',
      'process.env.DATABASE_URL is set. The production guard never uses an ' +
        'inherited connection string; unset it (for example with ' +
        '`env -u DATABASE_URL`) and retry.'
    );
  }

  if (process.env.DB_ENV_FILE) {
    fail(
      'ENV_FILE_CONFLICT',
      'DB_ENV_FILE is set. The production guard reads only ' +
        `${PRODUCTION_ENV_VAR}.`
    );
  }

  for (const stagingVar of ['STAGING_MIGRATE_ENV', 'STAGING_RUNTIME_ENV']) {
    const stagingFile = process.env[stagingVar];
    if (!stagingFile || stagingFile.trim() === '') continue;
    if (path.resolve(expandHome(stagingFile.trim())) === selectedFile) {
      fail(
        'ENV_FILE_CONFLICT',
        `${stagingVar} points at the production env file. Staging and ` +
          'production must use different files.'
      );
    }
  }
}

function requireExpectedHost() {
  const raw = process.env[EXPECTED_HOST_VAR];
  if (!raw || raw.trim() === '') {
    fail(
      'EXPECTED_HOST_MISSING',
      `${EXPECTED_HOST_VAR} is required (the direct production Neon hostname).`
    );
  }

  const host = normalizeHost(raw);
  if (!host.endsWith('.neon.tech')) {
    fail(
      'EXPECTED_HOST_INVALID',
      `${EXPECTED_HOST_VAR} must be a Neon hostname ending in .neon.tech.`
    );
  }
  if (/-pooler\./.test(host)) {
    fail(
      'EXPECTED_HOST_INVALID',
      `${EXPECTED_HOST_VAR} must be the direct (non-pooled) hostname.`
    );
  }

  const stagingHost = process.env.EXPECTED_STAGING_HOST;
  if (stagingHost && normalizeHost(stagingHost) === host) {
    fail(
      'HOST_CONFUSION',
      `${EXPECTED_HOST_VAR} equals EXPECTED_STAGING_HOST. Refusing to treat a ` +
        'staging host as production.'
    );
  }

  return host;
}

function assertTarget(target, expectedHost) {
  if (!target.isNeon) {
    fail(
      'TARGET_NOT_NEON',
      'The production target must be a Neon database (*.neon.tech).'
    );
  }
  if (target.pooled) {
    fail(
      'TARGET_NOT_DIRECT',
      'Production migration requires the direct (non-pooled) Neon connection.'
    );
  }
  if (target.host !== expectedHost) {
    fail(
      'TARGET_HOST_MISMATCH',
      `Production database host does not match ${EXPECTED_HOST_VAR}.`
    );
  }
}

/**
 * Loads and validates the production environment.
 *
 * @param {{ write?: boolean }} options `write: true` additionally requires the
 *   explicit approval flag. Read-only commands pass `write: false`.
 */
function loadProductionEnvironment(options = {}) {
  const write = options.write === true;
  if (write) assertApproval();

  const rawFile = process.env[PRODUCTION_ENV_VAR];
  if (!rawFile || rawFile.trim() === '') {
    fail(
      'ENV_FILE_NOT_SELECTED',
      `${PRODUCTION_ENV_VAR} must point to a production env file outside the ` +
        'repository. No fallback to .env.local is performed.'
    );
  }

  const resolvedFile = path.resolve(expandHome(rawFile.trim()));
  assertExternalFile(resolvedFile, 'production');
  assertNoInheritedTarget(resolvedFile);

  const expectedHost = requireExpectedHost();
  const values = readDatabaseUrlValues(resolvedFile, 'production');
  const target = parseTarget(values.DATABASE_URL, 'production');
  assertTarget(target, expectedHost);

  return {
    mode: write ? 'migrate' : 'read-only',
    file: resolvedFile,
    values,
    url: values.DATABASE_URL.trim(),
    target,
    expectedHost,
  };
}

/** Sanitized, credential-free target description. */
function formatTarget(env) {
  const target = env.target;
  return [
    'Production target (credentials omitted):',
    `  mode:     ${env.mode}`,
    `  source:   ${path.basename(env.file)} (outside repository)`,
    `  host:     ${target.host}`,
    `  port:     ${target.port}`,
    `  database: ${target.database}`,
    `  sslmode:  ${target.sslmode}`,
    `  neon:     ${target.isNeon ? 'yes' : 'no'}`,
    `  pooled:   ${target.pooled ? 'yes' : 'no'}`,
  ].join('\n');
}

module.exports = {
  ProductionGuardError,
  PRODUCTION_ENV_VAR,
  EXPECTED_HOST_VAR,
  APPROVAL_VAR,
  APPROVAL_VALUE,
  loadProductionEnvironment,
  formatTarget,
};
