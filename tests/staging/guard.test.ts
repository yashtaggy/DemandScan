/**
 * Unit tests for the staging guard. These do NOT connect to a database.
 */

import fs from "fs";
import os from "os";
import path from "path";
import * as guard from "../../db/staging-guard";

const ENV_KEYS = [
  "STAGING_MIGRATE_ENV",
  "STAGING_RUNTIME_ENV",
  "EXPECTED_STAGING_HOST",
  "EXPECTED_STAGING_POOLED_HOST",
  "FORBIDDEN_DATABASE_HOST",
  "DATABASE_URL",
  "RUN_STAGING_INTEGRATION",
] as const;

const DIRECT_HOST = "ep-test-123456.aws.neon.tech";
const POOLED_HOST = "ep-test-123456-pooler.aws.neon.tech";
const PRODUCTION_HOST = "ep-production-999999.aws.neon.tech";

let tempDir: string;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function writeEnv(
  name: string,
  databaseUrl: string,
  extra: Record<string, string> = {}
): string {
  const file = path.join(tempDir, name);
  const lines = [`DATABASE_URL=${databaseUrl}`];
  for (const [key, value] of Object.entries(extra)) {
    lines.push(`${key}=${value}`);
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

function directUrl(host = DIRECT_HOST): string {
  return `postgresql://zztest:supersecret@${host}/demandscan_staging?sslmode=require`;
}

function pooledUrl(host = POOLED_HOST): string {
  return `postgresql://zztest:supersecret@${host}/demandscan_staging?sslmode=require`;
}

function setBaseEnv(overrides: Record<string, string> = {}): void {
  process.env.EXPECTED_STAGING_HOST = DIRECT_HOST;
  process.env.FORBIDDEN_DATABASE_HOST = PRODUCTION_HOST;
  Object.assign(process.env, overrides);
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "demandscan-staging-"));
});

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("staging guard", () => {
  it("refuses to run without an explicitly selected migrate file", () => {
    setBaseEnv();
    expect(() => guard.loadStagingEnvironment({ mode: "migrate" })).toThrow(
      expect.objectContaining({ code: "ENV_FILE_NOT_SELECTED" })
    );
  });

  it("refuses an environment file inside the repository", () => {
    setBaseEnv();
    process.env.STAGING_MIGRATE_ENV = path.join(
      process.cwd(),
      "db",
      "staging-guard.js"
    );
    expect(() => guard.loadStagingEnvironment({ mode: "migrate" })).toThrow(
      expect.objectContaining({ code: "ENV_FILE_INSIDE_REPO" })
    );
  });

  it("accepts a direct staging URL for migrations", () => {
    setBaseEnv();
    process.env.STAGING_MIGRATE_ENV = writeEnv("staging-migrate.env", directUrl());

    const env = guard.loadStagingEnvironment({ mode: "migrate" });
    expect(env.target.host).toBe(DIRECT_HOST);
    expect(env.target.pooled).toBe(false);
    expect(env.url).toContain(DIRECT_HOST);

    const printed = guard.formatTarget(env);
    expect(printed).not.toContain("supersecret");
    expect(printed).not.toContain("zztest:");
    expect(printed).toContain(DIRECT_HOST);
  });

  it("refuses a pooled URL for migrations", () => {
    setBaseEnv();
    process.env.STAGING_MIGRATE_ENV = writeEnv(
      "staging-migrate-pooled.env",
      pooledUrl()
    );
    expect(() => guard.loadStagingEnvironment({ mode: "migrate" })).toThrow(
      expect.objectContaining({ code: "TARGET_NOT_DIRECT" })
    );
  });

  it("requires a pooled URL for runtime and accepts the derived pooler host", () => {
    setBaseEnv();
    process.env.STAGING_RUNTIME_ENV = writeEnv(
      "staging-runtime.env",
      directUrl(),
      { KITE_TOKEN_ENCRYPTION_KEY: "a".repeat(64) }
    );
    expect(() => guard.loadStagingEnvironment({ mode: "runtime" })).toThrow(
      expect.objectContaining({ code: "TARGET_NOT_POOLED" })
    );

    process.env.STAGING_RUNTIME_ENV = writeEnv(
      "staging-runtime-pooled.env",
      pooledUrl(),
      { KITE_TOKEN_ENCRYPTION_KEY: "a".repeat(64) }
    );
    const env = guard.loadStagingEnvironment({ mode: "runtime" });
    expect(env.target.host).toBe(POOLED_HOST);
    expect(env.target.pooled).toBe(true);
  });

  it("rejects the configured production hostname", () => {
    setBaseEnv();
    process.env.STAGING_MIGRATE_ENV = writeEnv(
      "staging-migrate-production.env",
      directUrl(PRODUCTION_HOST)
    );
    expect(() => guard.loadStagingEnvironment({ mode: "migrate" })).toThrow(
      expect.objectContaining({ code: "FORBIDDEN_HOST" })
    );
  });

  it("rejects a host that does not match EXPECTED_STAGING_HOST", () => {
    setBaseEnv();
    process.env.STAGING_MIGRATE_ENV = writeEnv(
      "staging-migrate-wrong-host.env",
      directUrl("ep-other-777777.aws.neon.tech")
    );
    expect(() => guard.loadStagingEnvironment({ mode: "migrate" })).toThrow(
      expect.objectContaining({ code: "TARGET_HOST_MISMATCH" })
    );
  });

  it("requires RUN_STAGING_INTEGRATION=1 for integration mode", () => {
    setBaseEnv();
    process.env.STAGING_RUNTIME_ENV = writeEnv(
      "staging-runtime-integration.env",
      pooledUrl(),
      { KITE_TOKEN_ENCRYPTION_KEY: "a".repeat(64) }
    );
    expect(() =>
      guard.loadStagingEnvironment({ mode: "runtime", integration: true })
    ).toThrow(expect.objectContaining({ code: "INTEGRATION_NOT_ENABLED" }));
  });

  it("requires a valid staging encryption key for runtime", () => {
    setBaseEnv();
    process.env.RUN_STAGING_INTEGRATION = "1";
    process.env.STAGING_RUNTIME_ENV = writeEnv(
      "staging-runtime-bad-key.env",
      pooledUrl(),
      { KITE_TOKEN_ENCRYPTION_KEY: "not-hex" }
    );
    expect(() =>
      guard.loadStagingEnvironment({ mode: "runtime", integration: true })
    ).toThrow(expect.objectContaining({ code: "ENCRYPTION_KEY_INVALID" }));
  });

  it("refuses an ambiguous DATABASE_URL from the process environment", () => {
    setBaseEnv();
    process.env.STAGING_MIGRATE_ENV = writeEnv("staging-migrate-env.env", directUrl());
    process.env.DATABASE_URL = directUrl("ep-other-777777.aws.neon.tech");

    expect(() => guard.loadStagingEnvironment({ mode: "migrate" })).toThrow(
      expect.objectContaining({ code: "DATABASE_URL_AMBIGUOUS" })
    );
  });

  it("refuses identical migrate and runtime files", () => {
    setBaseEnv();
    const file = writeEnv("staging-same.env", directUrl(), {
      KITE_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
    });
    process.env.STAGING_MIGRATE_ENV = file;
    process.env.STAGING_RUNTIME_ENV = file;

    expect(() => guard.loadStagingEnvironment({ mode: "migrate" })).toThrow(
      expect.objectContaining({ code: "ENV_FILES_NOT_DISTINCT" })
    );
  });

  it("detects duplicate DATABASE_URL entries", () => {
    setBaseEnv();
    const file = path.join(tempDir, "staging-duplicate.env");
    fs.writeFileSync(
      file,
      `DATABASE_URL=${directUrl()}\nDATABASE_URL=${directUrl()}\n`,
      "utf8"
    );
    process.env.STAGING_MIGRATE_ENV = file;

    expect(() => guard.loadStagingEnvironment({ mode: "migrate" })).toThrow(
      expect.objectContaining({ code: "DATABASE_URL_AMBIGUOUS" })
    );
  });
});
