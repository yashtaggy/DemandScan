#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node entry point */
/**
 * DemandScan — staging environment guard.
 *
 * Loads a staging connection string ONLY from an explicitly selected file that
 * lives OUTSIDE the repository. It never reads `.env.local`, never falls back
 * silently, and never prints credentials.
 *
 * Two distinct files are supported:
 *   STAGING_MIGRATE_ENV   direct (non-pooled) Neon URL, for migrations/preflight
 *   STAGING_RUNTIME_ENV   pooled Neon URL, for the app and integration tests
 *
 * Both files contain a single `DATABASE_URL=postgresql://...` entry.
 *
 * Required environment variables:
 *   EXPECTED_STAGING_HOST   the project's direct Neon hostname, e.g.
 *                           ep-cool-name-123456.region.aws.neon.tech
 *   FORBIDDEN_DATABASE_HOST one or more comma-separated production hostnames
 *
 * Integration mode additionally requires RUN_STAGING_INTEGRATION=1 and a
 * valid KITE_TOKEN_ENCRYPTION_KEY (64 hex characters) in the runtime file.
 *
 * This module never connects to a database. It only parses and validates.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

const REPO_ROOT = path.resolve(__dirname, '..');

const MODE_ENV_VARS = {
  migrate: 'STAGING_MIGRATE_ENV',
  runtime: 'STAGING_RUNTIME_ENV',
};

class StagingGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StagingGuardError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingGuardError(code, message);
}

function expandHome(raw) {
  if (raw === '~') return os.homedir();
  if (raw.startsWith(`~${path.sep}`) || raw.startsWith('~/')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

function normalizeHost(value) {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function isInsideRepo(resolved) {
  const relative = path.relative(REPO_ROOT, resolved);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function assertExternalFile(resolved, label = 'staging') {
  const noun = label.charAt(0).toUpperCase() + label.slice(1);

  if (!fs.existsSync(resolved)) {
    fail('ENV_FILE_MISSING', `${noun} environment file not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    fail('ENV_FILE_INVALID', `${noun} environment path is not a file: ${resolved}`);
  }

  if (isInsideRepo(resolved)) {
    fail(
      'ENV_FILE_INSIDE_REPO',
      `${noun} environment files must live outside the repository. ` +
        `Refusing to use: ${resolved}`
    );
  }
}

/**
 * Reads a dotenv file without mutating process.env. Detects duplicate
 * DATABASE_URL entries, which would make the effective target ambiguous.
 *
 * `label` only appears in the failure message ("staging", "production").
 * Shared by the staging and production guards.
 */
function readDatabaseUrlValues(resolved, label) {
  const text = fs.readFileSync(resolved, 'utf8');
  const databaseUrlLines = text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:export\s+)?DATABASE_URL\s*=/.test(line));

  if (databaseUrlLines.length === 0) {
    fail(
      'DATABASE_URL_MISSING',
      `The ${label} environment file does not define DATABASE_URL.`
    );
  }
  if (databaseUrlLines.length > 1) {
    fail(
      'DATABASE_URL_AMBIGUOUS',
      `The ${label} environment file defines DATABASE_URL more than once.`
    );
  }

  const values = dotenv.parse(text);
  if (typeof values.DATABASE_URL !== 'string' || values.DATABASE_URL.trim() === '') {
    fail('DATABASE_URL_MISSING', `The ${label} DATABASE_URL is empty.`);
  }

  return values;
}

function parseTarget(rawUrl, label = 'staging') {
  const noun = label.charAt(0).toUpperCase() + label.slice(1);
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    fail('DATABASE_URL_INVALID', `${noun} DATABASE_URL is not a valid URL.`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail(
      'DATABASE_URL_INVALID',
      `${noun} DATABASE_URL has unsupported protocol "${url.protocol}"`
    );
  }

  const host = normalizeHost(url.hostname || '');
  if (host === '') {
    fail('DATABASE_URL_INVALID', `${noun} DATABASE_URL has no hostname.`);
  }

  return {
    host,
    port: url.port || '(default)',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || '(none)',
    sslmode: url.searchParams.get('sslmode') || '(not set)',
    isNeon: /\.neon\.tech$/.test(host),
    pooled: /-pooler\./.test(host),
  };
}

