/**
 * Proves the production migration command selects exactly one file —
 * db/migrations/2026-11-06-add-live-trade.sql — and never db/schema.sql,
 * db/migrate.js, or any other migration. No database is contacted.
 */

import fs from "fs";
import path from "path";
import { splitStatements } from "../../db/sql-statements";
import {
  LIVE_TRADE_MIGRATION_FILE,
  LIVE_TRADE_MIGRATION_PATH,
  readMigrationStatements,
} from "../../db/migrate-live-trade-production";
import { LIVE_TRADE_TABLES } from "../../db/preflight-staging";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DB_DIR = path.join(REPO_ROOT, "db");
const MIGRATIONS_DIR = path.join(DB_DIR, "migrations");
const RUNNER_SOURCE = fs.readFileSync(
  path.join(DB_DIR, "migrate-live-trade-production.js"),
  "utf8"
);

/** Source with comments removed, so doc text cannot satisfy a code assertion. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const index = line.indexOf("//");
      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
}

const RUNNER_CODE = codeOnly(RUNNER_SOURCE);

function otherSqlFiles(): string[] {
  const others = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql") && name !== LIVE_TRADE_MIGRATION_FILE)
    .map((name) => path.join(MIGRATIONS_DIR, name));
  return [path.join(DB_DIR, "schema.sql"), ...others];
}

function statementsOf(file: string): string[] {
  return splitStatements(fs.readFileSync(file, "utf8")) as string[];
}

function createdObjects(statements: string[]): string[] {
  const names: string[] = [];
  for (const statement of statements) {
    const match =
      /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/i.exec(
        statement
      );
    if (match) names.push(match[1]);
  }
  return names;
}

describe("production migration file selection", () => {
  it("names the Live Trade migration as a constant", () => {
    expect(LIVE_TRADE_MIGRATION_FILE).toBe("2026-11-06-add-live-trade.sql");
    expect(path.basename(LIVE_TRADE_MIGRATION_PATH)).toBe(
      LIVE_TRADE_MIGRATION_FILE
    );
    expect(path.dirname(LIVE_TRADE_MIGRATION_PATH)).toBe(MIGRATIONS_DIR);
    expect(fs.existsSync(LIVE_TRADE_MIGRATION_PATH)).toBe(true);
  });

  it("returns exactly the statements of the Live Trade migration", () => {
    const selected = readMigrationStatements() as string[];
    const direct = statementsOf(LIVE_TRADE_MIGRATION_PATH);

    expect(selected.length).toBeGreaterThan(0);
    expect(selected).toEqual(direct);
  });

  it("creates only the three Live Trade tables and their indexes", () => {
    const selected = readMigrationStatements() as string[];
    const objects = createdObjects(selected);
    const liveTables: string[] = LIVE_TRADE_TABLES;

    expect(objects.length).toBe(9);

    const tables = objects.filter((name) => liveTables.includes(name));
    expect(tables.sort()).toEqual([...liveTables].sort());

    const indexes = objects.filter((name) => !liveTables.includes(name));
    expect(indexes.length).toBe(6);
    for (const index of indexes) {
      expect(index.startsWith("live_trade_")).toBe(true);
    }
  });

  it("shares no statement with schema.sql or any other migration", () => {
    const selected = new Set(readMigrationStatements() as string[]);

    for (const file of otherSqlFiles()) {
      for (const statement of statementsOf(file)) {
        expect(selected.has(statement)).toBe(false);
      }
    }
  });

  it("creates no object belonging to another migration file", () => {
    const selectedObjects = new Set(createdObjects(readMigrationStatements() as string[]));

    for (const file of otherSqlFiles()) {
      for (const object of createdObjects(statementsOf(file))) {
        expect(selectedObjects.has(object)).toBe(false);
      }
    }
  });

  it("is additive only — no destructive or data-modifying statement", () => {
    const selected = readMigrationStatements() as string[];

    for (const statement of selected) {
      expect(statement).not.toMatch(
        /\b(DROP|TRUNCATE|DELETE|INSERT|UPDATE|ALTER|GRANT|REVOKE)\b/i
      );
      expect(statement.toUpperCase().startsWith("CREATE")).toBe(true);
    }
  });
});

describe("production runner never selects other schema sources", () => {
  it("does not reference schema.sql, the general runner, or directory listing", () => {
    expect(RUNNER_CODE).not.toContain("schema.sql");
    expect(RUNNER_CODE).not.toMatch(/require\(['"]\.\/migrate['"]\)/);
    expect(RUNNER_CODE).not.toContain("migrate.js");
    expect(RUNNER_CODE).not.toContain("readdir");
    expect(RUNNER_CODE).not.toContain("child_process");
    expect(RUNNER_CODE).not.toContain("spawn");
    expect(RUNNER_CODE).not.toContain("execSync");
  });

  it("reads only the constant Live Trade path", () => {
    expect(RUNNER_CODE).toContain(LIVE_TRADE_MIGRATION_FILE);
    expect(RUNNER_CODE).toContain("LIVE_TRADE_MIGRATION_PATH");
    expect(RUNNER_CODE).toMatch(/readFileSync\(LIVE_TRADE_MIGRATION_PATH/);
    expect(RUNNER_CODE).not.toMatch(/readFileSync\((?!LIVE_TRADE_MIGRATION_PATH)/);
  });

  it("re-checks the guard and refuses to write when preflight blocks", () => {
    expect(RUNNER_CODE).toContain("loadProductionEnvironment({ write: true })");
    expect(RUNNER_CODE).toContain("runPreflight");
    expect(RUNNER_CODE).toContain("decideAction");
    expect(RUNNER_CODE).toMatch(/if \(!decision\.write\)/);
    expect(RUNNER_SOURCE).toContain("no rollback is claimed");
  });
});

describe("production verification command is read-only", () => {
  const VERIFY_CODE = codeOnly(
    fs.readFileSync(path.join(DB_DIR, "verify-live-trade-production.js"), "utf8")
  );
  const PREFLIGHT_CODE = codeOnly(
    fs.readFileSync(path.join(DB_DIR, "preflight-production.js"), "utf8")
  );

  it("issues no statement of its own and requests no approval flag", () => {
    expect(VERIFY_CODE).not.toContain("sql.query(");
    expect(VERIFY_CODE).not.toContain("splitStatements");
    expect(VERIFY_CODE).not.toContain("readMigrationStatements");
    expect(VERIFY_CODE).toContain("loadProductionEnvironment({ write: false })");
  });

  it("runs the catalog preflight and reports completeness", () => {
    expect(PREFLIGHT_CODE).toContain("runPreflight");
    expect(PREFLIGHT_CODE).toContain(
      "loadProductionEnvironment({ write: false })"
    );
    expect(PREFLIGHT_CODE).not.toContain("sql.query(");
    expect(PREFLIGHT_CODE).not.toContain("splitStatements");
  });
});
