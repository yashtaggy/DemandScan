#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node entry point */
/**
 * DemandScan — read-only staging migration preflight.
 *
 * Confirms the target is the configured staging database, that every table
 * the Live Trade migration depends on exists with the expected columns, and
 * whether the Live Trade tables are absent (fresh), complete (already
 * migrated), or partial/incompatible (blocked).
 *
 * This script NEVER modifies data or schema. It only reads information_schema
 * and pg_catalog.
 *
 * Exit codes:
 *   0  READY_FRESH or READY_MIGRATED
 *   1  connection or unexpected failure
 *   2  blocked by prerequisites, partial tables, or incompatible objects
 *   3  staging guard rejected the environment or target
 */

const { EXPECTED_SCHEMA } = require('./expected-schema');
const {
  loadStagingEnvironment,
  formatTarget,
  StagingGuardError,
} = require('./staging-guard');

const LIVE_TRADE_TABLES = [
  'live_trade_groups',
  'live_trade_items',
  'live_trade_quote_state',
];

const PREREQUISITE_TABLES = Object.keys(EXPECTED_SCHEMA).filter(
  (table) => !LIVE_TRADE_TABLES.includes(table)
);

const LIVE_TRADE_INDEXES = {
  live_trade_groups: [
    'live_trade_groups_owner_name_uq',
    'live_trade_groups_owner_sort_idx',
  ],
  live_trade_items: [
    'live_trade_items_owner_sort_idx',
    'live_trade_items_owner_group_idx',
    'live_trade_items_instrument_idx',
  ],
  live_trade_quote_state: [],
};

const LIVE_TRADE_CONSTRAINTS = {
  live_trade_groups: [
    'live_trade_groups_pkey',
    'live_trade_groups_owner_not_blank',
    'live_trade_groups_name_len',
    'live_trade_groups_sort_nonneg',
    'live_trade_groups_version_pos',
    'live_trade_groups_group_owner_uq',
  ],
  live_trade_items: [
    'live_trade_items_pkey',
    'live_trade_items_instrument_id_fkey',
    'live_trade_items_owner_not_blank',
    'live_trade_items_priority_chk',
    'live_trade_items_direction_chk',
    'live_trade_items_timeframe_chk',
    'live_trade_items_status_chk',
    'live_trade_items_notes_len',
    'live_trade_items_prices_chk',
    'live_trade_items_sort_nonneg',
    'live_trade_items_version_pos',
    'live_trade_items_group_owner_fk',
  ],
  live_trade_quote_state: [
    'live_trade_quote_state_pkey',
    'live_trade_quote_state_owner_not_blank',
  ],
};

const LIVE_TRADE_TYPES = {
  live_trade_groups: {
    group_id: 'uuid',
    owner_user_id: 'text',
    name: 'text',
    sort_order: 'integer',
    version: 'integer',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
  },
  live_trade_items: {
    item_id: 'uuid',
    owner_user_id: 'text',
    instrument_id: 'bigint',
    group_id: 'uuid',
    priority: 'text',
    direction: 'text',
    timeframe: 'text',
    entry_price: 'numeric',
    target_price: 'numeric',
    stop_loss: 'numeric',
    notes: 'text',
    trade_status: 'text',
    sort_order: 'integer',
    version: 'integer',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
  },
  live_trade_quote_state: {
    owner_user_id: 'text',
    last_request_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
  },
};

async function loadCatalog(sql) {
  const allTables = Object.keys(EXPECTED_SCHEMA);

  const columnRows = await sql.query(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [allTables]
  );

  const indexRows = await sql.query(
    `SELECT tablename AS table_name, indexname
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])`,
    [LIVE_TRADE_TABLES]
  );

  const constraintRows = await sql.query(
    `SELECT t.relname AS table_name, c.conname, c.contype
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = ANY($1::text[])`,
    [LIVE_TRADE_TABLES]
  );

  const columns = new Map();
  for (const row of columnRows) {
    const table = String(row.table_name);
    if (!columns.has(table)) columns.set(table, new Map());
    columns.get(table).set(String(row.column_name), String(row.data_type));
  }

  const indexes = new Map();
  for (const row of indexRows) {
    const table = String(row.table_name);
    if (!indexes.has(table)) indexes.set(table, new Set());
    indexes.get(table).add(String(row.indexname));
  }

  const constraints = new Map();
  for (const row of constraintRows) {
    const table = String(row.table_name);
    if (!constraints.has(table)) constraints.set(table, new Set());
    constraints.get(table).add(String(row.conname));
  }

  return { columns, indexes, constraints };
}

function missingColumnsFor(table, columns) {
  const actual = columns.get(table) || new Map();
  return (EXPECTED_SCHEMA[table] || []).filter((column) => !actual.has(column));
}

function extraColumnsFor(table, columns) {
  const actual = columns.get(table) || new Map();
  const expected = new Set(EXPECTED_SCHEMA[table] || []);
  return [...actual.keys()].filter((column) => !expected.has(column)).sort();
}

function typeMismatchesFor(table, columns) {
  const actual = columns.get(table) || new Map();
  const expected = LIVE_TRADE_TYPES[table] || {};
  const mismatches = [];
  for (const [column, type] of Object.entries(expected)) {
    if (!actual.has(column)) continue;
    if (actual.get(column) !== type) {
      mismatches.push({ column, expected: type, actual: actual.get(column) });
    }
  }
  return mismatches;
}

function missingFrom(setMap, table, expected) {
  const actual = setMap.get(table) || new Set();
  return expected.filter((name) => !actual.has(name));
}

/**
 * Pure preflight evaluation over an object exposing `query(text, params)`.
 * Exported so the logic can be unit-tested without a database.
 */
