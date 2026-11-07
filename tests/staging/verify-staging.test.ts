/**
 * Regression tests for db:staging:verify. Each case is rejected by the staging
 * guard BEFORE the script can open a connection, so no database is contacted.
 */

import { spawnSync, type SpawnSyncReturns } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "db", "verify-staging-schema.js");

const ENV_KEYS = [
  "STAGING_MIGRATE_ENV",
  "STAGING_RUNTIME_ENV",
  "EXPECTED_STAGING_HOST",
  "EXPECTED_STAGING_POOLED_HOST",
  "FORBIDDEN_DATABASE_HOST",
  "DATABASE_URL",
  "DB_ENV_FILE",
  "RUN_STAGING_INTEGRATION",
] as const;

let tempDir: string;

function writeEnvFile(name: string, databaseUrl: string): string {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, `DATABASE_URL=${databaseUrl}\n`, "utf8");
  return file;
}

function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ENV_KEYS) delete env[key];
  return { ...env, ...overrides };
}

function run(env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
}

function combined(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function expectNoSecrets(output: string): void {
  expect(output).not.toMatch(/postgres(?:ql)?:\/\//i);
  expect(output).not.toContain("supersecret");
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "demandscan-verify-"));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("staging schema verification guard", () => {
  it("refuses to run without an explicitly selected staging file", () => {
    const result = run(cleanEnv());
    expect(result.status).toBe(3);
    expect(combined(result)).toContain("STAGING_MIGRATE_ENV");
    expectNoSecrets(combined(result));
  });

  it("refuses an env file inside the repository and never reads it", () => {
    const result = run(
      cleanEnv({ STAGING_MIGRATE_ENV: path.join(REPO_ROOT, "package.json") })
    );
    expect(result.status).toBe(3);
    expect(combined(result)).toContain("outside the repository");
    expectNoSecrets(combined(result));
  });

  it("requires FORBIDDEN_DATABASE_HOST before any connection", () => {
    const file = writeEnvFile(
      "missing-forbidden.env",
      "postgresql://zztest:supersecret@ep-stage-123456.aws.neon.tech/db?sslmode=require"
    );
    const result = run(
      cleanEnv({
        STAGING_MIGRATE_ENV: file,
        EXPECTED_STAGING_HOST: "ep-stage-123456.aws.neon.tech",
      })
    );
    expect(result.status).toBe(3);
    expect(combined(result)).toContain("FORBIDDEN_DATABASE_HOST");
    expectNoSecrets(combined(result));
  });

  it("rejects the forbidden production host", () => {
    const host = "ep-stage-123456.aws.neon.tech";
    const file = writeEnvFile(
      "forbidden.env",
      `postgresql://zztest:supersecret@${host}/db?sslmode=require`
    );
    const result = run(
      cleanEnv({
        STAGING_MIGRATE_ENV: file,
        EXPECTED_STAGING_HOST: host,
        FORBIDDEN_DATABASE_HOST: host,
      })
    );
    expect(result.status).toBe(3);
    expect(combined(result)).toContain("forbidden");
    expectNoSecrets(combined(result));
  });

  it("requires the direct (non-pooled) host for verification", () => {
    const file = writeEnvFile(
      "pooled.env",
      "postgresql://zztest:supersecret@ep-stage-123456-pooler.aws.neon.tech/db?sslmode=require"
    );
    const result = run(
      cleanEnv({
        STAGING_MIGRATE_ENV: file,
        EXPECTED_STAGING_HOST: "ep-stage-123456.aws.neon.tech",
        FORBIDDEN_DATABASE_HOST: "ep-production-999999.aws.neon.tech",
      })
    );
    expect(result.status).toBe(3);
    expect(combined(result)).toContain("direct");
    expectNoSecrets(combined(result));
  });
});
