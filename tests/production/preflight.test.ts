/**
 * Unit tests for the read-only production preflight decision logic. A fake
 * catalog stands in for Postgres, so no database is ever contacted.
 */

import { EXPECTED_SCHEMA } from "../../db/expected-schema";
import {
  LIVE_TRADE_CONSTRAINTS,
  LIVE_TRADE_INDEXES,
  LIVE_TRADE_TABLES,
  LIVE_TRADE_TYPES,
  runPreflight,
} from "../../db/preflight-staging";
import { decideAction, isLiveTradeComplete } from "../../db/preflight-production";

type Row = Record<string, unknown>;

const EXPECTED = EXPECTED_SCHEMA as Record<string, readonly string[]>;
const INDEXES = LIVE_TRADE_INDEXES as Record<string, readonly string[]>;
const CONSTRAINTS = LIVE_TRADE_CONSTRAINTS as Record<string, readonly string[]>;
const TYPES = LIVE_TRADE_TYPES as Record<string, Record<string, string>>;

interface CatalogOptions {
  tables?: Set<string>;
  missingColumns?: Set<string>;
  missingIndexes?: Set<string>;
  missingConstraints?: Set<string>;
  typeOverrides?: Record<string, string>;
}

interface FakeCatalog {
  query: (text: string, params?: unknown[]) => Promise<Row[]>;
  queries: string[];
}

function buildCatalog(options: CatalogOptions = {}): FakeCatalog {
  const tables = options.tables ?? new Set(Object.keys(EXPECTED_SCHEMA));
  const missingColumns = options.missingColumns ?? new Set<string>();
  const missingIndexes = options.missingIndexes ?? new Set<string>();
  const missingConstraints = options.missingConstraints ?? new Set<string>();
  const typeOverrides = options.typeOverrides ?? {};
  const queries: string[] = [];

  return {
    queries,
    query: async (text: string, params?: unknown[]): Promise<Row[]> => {
      queries.push(text);
      const requested = Array.isArray(params?.[0])
        ? (params?.[0] as string[])
        : [];

      if (text.includes("information_schema.columns")) {
        const rows: Row[] = [];
        for (const table of requested) {
          if (!tables.has(table)) continue;
          for (const column of EXPECTED[table] ?? []) {
            if (missingColumns.has(`${table}.${column}`)) continue;
            rows.push({
              table_name: table,
              column_name: column,
              data_type:
                typeOverrides[`${table}.${column}`] ??
                TYPES[table]?.[column] ??
                "text",
            });
          }
        }
        return rows;
      }

      if (text.includes("pg_indexes")) {
        const rows: Row[] = [];
        for (const table of requested) {
          if (!tables.has(table)) continue;
          for (const index of INDEXES[table] ?? []) {
            if (!missingIndexes.has(index)) {
              rows.push({ table_name: table, indexname: index });
            }
          }
        }
        return rows;
      }

      if (text.includes("pg_constraint")) {
        const rows: Row[] = [];
        for (const table of requested) {
          if (!tables.has(table)) continue;
          for (const constraint of CONSTRAINTS[table] ?? []) {
            if (!missingConstraints.has(constraint)) {
              rows.push({
                table_name: table,
                conname: constraint,
                contype: "c",
              });
            }
          }
        }
        return rows;
      }

      throw new Error(`Unexpected catalog query: ${text.slice(0, 40)}`);
    },
  };
}

const ALL_TABLES = new Set(Object.keys(EXPECTED_SCHEMA));
const PREREQ_ONLY = new Set(
  Object.keys(EXPECTED_SCHEMA).filter(
    (table) => !LIVE_TRADE_TABLES.includes(table)
  )
);

const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|COPY)\b/i;