/**
 * Derives the direct/pooled hostname pair for a Neon endpoint.
 * Returns null for pooled forms that cannot be normalised.
 */
function hostVariants(expectedHost) {
  const host = normalizeHost(expectedHost);
  if (/-pooler\./.test(host)) {
    return { direct: host.replace(/-pooler\./, '.'), pooled: host };
  }
  const match = /^(ep-[^.]+)(\..+)$/.exec(host);
  return { direct: host, pooled: match ? `${match[1]}-pooler${match[2]}` : null };
}

function parseForbiddenHosts() {
  const raw = process.env.FORBIDDEN_DATABASE_HOST;
  if (!raw || raw.trim() === '') {
    fail(
      'FORBIDDEN_HOST_MISSING',
      'FORBIDDEN_DATABASE_HOST is required. Set it to the production ' +
        'database hostname so a staging run can never target production.'
    );
  }
  return raw
    .split(',')
    .map(normalizeHost)
    .filter((host) => host !== '');
}

function requireExpectedHost() {
  const raw = process.env.EXPECTED_STAGING_HOST;
  if (!raw || raw.trim() === '') {
    fail(
      'EXPECTED_HOST_MISSING',
      'EXPECTED_STAGING_HOST is required (the staging project hostname).'
    );
  }
  const host = normalizeHost(raw);
  if (!host.endsWith('.neon.tech')) {
    fail(
      'EXPECTED_HOST_INVALID',
      'EXPECTED_STAGING_HOST must be a Neon hostname ending in .neon.tech.'
    );
  }
  return host;
}

function assertTarget(mode, target) {
  const expectedHost = requireExpectedHost();
  const variants = hostVariants(expectedHost);
  const forbidden = parseForbiddenHosts();

  if (forbidden.includes(target.host)) {
    fail(
      'FORBIDDEN_HOST',
      'Refusing to use the configured forbidden (production) hostname.'
    );
  }

  for (const value of [variants.direct, variants.pooled]) {
    if (value && forbidden.includes(value)) {
      fail(
        'FORBIDDEN_HOST',
        'EXPECTED_STAGING_HOST resolves to a forbidden (production) hostname.'
      );
    }
  }

  if (!target.isNeon) {
    fail(
      'TARGET_NOT_NEON',
      'Staging target must be a Neon database (*.neon.tech).'
    );
  }

  if (mode === 'migrate') {
    if (target.pooled) {
      fail(
        'TARGET_NOT_DIRECT',
        'Migration requires the direct (non-pooled) Neon connection.'
      );
    }
    if (target.host !== variants.direct) {
      fail(
        'TARGET_HOST_MISMATCH',
        'Staging database host does not match EXPECTED_STAGING_HOST.'
      );
    }
    return;
  }

  const expectedPooled =
    (process.env.EXPECTED_STAGING_POOLED_HOST &&
      normalizeHost(process.env.EXPECTED_STAGING_POOLED_HOST)) ||
    variants.pooled;

  if (!expectedPooled) {
    fail(
      'EXPECTED_HOST_INVALID',
      'Cannot derive the pooled staging hostname. Set EXPECTED_STAGING_POOLED_HOST.'
    );
  }

  if (!target.pooled) {
    fail(
      'TARGET_NOT_POOLED',
      'Runtime and integration tests require the pooled Neon connection.'
    );
  }

  if (target.host !== expectedPooled) {
    fail(
      'TARGET_HOST_MISMATCH',
      'Runtime database host does not match the expected pooled staging host.'
    );
  }
}

