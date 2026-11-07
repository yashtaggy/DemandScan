/**
 * Unit tests for the production migration guard. These never connect to a
 * database: every case is rejected while parsing/validating the environment,
 * or loads a synthetic env file pointing at a fake Neon hostname.
 */

import { spawnSync, type SpawnSyncReturns } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import * as guard from "../../db/production-guard";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const ENV_KEYS = [
  "PRODUCTION_MIGRATE_ENV",
  "EXPECTED_PRODUCTION_HOST",
  "ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION",
  "EXPECTED_STAGING_HOST",
  "STAGING_MIGRATE_ENV",
  "STAGING_RUNTIME_ENV",
  "FORBIDDEN_DATABASE_HOST",
  "DB_ENV_FILE",
  "DATABASE_URL",
] as const;

const DIRECT_HOST = "ep-production-999999.aws.neon.tech";
const POOLED_HOST = "ep-production-999999-pooler.aws.neon.tech";
const OTHER_HOST = "ep-other-777777.aws.neon.tech";
const PASSWORD = "supersecret";

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
  return `postgresql://zzprod:${PASSWORD}@${host}/demandscan?sslmode=require`;
}

function pooledUrl(host = POOLED_HOST): string {
  return `postgresql://zzprod:${PASSWORD}@${host}/demandscan?sslmode=require`;
}

function setBaseEnv(overrides: Record<string, string> = {}): void {
  process.env.EXPECTED_PRODUCTION_HOST = DIRECT_HOST;
  Object.assign(process.env, overrides);
}

function approve(): void {
  process.env.ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION = "YES";
}

function expectGuardError(fn: () => unknown, code: string): void {
  expect(fn).toThrow(expect.objectContaining({ code }));
}

function expectNoSecrets(output: string): void {
  expect(output).not.toMatch(/postgres(?:ql)?:\/\//i);
  expect(output).not.toContain(PASSWORD);
  expect(output).not.toContain("zzprod:");
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "demandscan-production-"));
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
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("production guard — approval", () => {
  it("refuses a write without the explicit approval flag", () => {
    setBaseEnv();
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-no-approval.env",
      directUrl()
    );
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: true }),
      "PRODUCTION_APPROVAL_MISSING"
    );
  });

  it("refuses a write when the approval flag is not exactly YES", () => {
    setBaseEnv({ ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION: "yes" });
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-lowercase-approval.env",
      directUrl()
    );
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: true }),
      "PRODUCTION_APPROVAL_MISSING"
    );
  });

  it("does not require the approval flag for read-only use", () => {
    setBaseEnv();
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-read-only.env",
      directUrl()
    );
    const env = guard.loadProductionEnvironment({ write: false });
    expect(env.mode).toBe("read-only");
  });
});

describe("production guard — environment file selection", () => {
  it("refuses to run without PRODUCTION_MIGRATE_ENV and never reads .env.local", () => {
    setBaseEnv();
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "ENV_FILE_NOT_SELECTED"
    );
  });

  it("refuses a missing environment file", () => {
    setBaseEnv();
    process.env.PRODUCTION_MIGRATE_ENV = path.join(tempDir, "absent.env");
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "ENV_FILE_MISSING"
    );
  });

  it("refuses an environment file inside the repository", () => {
    setBaseEnv();
    process.env.PRODUCTION_MIGRATE_ENV = path.join(REPO_ROOT, "package.json");
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "ENV_FILE_INSIDE_REPO"
    );
  });

  it("refuses a file that does not define DATABASE_URL", () => {
    setBaseEnv();
    const file = path.join(tempDir, "production-empty.env");
    fs.writeFileSync(file, "SOMETHING_ELSE=1\n", "utf8");
    process.env.PRODUCTION_MIGRATE_ENV = file;
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "DATABASE_URL_MISSING"
    );
  });

  it("refuses a file that defines DATABASE_URL twice", () => {
    setBaseEnv();
    const file = path.join(tempDir, "production-duplicate.env");
    fs.writeFileSync(
      file,
      `DATABASE_URL=${directUrl()}\nDATABASE_URL=${directUrl(OTHER_HOST)}\n`,
      "utf8"
    );
    process.env.PRODUCTION_MIGRATE_ENV = file;
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "DATABASE_URL_AMBIGUOUS"
    );
  });
});