describe("production preflight state detection", () => {
  it("reports a fresh production schema as READY_FRESH and writable", async () => {
    const result = await runPreflight(buildCatalog({ tables: PREREQ_ONLY }));
    expect(result.status).toBe("READY_FRESH");
    expect(result.liveTrade.missing).toEqual(LIVE_TRADE_TABLES);

    const decision = decideAction(result.status);
    expect(decision).toEqual(
      expect.objectContaining({ write: true, exitCode: 0, reason: "APPLY" })
    );
    expect(isLiveTradeComplete(result)).toBe(false);
  });

  it("reports a complete Live Trade schema as already applied", async () => {
    const result = await runPreflight(buildCatalog({ tables: ALL_TABLES }));
    expect(result.status).toBe("READY_MIGRATED");

    const decision = decideAction(result.status);
    expect(decision.write).toBe(false);
    expect(decision.exitCode).toBe(0);
    expect(decision.reason).toBe("ALREADY_APPLIED");
    expect(decision.message).toMatch(/nothing will be written/);
    expect(isLiveTradeComplete(result)).toBe(true);
  });

  it("refuses a partially created Live Trade schema", async () => {
    const tables = new Set(PREREQ_ONLY);
    tables.add("live_trade_groups");
    const result = await runPreflight(buildCatalog({ tables }));

    expect(result.status).toBe("BLOCKED_PARTIAL");
    expect(result.liveTrade.missing).toContain("live_trade_items");
    expect(result.liveTrade.missing).toContain("live_trade_quote_state");

    const decision = decideAction(result.status);
    expect(decision.write).toBe(false);
    expect(decision.exitCode).toBe(2);
    expect(decision.reason).toBe("BLOCKED_PARTIAL");
    expect(isLiveTradeComplete(result)).toBe(false);
  });

  it("refuses a Live Trade table with a missing column", async () => {
    const result = await runPreflight(
      buildCatalog({
        tables: ALL_TABLES,
        missingColumns: new Set(["live_trade_items.version"]),
      })
    );
    expect(result.status).toBe("BLOCKED_INCOMPATIBLE");
    expect(result.liveTrade.missingColumns).toContain("live_trade_items.version");
    expect(decideAction(result.status).write).toBe(false);
    expect(decideAction(result.status).exitCode).toBe(2);
    expect(isLiveTradeComplete(result)).toBe(false);
  });

  it("refuses a Live Trade table with a wrong column type", async () => {
    const result = await runPreflight(
      buildCatalog({
        tables: ALL_TABLES,
        typeOverrides: { "live_trade_groups.version": "text" },
      })
    );
    expect(result.status).toBe("BLOCKED_INCOMPATIBLE");
    expect(result.liveTrade.typeMismatches).toContain("live_trade_groups.version");
    expect(decideAction(result.status).write).toBe(false);
    expect(isLiveTradeComplete(result)).toBe(false);
  });

  it("refuses a Live Trade table with a missing index", async () => {
    const result = await runPreflight(
      buildCatalog({
        tables: ALL_TABLES,
        missingIndexes: new Set(["live_trade_items_owner_instrument_uq"]),
      })
    );
    expect(result.status).toBe("BLOCKED_INCOMPATIBLE");
    expect(result.liveTrade.missingIndexes).toContain(
      "live_trade_items_owner_instrument_uq"
    );
    expect(decideAction(result.status).write).toBe(false);
  });

  it("refuses a Live Trade table with a missing constraint", async () => {
    const result = await runPreflight(
      buildCatalog({
        tables: ALL_TABLES,
        missingConstraints: new Set(["live_trade_items_group_owner_fk"]),
      })
    );
    expect(result.status).toBe("BLOCKED_INCOMPATIBLE");
    expect(result.liveTrade.missingConstraints).toContain(
      "live_trade_items_group_owner_fk"
    );
    expect(decideAction(result.status).write).toBe(false);
  });

  it("refuses a database with a missing prerequisite table", async () => {
    const tables = new Set(PREREQ_ONLY);
    tables.delete("instruments");
    const result = await runPreflight(buildCatalog({ tables }));

    expect(result.status).toBe("BLOCKED_PREREQUISITES");
    expect(result.prerequisite.missingTables).toContain("instruments");

    const decision = decideAction(result.status);
    expect(decision.write).toBe(false);
    expect(decision.exitCode).toBe(2);
    expect(decision.reason).toBe("BLOCKED_PREREQUISITES");
  });

  it("refuses a database with a missing prerequisite column", async () => {
    const result = await runPreflight(
      buildCatalog({
        tables: PREREQ_ONLY,
        missingColumns: new Set(["scan_jobs.instrument_ids"]),
      })
    );
    expect(result.status).toBe("BLOCKED_PREREQUISITES");
    expect(result.prerequisite.missingColumns).toContain(
      "scan_jobs.instrument_ids"
    );
    expect(decideAction(result.status).write).toBe(false);
  });

  it("refuses any unrecognised status", () => {
    const decision = decideAction("SOMETHING_UNEXPECTED");
    expect(decision.write).toBe(false);
    expect(decision.exitCode).toBe(2);
    expect(decision.reason).toBe("SOMETHING_UNEXPECTED");
  });
});

describe("production preflight is read-only", () => {
  it("issues only catalog SELECT statements", async () => {
    const catalog = buildCatalog({ tables: ALL_TABLES });
    await runPreflight(catalog);

    expect(catalog.queries.length).toBe(3);
    for (const query of catalog.queries) {
      expect(query.trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
      expect(query).not.toMatch(WRITE_KEYWORDS);
    }
  });
});