function assertNotAmbiguous(values, selectedFile) {
  const fromProcess = process.env.DATABASE_URL;
  if (typeof fromProcess === 'string' && fromProcess.trim() !== '') {
    if (fromProcess.trim() !== values.DATABASE_URL.trim()) {
      fail(
        'DATABASE_URL_AMBIGUOUS',
        'process.env.DATABASE_URL conflicts with the staging file. ' +
          'Unset it (for example with `env -u DATABASE_URL`) and retry.'
      );
    }
  }

  const migrateFile = process.env.STAGING_MIGRATE_ENV;
  const runtimeFile = process.env.STAGING_RUNTIME_ENV;
  if (migrateFile && runtimeFile) {
    const migratePath = path.resolve(expandHome(migrateFile.trim()));
    const runtimePath = path.resolve(expandHome(runtimeFile.trim()));
    if (migratePath === runtimePath) {
      fail(
        'ENV_FILES_NOT_DISTINCT',
        'STAGING_MIGRATE_ENV and STAGING_RUNTIME_ENV must select different files.'
      );
    }
  }

  const otherMode =
    path.basename(selectedFile) === '.env.local' ||
    path.basename(selectedFile) === '.env.production.local';
  if (otherMode) {
    fail(
      'ENV_FILE_INSIDE_REPO',
      'Refusing to use a local/production env file as a staging source.'
    );
  }
}

function assertEncryptionKey(values) {
  const key = values.KITE_TOKEN_ENCRYPTION_KEY;
  if (typeof key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key.trim())) {
    fail(
      'ENCRYPTION_KEY_INVALID',
      'Staging runtime file must define KITE_TOKEN_ENCRYPTION_KEY as 64 hex characters.'
    );
  }
  return key.trim();
}

/**
 * Loads and validates a staging environment.
 *
 * @param {{ mode: 'migrate'|'runtime', integration?: boolean }} options
 */
function loadStagingEnvironment(options) {
  const mode = options && options.mode;
  if (mode !== 'migrate' && mode !== 'runtime') {
    fail('MODE_INVALID', 'Staging guard mode must be "migrate" or "runtime".');
  }

  if (options.integration && process.env.RUN_STAGING_INTEGRATION !== '1') {
    fail(
      'INTEGRATION_NOT_ENABLED',
      'Integration tests require RUN_STAGING_INTEGRATION=1.'
    );
  }

  const varName = MODE_ENV_VARS[mode];
  const rawFile = process.env[varName];
  if (!rawFile || rawFile.trim() === '') {
    fail(
      'ENV_FILE_NOT_SELECTED',
      `${varName} must point to a staging env file outside the repository. ` +
        'No fallback to .env.local is performed.'
    );
  }

  const resolvedFile = path.resolve(expandHome(rawFile.trim()));
  assertExternalFile(resolvedFile);

  const values = readDatabaseUrlValues(resolvedFile, 'staging');
  assertNotAmbiguous(values, resolvedFile);

  const target = parseTarget(values.DATABASE_URL);
  assertTarget(mode, target);

  let encryptionKey = null;
  if (mode === 'runtime') {
    encryptionKey = assertEncryptionKey(values);
  }

  return {
    mode,
    file: resolvedFile,
    values,
    url: values.DATABASE_URL.trim(),
    target,
    encryptionKey,
  };
}

/** Sanitized, credential-free target description. */
function formatTarget(env) {
  const target = env.target;
  return [
    `Staging target (credentials omitted):`,
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
  StagingGuardError,
  REPO_ROOT,
  loadStagingEnvironment,
  formatTarget,
  normalizeHost,
  hostVariants,
  parseTarget,
  // Shared low-level helpers reused by db/production-guard.js so the
  // external-file and DATABASE_URL parsing rules cannot drift apart.
  expandHome,
  assertExternalFile,
  readDatabaseUrlValues,
};
