/**
 * Unit tests for the read-only migration preflight. No database is used.
 */

import { EXPECTED_SCHEMA } from "../../db/expected-schema";
import {
  LIVE_TRADE_CONSTRAINTS,
  LIVE_TRADE_INDEXES,
  LIVE_TRADE_TABLES,
  LIVE_TRADE_TYPES,
  formatPreflight,
  runPreflight,
} from "../../db/preflight-staging";

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
  extraColumns?: Record<string, string>;
}

function buildCatalog(options: CatalogOptions = {}) {
  const tables = options.tables ?? new Set(Object.keys(EXPECTED_SCHEMA));
  const missingColumns = options.missingColumns ?? new Set<string>();
  const missingIndexes = options.missingIndexes ?? new Set<string>();
  const missingConstraints = options.missingConstraints ?? new Set<string>();
  const typeOverrides = options.typeOverrides ?? {};
  const extraColumns = options.extraColumns ?? {};

  return {
    query: async (text: string, params?: unknown[]): Promise<Row[]> => {
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
          if (extraColumns[table]) {
            rows.push({
              table_name: table,
              column_name: extraColumns[table],
              data_type: "text",
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

describe("staging migration preflight", () => {
  it("reports a fresh database as ready", async () => {
    const result = await runPreflight(buildCatalog({ tables: PREREQ_ONLY }));
    expect(result.status).toBe("READY_FRESH");
    expect(result.ready).toBe(true);
    expect(result.liveTrade.missing).toEqual(LIVE_TRADE_TABLES);
  });

  it("reports a fully migrated database as ready", async () => {
    const result = await runPreflight(buildCatalog({ tables: ALL_TABLES }));
    expect(result.status).toBe("READY_MIGRATED");
    expect(result.ready).toBe(true);
  });

  it("blocks when a prerequisite table is missing", async () => {
    const tables = new Set(ALL_TABLES);
    tables.delete("instruments");
    const result = await runPreflight(buildCatalog({ tables }));
    expect(result.status).toBe("BLOCKED_PREREQUISITES");
    expect(result.ready).toBe(false);
    expect(result.prerequisite.missingTables).toContain("instruments");
  });

  it("blocks when a prerequisite column is missing", async () => {
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
  });

  it("blocks partially created Live Trade tables", async () => {
    const tables = new Set(ALL_TABLES);
    tables.delete("live_trade_quote_state");
    const result = await runPreflight(buildCatalog({ tables }));
    expect(result.status).toBe("BLOCKED_PARTIAL");
    expect(result.liveTrade.missing).toEqual(["live_trade_quote_state"]);
  });

  it("blocks a missing Live Trade index", async () => {
    const result = await runPreflight(
      buildCatalog({
        missingIndexes: new Set(["live_trade_items_owner_sort_idx"]),
      })
    );
    expect(result.status).toBe("BLOCKED_INCOMPATIBLE");
    expect(result.liveTrade.missingIndexes).toContain(
      "live_trade_items_owner_sort_idx"
    );
  });

  it("blocks a missing Live Trade constraint", async () => {
    const result = await runPreflight(
      buildCatalog({
        missingConstraints: new Set(["live_trade_items_group_owner_fk"]),
      })
    );
    expect(result.status).toBe("BLOCKED_INCOMPATIBLE");
    expect(result.liveTrade.missingConstraints).toContain(
      "live_trade_items_group_owner_fk"
    );
  });

  it("blocks an incompatible column type", async () => {
    const result = await runPreflight(
      buildCatalog({
        typeOverrides: { "live_trade_items.version": "text" },
      })
    );
    expect(result.status).toBe("BLOCKED_INCOMPATIBLE");
    expect(result.liveTrade.typeMismatches).toContain(
      "live_trade_items.version"
    );
  });

  it("warns about extra columns without blocking", async () => {
    const result = await runPreflight(
      buildCatalog({
        extraColumns: { live_trade_items: "future_column" },
      })
    );
    expect(result.status).toBe("READY_MIGRATED");
    expect(result.liveTrade.extraColumns).toContain(
      "live_trade_items.future_column"
    );
  });

  it("prints only object names and the result", async () => {
    const result = await runPreflight(buildCatalog({ tables: PREREQ_ONLY }));
    const printed = formatPreflight(result);
    expect(printed).toContain("RESULT: READY_FRESH");
    expect(printed).toContain("prerequisite tables:");
    expect(printed).not.toMatch(/postgres(?:ql)?:\/\//);
  });
});