async function runPreflight(sql) {
  const { columns, indexes, constraints } = await loadCatalog(sql);

  const prerequisite = {
    total: PREREQUISITE_TABLES.length,
    present: 0,
    missingTables: [],
    missingColumns: [],
  };

  for (const table of PREREQUISITE_TABLES) {
    if (!columns.has(table)) {
      prerequisite.missingTables.push(table);
      continue;
    }
    prerequisite.present += 1;
    for (const column of missingColumnsFor(table, columns)) {
      prerequisite.missingColumns.push(`${table}.${column}`);
    }
  }

  const presentLiveTables = LIVE_TRADE_TABLES.filter((table) => columns.has(table));
  const missingLiveTables = LIVE_TRADE_TABLES.filter(
    (table) => !columns.has(table)
  );

  const liveTrade = {
    present: presentLiveTables,
    missing: missingLiveTables,
    missingColumns: [],
    missingIndexes: [],
    missingConstraints: [],
    typeMismatches: [],
    extraColumns: [],
  };

  for (const table of presentLiveTables) {
    for (const column of missingColumnsFor(table, columns)) {
      liveTrade.missingColumns.push(`${table}.${column}`);
    }
    for (const mismatch of typeMismatchesFor(table, columns)) {
      liveTrade.typeMismatches.push(`${table}.${mismatch.column}`);
    }
    for (const column of extraColumnsFor(table, columns)) {
      liveTrade.extraColumns.push(`${table}.${column}`);
    }
    for (const index of missingFrom(
      indexes,
      table,
      LIVE_TRADE_INDEXES[table] || []
    )) {
      liveTrade.missingIndexes.push(index);
    }
    for (const constraint of missingFrom(
      constraints,
      table,
      LIVE_TRADE_CONSTRAINTS[table] || []
    )) {
      liveTrade.missingConstraints.push(constraint);
    }
  }

  const prerequisitesOk =
    prerequisite.missingTables.length === 0 &&
    prerequisite.missingColumns.length === 0;

  const liveTablesOk =
    liveTrade.missingColumns.length === 0 &&
    liveTrade.missingIndexes.length === 0 &&
    liveTrade.missingConstraints.length === 0 &&
    liveTrade.typeMismatches.length === 0;

  let status;
  if (!prerequisitesOk) {
    status = 'BLOCKED_PREREQUISITES';
  } else if (presentLiveTables.length === 0) {
    status = 'READY_FRESH';
  } else if (missingLiveTables.length > 0) {
    status = 'BLOCKED_PARTIAL';
  } else if (!liveTablesOk) {
    status = 'BLOCKED_INCOMPATIBLE';
  } else {
    status = 'READY_MIGRATED';
  }

  return {
    status,
    ready: status === 'READY_FRESH' || status === 'READY_MIGRATED',
    prerequisite,
    liveTrade,
  };
}

function formatPreflight(result) {
  const lines = [];
  lines.push('Migration preflight (read-only):');
  lines.push(
    `  prerequisite tables: ${result.prerequisite.present}/${result.prerequisite.total} present`
  );

  for (const table of result.prerequisite.missingTables) {
    lines.push(`  MISSING PREREQUISITE TABLE  ${table}`);
  }
  for (const column of result.prerequisite.missingColumns) {
    lines.push(`  MISSING PREREQUISITE COLUMN ${column}`);
  }

  if (result.liveTrade.present.length === 0) {
    lines.push('  live trade tables:   none present (fresh database)');
  } else {
    lines.push(
      `  live trade tables:   ${result.liveTrade.present.length}/3 present`
    );
    for (const table of result.liveTrade.missing) {
      lines.push(`  MISSING TABLE        ${table}`);
    }
    for (const column of result.liveTrade.missingColumns) {
      lines.push(`  MISSING COLUMN       ${column}`);
    }
    for (const index of result.liveTrade.missingIndexes) {
      lines.push(`  MISSING INDEX        ${index}`);
    }
    for (const constraint of result.liveTrade.missingConstraints) {
      lines.push(`  MISSING CONSTRAINT   ${constraint}`);
    }
    for (const column of result.liveTrade.typeMismatches) {
      lines.push(`  TYPE MISMATCH        ${column}`);
    }
    for (const column of result.liveTrade.extraColumns) {
      lines.push(`  extra column (warn)  ${column}`);
    }
  }

  lines.push(`RESULT: ${result.status}`);
  return lines.join('\n');
}

function sanitizeError(error) {
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message)
      : String(error);
  return message.replace(/\bpostgres(?:ql)?:\/\/\S+/gi, '[redacted connection string]');
}

async function main() {
  let env;
  try {
    env = loadStagingEnvironment({ mode: 'migrate' });
  } catch (error) {
    if (error instanceof StagingGuardError) {
      console.error(`Staging guard: ${error.message}`);
      process.exit(3);
    }
    throw error;
  }

  console.log(formatTarget(env));
  console.log('');

  const { neon } = require('@neondatabase/serverless');
  const sql = neon(env.url);

  const result = await runPreflight(sql);
  console.log(formatPreflight(result));

  if (!result.ready) {
    console.error(
      '\nPreflight refused: resolve the reported issues before migrating.'
    );
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Preflight failed: ${sanitizeError(error)}`);
    process.exit(1);
  });
}

module.exports = {
  LIVE_TRADE_TABLES,
  PREREQUISITE_TABLES,
  LIVE_TRADE_INDEXES,
  LIVE_TRADE_CONSTRAINTS,
  LIVE_TRADE_TYPES,
  runPreflight,
  formatPreflight,
  sanitizeError,
};
