/**
 * Regression tests for db/target.js.
 *
 * The DB target reporter must identify which database is configured without
 * ever exposing the username, password, or raw connection string in output.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// db/target.js is CommonJS without a TypeScript declaration file.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { describeTarget, loadDatabaseUrl } = require('../../db/target.js') as {
  describeTarget: (url: string) => {
    host: string;
    port: string;
    database: string;
    sslmode: string;
    isNeon: boolean;
    pooled: boolean;
  };
  loadDatabaseUrl: () => {
    url: string | undefined;
    source: string | null;
    envFile: string;
  };
};

describe('describeTarget', () => {
  test('extracts host/database/sslmode and drops credentials', () => {
    const target = describeTarget(
      'postgresql://alice:super-secret@ep-cool-123-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require'
    );

    expect(target).toEqual({
      host: 'ep-cool-123-pooler.ap-southeast-1.aws.neon.tech',
      port: '(default)',
      database: 'neondb',
      sslmode: 'require',
      isNeon: true,
      pooled: true,
    });

    const serialized = JSON.stringify(target);
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('postgresql://');
  });

  test('handles a non-pooled host with an explicit port', () => {
    const target = describeTarget(
      'postgres://user:pass@db.example.com:5432/demandscan'
    );

    expect(target.host).toBe('db.example.com');
    expect(target.port).toBe('5432');
    expect(target.database).toBe('demandscan');
    expect(target.sslmode).toBe('(not set)');
    expect(target.isNeon).toBe(false);
    expect(target.pooled).toBe(false);
    expect(JSON.stringify(target)).not.toContain('pass');
  });

  test('rejects non-Postgres URLs instead of printing them', () => {
    expect(() => describeTarget('https://example.com/db?token=secret')).toThrow(
      /unsupported protocol/i
    );
  });

  test('rejects malformed URLs', () => {
    expect(() => describeTarget('not a url')).toThrow(/valid URL/i);
  });
});

describe('loadDatabaseUrl', () => {
  const originalUrl = process.env.DATABASE_URL;
  const originalEnvFile = process.env.DB_ENV_FILE;
  let tempDir: string;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-dbtarget-'));
  });

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    if (originalEnvFile === undefined) delete process.env.DB_ENV_FILE;
    else process.env.DB_ENV_FILE = originalEnvFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('loads the file named by DB_ENV_FILE', () => {
    const envFile = path.join(tempDir, '.env.production.local');
    fs.writeFileSync(
      envFile,
      'DATABASE_URL=postgres://user:secret@prod.example.com:5432/proddb?sslmode=require\n'
    );
    process.env.DB_ENV_FILE = envFile;

    const result = loadDatabaseUrl();

    expect(result.url).toContain('prod.example.com');
    expect(result.source).toBe(envFile);
  });

  test('process environment wins over DB_ENV_FILE', () => {
    const envFile = path.join(tempDir, '.env.production.local');
    fs.writeFileSync(envFile, 'DATABASE_URL=postgres://user:secret@file.example.com/db\n');
    process.env.DB_ENV_FILE = envFile;
    process.env.DATABASE_URL = 'postgres://user:secret@inline.example.com/db';

    const result = loadDatabaseUrl();

    expect(result.url).toContain('inline.example.com');
    expect(result.source).toMatch(/process environment/i);
  });
});

describe('db/migrate.js', () => {
  test('uses the shared DB loader so DB_ENV_FILE cannot be silently ignored', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../db/migrate.js'),
      'utf8'
    );

    expect(source).toContain("require('./target')");
    expect(source).toContain('loadDatabaseUrl');
    expect(source).not.toContain("require('dotenv')");
  });
});