describe("production guard — inherited and conflicting configuration", () => {
  it("rejects an inherited DATABASE_URL", () => {
    setBaseEnv();
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-inherited.env",
      directUrl()
    );
    process.env.DATABASE_URL = directUrl(OTHER_HOST);
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "DATABASE_URL_INHERITED"
    );
  });

  it("rejects an inherited DATABASE_URL even when it matches the file", () => {
    setBaseEnv();
    const url = directUrl();
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-inherited-match.env",
      url
    );
    process.env.DATABASE_URL = url;
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "DATABASE_URL_INHERITED"
    );
  });

  it("rejects DB_ENV_FILE", () => {
    setBaseEnv();
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-db-env-file.env",
      directUrl()
    );
    process.env.DB_ENV_FILE = path.join(tempDir, "other.env");
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "ENV_FILE_CONFLICT"
    );
  });

  it("rejects a staging variable pointing at the production file", () => {
    setBaseEnv();
    const file = writeEnv("production-shared-with-staging.env", directUrl());
    process.env.PRODUCTION_MIGRATE_ENV = file;
    process.env.STAGING_MIGRATE_ENV = file;
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "ENV_FILE_CONFLICT"
    );
  });
});

describe("production guard — hostname checks", () => {
  it("requires EXPECTED_PRODUCTION_HOST", () => {
    delete process.env.EXPECTED_PRODUCTION_HOST;
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-no-expected-host.env",
      directUrl()
    );
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "EXPECTED_HOST_MISSING"
    );
  });

  it("rejects a pooled EXPECTED_PRODUCTION_HOST", () => {
    setBaseEnv({ EXPECTED_PRODUCTION_HOST: POOLED_HOST });
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-pooled-expected.env",
      pooledUrl()
    );
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "EXPECTED_HOST_INVALID"
    );
  });

  it("rejects a non-Neon EXPECTED_PRODUCTION_HOST", () => {
    setBaseEnv({ EXPECTED_PRODUCTION_HOST: "db.example.com" });
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-non-neon-expected.env",
      directUrl()
    );
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "EXPECTED_HOST_INVALID"
    );
  });

  it("rejects EXPECTED_PRODUCTION_HOST equal to the staging host", () => {
    setBaseEnv({ EXPECTED_STAGING_HOST: DIRECT_HOST });
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-host-confusion.env",
      directUrl()
    );
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "HOST_CONFUSION"
    );
  });

  it("rejects a wrong hostname in the production file", () => {
    setBaseEnv();
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-wrong-host.env",
      directUrl(OTHER_HOST)
    );
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "TARGET_HOST_MISMATCH"
    );
  });

  it("rejects a pooled connection string", () => {
    setBaseEnv();
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-pooled.env",
      pooledUrl()
    );
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "TARGET_NOT_DIRECT"
    );
  });

  it("rejects a non-Neon connection string", () => {
    setBaseEnv();
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-non-neon.env",
      `postgresql://zzprod:${PASSWORD}@db.example.com/demandscan?sslmode=require`
    );
    expectGuardError(
      () => guard.loadProductionEnvironment({ write: false }),
      "TARGET_NOT_NEON"
    );
  });

  it("accepts the direct production host and reports sanitized metadata", () => {
    setBaseEnv();
    approve();
    process.env.PRODUCTION_MIGRATE_ENV = writeEnv(
      "production-valid.env",
      directUrl()
    );

    const env = guard.loadProductionEnvironment({ write: true });
    expect(env.mode).toBe("migrate");
    expect(env.target.host).toBe(DIRECT_HOST);
    expect(env.target.pooled).toBe(false);
    expect(env.target.isNeon).toBe(true);
    expect(env.target.database).toBe("demandscan");
    expect(env.target.sslmode).toBe("require");
    expect(env.expectedHost).toBe(DIRECT_HOST);

    const printed = guard.formatTarget(env);
    expect(printed).toContain(DIRECT_HOST);
    expect(printed).toContain("demandscan");
    expect(printed).toContain("pooled:   no");
    expect(printed).toContain("production-valid.env");
    expect(printed).not.toContain(path.join(tempDir, "production-valid.env"));
    expectNoSecrets(printed);
    expectNoSecrets(env.file);
  });
});

describe("production commands refuse before any connection", () => {
  function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ENV_KEYS) delete env[key];
    return { ...env, ...overrides };
  }

  function run(script: string, env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [path.join(REPO_ROOT, "db", script)], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      timeout: 20000,
    });
  }

  const READ_ONLY_SCRIPTS = [
    "preflight-production.js",
    "verify-live-trade-production.js",
  ];

  it.each(READ_ONLY_SCRIPTS)(
    "%s exits 3 without PRODUCTION_MIGRATE_ENV",
    (script) => {
      const result = run(script, cleanEnv({ EXPECTED_PRODUCTION_HOST: DIRECT_HOST }));
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status).toBe(3);
      expect(output).toContain("PRODUCTION_MIGRATE_ENV");
      expect(output).toContain("Production guard:");
      expectNoSecrets(output);
    }
  );

  it("preflight-production.js exits 3 for a pooled connection string", () => {
    const file = writeEnv("spawn-pooled.env", pooledUrl());
    const result = run(
      "preflight-production.js",
      cleanEnv({
        EXPECTED_PRODUCTION_HOST: DIRECT_HOST,
        PRODUCTION_MIGRATE_ENV: file,
      })
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).toBe(3);
    expect(output).toContain("direct");
    expectNoSecrets(output);
  });

  it("preflight-production.js exits 3 for a wrong hostname", () => {
    const file = writeEnv("spawn-wrong-host.env", directUrl(OTHER_HOST));
    const result = run(
      "preflight-production.js",
      cleanEnv({
        EXPECTED_PRODUCTION_HOST: DIRECT_HOST,
        PRODUCTION_MIGRATE_ENV: file,
      })
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).toBe(3);
    expect(output).toContain("EXPECTED_PRODUCTION_HOST");
    expectNoSecrets(output);
  });

  it("migrate-live-trade-production.js exits 3 without the approval flag", () => {
    const file = writeEnv("spawn-no-approval.env", directUrl());
    const result = run(
      "migrate-live-trade-production.js",
      cleanEnv({
        EXPECTED_PRODUCTION_HOST: DIRECT_HOST,
        PRODUCTION_MIGRATE_ENV: file,
      })
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).toBe(3);
    expect(output).toContain("ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION");
    expect(output).not.toContain("Applying");
    expectNoSecrets(output);
  });

  it("migrate-live-trade-production.js exits 3 when the env file is absent", () => {
    const result = run(
      "migrate-live-trade-production.js",
      cleanEnv({
        EXPECTED_PRODUCTION_HOST: DIRECT_HOST,
        ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION: "YES",
      })
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).toBe(3);
    expect(output).toContain("PRODUCTION_MIGRATE_ENV");
    expect(output).not.toContain("Applying");
    expectNoSecrets(output);
  });

  it("migrate-live-trade-production.js exits 3 on an inherited DATABASE_URL", () => {
    const file = writeEnv("spawn-inherited.env", directUrl());
    const result = run(
      "migrate-live-trade-production.js",
      cleanEnv({
        EXPECTED_PRODUCTION_HOST: DIRECT_HOST,
        ALLOW_LIVE_TRADE_PRODUCTION_MIGRATION: "YES",
        PRODUCTION_MIGRATE_ENV: file,
        DATABASE_URL: directUrl(OTHER_HOST),
      })
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).toBe(3);
    expect(output).toContain("DATABASE_URL is set");
    expect(output).not.toContain("Applying");
    expectNoSecrets(output);
  });
});
