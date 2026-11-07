/**
 * Live Trade repository — owner-scoped PostgreSQL access.
 *
 * The Neon HTTP driver exposes non-interactive transactions only: a batch of
 * queries is submitted as one transaction on one backend, in array order.
 * There is no callback transaction, so conditional logic is expressed in SQL:
 *
 *  - Limits are guarded INSERT ... SELECT statements, serialized by a
 *    transaction-scoped per-owner advisory lock that is the FIRST statement.
 *  - Updates and deletes carry the expected `version` in their WHERE clause.
 *  - Reorder locks the owned set with SELECT ... FOR UPDATE before a single
 *    data-modifying CTE validates the submitted set and renumbers rows.
 *  - Group deletion row-locks the target, ungroups items and deletes the group
 *    in one transaction.
 *  - Item reassignment key-shares the target group so a concurrent delete
 *    cannot invalidate the update.
 *
 * Every workspace statement is scoped by `owner_user_id`. Foreign identifiers
 * therefore match zero rows and surface as NOT_FOUND, never as another owner's
 * data. Instrument-master reads at the end of the file are the only exception:
 * that table is shared reference data with no owner column.
 *
 * Each statement starts with a `-- lt:<marker>` comment. The markers document
 * transaction step order and let tests dispatch on statements.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import type {
  LifecycleState,
  Pattern,
  Timeframe,
  ZoneSide,
} from "@/lib/scanner/types";
import {
  LIVE_TRADE_GROUP_LIMIT,
  LIVE_TRADE_INSTRUMENT_SEARCH_LIMIT,
  LIVE_TRADE_ITEM_LIMIT,
  LIVE_TRADE_QUOTE_COOLDOWN_SECONDS,
  type LiveTradeDirection,
  type LiveTradePriority,
  type LiveTradeStatus,
  type LiveTradeTimeframe,
} from "./constants";
import { LiveTradeError, type LiveTradeErrorCode } from "./errors";
import type {
  CreateLiveTradeItemInput,
  LiveTradeOwnerId,
  UpdateLiveTradeItemInput,
} from "./types";
import { isValidOwnerId } from "./validation";

// ─── DTOs ─────────────────────────────────────────────────────────────────────

export interface LiveTradeGroupDto {
  groupId: string;
  name: string;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LiveTradeItemDto {
  itemId: string;
  instrumentId: number;
  symbol: string;
  companyName: string | null;
  groupId: string | null;
  priority: LiveTradePriority;
  direction: LiveTradeDirection | null;
  timeframe: LiveTradeTimeframe | null;
  entryPrice: number | null;
  targetPrice: number | null;
  stopLoss: number | null;
  notes: string;
  tradeStatus: LiveTradeStatus;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

type DbRow = Record<string, unknown>;

// ─── Guards, mapping and error sanitation ────────────────────────────────────

/**
 * Runtime owner check. The branded type is a compile-time aid only; a forged
 * cast must still fail before any query runs.
 */
function assertOwner(ownerId: LiveTradeOwnerId): void {
  if (!isValidOwnerId(ownerId)) throw new LiveTradeError("UNAUTHENTICATED");
}

function toNumber(value: unknown): number {
  return Number(value);
}

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapGroup(row: DbRow): LiveTradeGroupDto {
  return {
    groupId: String(row.group_id),
    name: String(row.name),
    sortOrder: toNumber(row.sort_order),
    version: toNumber(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapItem(row: DbRow): LiveTradeItemDto {
  return {
    itemId: String(row.item_id),
    instrumentId: toNumber(row.instrument_id),
    symbol: String(row.symbol),
    companyName:
      row.company_name === null || row.company_name === undefined
        ? null
        : String(row.company_name),
    groupId: row.group_id === null || row.group_id === undefined ? null : String(row.group_id),
    priority: row.priority as LiveTradePriority,
    direction: (row.direction ?? null) as LiveTradeDirection | null,
    timeframe: (row.timeframe ?? null) as LiveTradeTimeframe | null,
    entryPrice: toNumberOrNull(row.entry_price),
    targetPrice: toNumberOrNull(row.target_price),
    stopLoss: toNumberOrNull(row.stop_loss),
    notes: String(row.notes ?? ""),
    tradeStatus: row.trade_status as LiveTradeStatus,
    sortOrder: toNumber(row.sort_order),
    version: toNumber(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Converts a database failure into a public LiveTradeError.
 *
 * Only the SQLSTATE and constraint name are logged — never values, SQL text,
 * table names or stack traces.
 */
function mapDbError(
  error: unknown,
  uniqueConstraints: Record<string, LiveTradeErrorCode> = {}
): LiveTradeError {
  if (error instanceof LiveTradeError) return error;

  const source = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    constraint?: unknown;
  };
  const code = typeof source.code === "string" ? source.code : "unknown";
  const constraint =
    typeof source.constraint === "string" ? source.constraint : undefined;

  if (code === "23505" && constraint && uniqueConstraints[constraint]) {
    return new LiveTradeError(uniqueConstraints[constraint]);
  }

  console.error("[live-trade] database operation failed", {
    code,
    constraint: constraint ?? "none",
  });
  return new LiveTradeError("INTERNAL");
}

const ITEM_UNIQUE_CONSTRAINTS = {
  live_trade_items_owner_instrument_uq: "DUPLICATE_ITEM",
} as const;

const GROUP_UNIQUE_CONSTRAINTS = {
  live_trade_groups_owner_name_uq: "DUPLICATE_GROUP",
} as const;

/**
 * Resolves the client lazily so a missing DATABASE_URL or driver failure is
 * sanitized like any other database error.
 */
function liveTradeDb() {
  try {
    return getDb();
  } catch (error) {
    throw mapDbError(error);
  }
}

const ITEM_COLUMNS = `
  it.item_id, it.instrument_id, i.symbol, i.company_name, it.group_id,
  it.priority, it.direction, it.timeframe, it.entry_price, it.target_price,
  it.stop_loss, it.notes, it.trade_status, it.sort_order, it.version,
  it.created_at, it.updated_at`;

const GROUP_COLUMNS = `
  group_id, name, sort_order, version, created_at, updated_at`;

// ─── Groups: read ────────────────────────────────────────────────────────────

export async function listGroups(
  ownerId: LiveTradeOwnerId
): Promise<LiveTradeGroupDto[]> {
  assertOwner(ownerId);
  const db = liveTradeDb();
  try {
    const rows = await db.query(
      `-- lt:list-groups
       SELECT ${GROUP_COLUMNS}
       FROM live_trade_groups
       WHERE owner_user_id = $1
       ORDER BY sort_order ASC, group_id ASC`,
      [ownerId]
    );
    return rows.map(mapGroup);
  } catch (error) {
    throw mapDbError(error);
  }
}

// ─── Groups: create ──────────────────────────────────────────────────────────

export async function createGroup(
  ownerId: LiveTradeOwnerId,
  name: string
): Promise<LiveTradeGroupDto> {
  assertOwner(ownerId);
  const db = liveTradeDb();
  const groupId = randomUUID();

  let results: DbRow[][];
  try {
    results = await db.transaction([
      // Serialize limit enforcement per owner across all instances.
      db.query(
        `-- lt:lock
         SELECT pg_advisory_xact_lock(hashtext('live_trade'), hashtext($1::text))`,
        [ownerId]
      ),
      db.query(
        `-- lt:create-group:diagnostics
         SELECT
           (SELECT count(*) FROM live_trade_groups WHERE owner_user_id = $1) AS group_count,
           EXISTS (
             SELECT 1 FROM live_trade_groups
             WHERE owner_user_id = $1 AND lower(btrim(name)) = lower(btrim($2))
           ) AS name_taken`,
        [ownerId, name]
      ),
      db.query(
        `-- lt:create-group:insert
         INSERT INTO live_trade_groups (group_id, owner_user_id, name, sort_order)
         SELECT $1::uuid, $2::text, $3::text,
                COALESCE(
                  (SELECT max(sort_order) + 1 FROM live_trade_groups WHERE owner_user_id = $2),
                  0
                )
         WHERE (SELECT count(*) FROM live_trade_groups WHERE owner_user_id = $2) < ${LIVE_TRADE_GROUP_LIMIT}
           AND NOT EXISTS (
             SELECT 1 FROM live_trade_groups
             WHERE owner_user_id = $2 AND lower(btrim(name)) = lower(btrim($3))
           )
         RETURNING group_id`,
        [groupId, ownerId, name]
      ),
      db.query(
        `-- lt:create-group:read
         SELECT ${GROUP_COLUMNS}
         FROM live_trade_groups
         WHERE group_id = $1 AND owner_user_id = $2`,
        [groupId, ownerId]
      ),
    ]);
  } catch (error) {
    throw mapDbError(error, GROUP_UNIQUE_CONSTRAINTS);
  }

  const [, diagnostics, inserted, readBack] = results;
  if (inserted.length === 0) {
    const row = diagnostics[0] ?? {};
    if (row.name_taken) throw new LiveTradeError("DUPLICATE_GROUP");
    if (toNumber(row.group_count) >= LIVE_TRADE_GROUP_LIMIT) {
      throw new LiveTradeError("GROUP_LIMIT");
    }
    throw new LiveTradeError("INTERNAL");
  }

  return mapGroup(readBack[0]);
}

// ─── Groups: update name ─────────────────────────────────────────────────────

export async function updateGroup(
  ownerId: LiveTradeOwnerId,
  groupId: string,
  name: string,
  expectedVersion: number
): Promise<LiveTradeGroupDto> {
  assertOwner(ownerId);
  const db = liveTradeDb();

  let results: DbRow[][];
  try {
    results = await db.transaction([
      // Renames participate in the same per-owner advisory lock as creation,
      // deletion and reordering so duplicate-name checks cannot interleave.
      db.query(
        `-- lt:lock
         SELECT pg_advisory_xact_lock(hashtext('live_trade'), hashtext($1::text))`,
        [ownerId]
      ),
      db.query(
        `-- lt:update-group:update
         UPDATE live_trade_groups
         SET name = $4, version = version + 1, updated_at = NOW()
         WHERE group_id = $1 AND owner_user_id = $2 AND version = $3
         RETURNING group_id`,
        [groupId, ownerId, expectedVersion, name]
      ),
      db.query(
        `-- lt:update-group:classify
         SELECT version FROM live_trade_groups
         WHERE group_id = $1 AND owner_user_id = $2`,
        [groupId, ownerId]
      ),
      db.query(
        `-- lt:update-group:read
         SELECT ${GROUP_COLUMNS}
         FROM live_trade_groups
         WHERE group_id = $1 AND owner_user_id = $2`,
        [groupId, ownerId]
      ),
    ]);
  } catch (error) {
    throw mapDbError(error, GROUP_UNIQUE_CONSTRAINTS);
  }

  const [, updated, current, readBack] = results;
  if (updated.length === 0) {
    if (current.length === 0) throw new LiveTradeError("NOT_FOUND");
    throw new LiveTradeError("EDIT_CONFLICT", undefined, {
      currentVersion: toNumber(current[0].version),
    });
  }
  return mapGroup(readBack[0]);
}

// ─── Groups: reorder ─────────────────────────────────────────────────────────

export async function reorderGroups(
  ownerId: LiveTradeOwnerId,
  orderedGroupIds: string[]
): Promise<LiveTradeGroupDto[]> {
  assertOwner(ownerId);
  const db = liveTradeDb();

  let results: DbRow[][];
  try {
    results = await db.transaction([
      db.query(
        `-- lt:lock
         SELECT pg_advisory_xact_lock(hashtext('live_trade'), hashtext($1::text))`,
        [ownerId]
      ),
      // Pin every owned row before the CTE counts and renumbers the set. A
      // concurrent delete waits on these row locks, so the count and the
      // update can never observe different sets inside this transaction.
      db.query(
        `-- lt:reorder-groups:lock-rows
         SELECT group_id
         FROM live_trade_groups
         WHERE owner_user_id = $1
         FOR UPDATE`,
        [ownerId]
      ),
      db.query(
        `-- lt:reorder-groups:update
         WITH incoming AS (
           SELECT group_id, ord
           FROM unnest($2::uuid[]) WITH ORDINALITY AS t(group_id, ord)
         ),
         guard AS (
           SELECT
             (SELECT count(*) FROM live_trade_groups WHERE owner_user_id = $1)
               = cardinality($2::uuid[]) AS count_ok,
             (SELECT count(DISTINCT group_id) FROM incoming)
               = cardinality($2::uuid[]) AS distinct_ok,
             NOT EXISTS (
               SELECT 1 FROM incoming inc
               WHERE NOT EXISTS (
                 SELECT 1 FROM live_trade_groups owned
                 WHERE owned.owner_user_id = $1 AND owned.group_id = inc.group_id
               )
             ) AS owned_ok
         ),
         updated AS (
           UPDATE live_trade_groups g
           SET sort_order = (inc.ord - 1)::integer,
               version = g.version + 1,
               updated_at = NOW()
           FROM incoming inc
           WHERE g.owner_user_id = $1
             AND g.group_id = inc.group_id
             AND (SELECT count_ok AND distinct_ok AND owned_ok FROM guard)
           RETURNING g.group_id
         )
         SELECT
           (SELECT (count_ok AND distinct_ok AND owned_ok) FROM guard) AS ok,
           (SELECT count(*) FROM updated) AS updated_count,
           cardinality($2::uuid[]) AS expected_count`,
        [ownerId, orderedGroupIds]
      ),
      db.query(
        `-- lt:reorder-groups:list
         SELECT ${GROUP_COLUMNS}
         FROM live_trade_groups
         WHERE owner_user_id = $1
         ORDER BY sort_order ASC, group_id ASC`,
        [ownerId]
      ),
    ]);
  } catch (error) {
    throw mapDbError(error);
  }

  const status = results[2][0] ?? {};
  if (!status.ok) throw new LiveTradeError("REORDER_STALE");
  if (toNumber(status.updated_count) !== toNumber(status.expected_count)) {
    throw new LiveTradeError("INTERNAL");
  }
  return results[3].map(mapGroup);
}

// ─── Groups: delete ──────────────────────────────────────────────────────────

export async function deleteGroup(
  ownerId: LiveTradeOwnerId,
  groupId: string,
  expectedVersion: number
): Promise<void> {
  assertOwner(ownerId);
  const db = liveTradeDb();

  let results: DbRow[][];
  try {
    results = await db.transaction([
      db.query(
        `-- lt:lock
         SELECT pg_advisory_xact_lock(hashtext('live_trade'), hashtext($1::text))`,
        [ownerId]
      ),
      // Lock the exact group row for the rest of the transaction. A concurrent
      // rename or group reorder must wait, so the version cannot change between
      // the ungroup and the delete. A stale version still reaches the guarded
      // statements below, where both affect zero rows.
      db.query(
        `-- lt:delete-group:lock-row
         SELECT group_id
         FROM live_trade_groups
         WHERE group_id = $1 AND owner_user_id = $2
         FOR UPDATE`,
        [groupId, ownerId]
      ),
      // Ungroup first: the composite FK is NO ACTION, so the group row cannot
      // be deleted while any item still references it.
      db.query(
        `-- lt:delete-group:ungroup
         UPDATE live_trade_items
         SET group_id = NULL, version = version + 1, updated_at = NOW()
         WHERE owner_user_id = $1 AND group_id = $2
           AND EXISTS (
             SELECT 1 FROM live_trade_groups g
             WHERE g.group_id = $2 AND g.owner_user_id = $1 AND g.version = $3
           )`,
        [ownerId, groupId, expectedVersion]
      ),
      db.query(
        `-- lt:delete-group:delete
         DELETE FROM live_trade_groups
         WHERE group_id = $2 AND owner_user_id = $1 AND version = $3
         RETURNING group_id`,
        [ownerId, groupId, expectedVersion]
      ),
      db.query(
        `-- lt:delete-group:classify
         SELECT version FROM live_trade_groups
         WHERE group_id = $2 AND owner_user_id = $1`,
        [ownerId, groupId]
      ),
    ]);
  } catch (error) {
    throw mapDbError(error);
  }

  const [, , , deleted, current] = results;
  if (deleted.length === 0) {
    if (current.length === 0) throw new LiveTradeError("NOT_FOUND");
    throw new LiveTradeError("EDIT_CONFLICT", undefined, {
      currentVersion: toNumber(current[0].version),
    });
  }
}

// ─── Items: read ─────────────────────────────────────────────────────────────

export async function listItems(
  ownerId: LiveTradeOwnerId
): Promise<LiveTradeItemDto[]> {
  assertOwner(ownerId);
  const db = liveTradeDb();
  try {
    const rows = await db.query(
      `-- lt:list-items
       SELECT ${ITEM_COLUMNS}
       FROM live_trade_items it
       JOIN instruments i ON i.instrument_id = it.instrument_id
       WHERE it.owner_user_id = $1
       ORDER BY it.sort_order ASC, it.item_id ASC`,
      [ownerId]
    );
    return rows.map(mapItem);
  } catch (error) {
    throw mapDbError(error);
  }
}

// ─── Items: create ───────────────────────────────────────────────────────────

export async function createItem(
  ownerId: LiveTradeOwnerId,
  input: CreateLiveTradeItemInput
): Promise<LiveTradeItemDto> {
  assertOwner(ownerId);
  const db = liveTradeDb();
  const itemId = randomUUID();

  let results: DbRow[][];
  try {
    results = await db.transaction([
      db.query(
        `-- lt:lock
         SELECT pg_advisory_xact_lock(hashtext('live_trade'), hashtext($1::text))`,
        [ownerId]
      ),
      db.query(
        `-- lt:create-item:insert
         INSERT INTO live_trade_items (
           item_id, owner_user_id, instrument_id, group_id, priority, direction,
           timeframe, entry_price, target_price, stop_loss, notes, trade_status,
           sort_order
         )
         SELECT $1::uuid, $2::text, inst.instrument_id, $3::uuid, $4::text,
                $5::text, $6::text, $7::numeric, $8::numeric, $9::numeric,
                $10::text, $11::text,
                COALESCE(
                  (SELECT max(sort_order) + 1 FROM live_trade_items WHERE owner_user_id = $2),
                  0
                )
         FROM instruments inst
         WHERE inst.instrument_id = $12
           AND inst.active = TRUE
           AND inst.exchange = 'NSE'
           AND ($3::uuid IS NULL OR EXISTS (
                 SELECT 1 FROM live_trade_groups g
                 WHERE g.group_id = $3 AND g.owner_user_id = $2
               ))
           AND (SELECT count(*) FROM live_trade_items WHERE owner_user_id = $2) < ${LIVE_TRADE_ITEM_LIMIT}
           AND NOT EXISTS (
                 SELECT 1 FROM live_trade_items x
                 WHERE x.owner_user_id = $2 AND x.instrument_id = $12
               )
         RETURNING item_id`,
        [
          itemId,
          ownerId,
          input.groupId,
          input.priority,
          input.direction,
          input.timeframe,
          input.entryPrice,
          input.targetPrice,
          input.stopLoss,
          input.notes,
          input.tradeStatus,
          input.instrumentId,
        ]
      ),
      // Runs after the guarded INSERT and reads current committed state.
      // Instrument activity is not covered by the per-owner advisory lock, so
      // a scanner deactivation committed after the insert's snapshot is only
      // observable here.
      db.query(
        `-- lt:create-item:classify
         SELECT
           (inst.instrument_id IS NOT NULL) AS instrument_exists,
           COALESCE(inst.active, FALSE) AS instrument_active,
           inst.exchange AS instrument_exchange,
           ($2::uuid IS NULL OR EXISTS (
             SELECT 1 FROM live_trade_groups g
             WHERE g.group_id = $2 AND g.owner_user_id = $1
           )) AS group_owned,
           (SELECT count(*) FROM live_trade_items WHERE owner_user_id = $1) AS item_count,
           EXISTS (
             SELECT 1 FROM live_trade_items x
             WHERE x.owner_user_id = $1 AND x.instrument_id = $3
           ) AS instrument_owned
         FROM (SELECT 1 AS seed) s
         LEFT JOIN instruments inst ON inst.instrument_id = $3`,
        [ownerId, input.groupId, input.instrumentId]
      ),
      db.query(
        `-- lt:create-item:read
         SELECT ${ITEM_COLUMNS}
         FROM live_trade_items it
         JOIN instruments i ON i.instrument_id = it.instrument_id
         WHERE it.item_id = $1 AND it.owner_user_id = $2`,
        [itemId, ownerId]
      ),
    ]);
  } catch (error) {
    throw mapDbError(error, ITEM_UNIQUE_CONSTRAINTS);
  }

  const [, inserted, classification, readBack] = results;
  if (inserted.length === 0) {
    const row = classification[0] ?? {};
    if (!row.instrument_exists) throw new LiveTradeError("INSTRUMENT_NOT_SYNCED");
    if (String(row.instrument_exchange) !== "NSE") {
      throw new LiveTradeError("INSTRUMENT_NOT_SYNCED");
    }
    if (!row.instrument_active) throw new LiveTradeError("INSTRUMENT_INACTIVE");
    if (!row.group_owned) throw new LiveTradeError("INVALID_GROUP");
    if (row.instrument_owned) throw new LiveTradeError("DUPLICATE_ITEM");
    if (toNumber(row.item_count) >= LIVE_TRADE_ITEM_LIMIT) {
      throw new LiveTradeError("ITEM_LIMIT");
    }
    throw new LiveTradeError("INTERNAL");
  }

  return mapItem(readBack[0]);
}

// ─── Items: update ───────────────────────────────────────────────────────────

export async function updateItem(
  ownerId: LiveTradeOwnerId,
  itemId: string,
  patch: UpdateLiveTradeItemInput
): Promise<LiveTradeItemDto> {
  assertOwner(ownerId);
  const db = liveTradeDb();

  const { version, ...fields } = patch;
  const patchJson = JSON.stringify(fields);
  const requestedGroupId = patch.groupId ?? null;

  let results: DbRow[][];
  try {
    results = await db.transaction([
      // Key-share prevents a concurrent group delete from removing the target
      // group between the guard check and the item UPDATE. It is taken only for
      // a non-null assignment; a null/omitted group returns no row here.
      db.query(
        `-- lt:update-item:lock-group
         SELECT group_id
         FROM live_trade_groups
         WHERE group_id = $1::uuid AND owner_user_id = $2
         FOR KEY SHARE`,
        [requestedGroupId, ownerId]
      ),
      db.query(
        `-- lt:update-item:update
         UPDATE live_trade_items SET
           group_id = CASE WHEN ($4::jsonb) ? 'groupId'
                           THEN ($4::jsonb ->> 'groupId')::uuid ELSE group_id END,
           priority = CASE WHEN ($4::jsonb) ? 'priority'
                           THEN $4::jsonb ->> 'priority' ELSE priority END,
           direction = CASE WHEN ($4::jsonb) ? 'direction'
                            THEN $4::jsonb ->> 'direction' ELSE direction END,
           timeframe = CASE WHEN ($4::jsonb) ? 'timeframe'
                            THEN $4::jsonb ->> 'timeframe' ELSE timeframe END,
           entry_price = CASE WHEN ($4::jsonb) ? 'entryPrice'
                              THEN ($4::jsonb ->> 'entryPrice')::numeric ELSE entry_price END,
           target_price = CASE WHEN ($4::jsonb) ? 'targetPrice'
                               THEN ($4::jsonb ->> 'targetPrice')::numeric ELSE target_price END,
           stop_loss = CASE WHEN ($4::jsonb) ? 'stopLoss'
                            THEN ($4::jsonb ->> 'stopLoss')::numeric ELSE stop_loss END,
           notes = CASE WHEN ($4::jsonb) ? 'notes'
                        THEN $4::jsonb ->> 'notes' ELSE notes END,
           trade_status = CASE WHEN ($4::jsonb) ? 'tradeStatus'
                               THEN $4::jsonb ->> 'tradeStatus' ELSE trade_status END,
           version = version + 1,
           updated_at = NOW()
         WHERE item_id = $1 AND owner_user_id = $2 AND version = $3
           AND (
             NOT (($4::jsonb) ? 'groupId')
             OR ($4::jsonb -> 'groupId') = 'null'::jsonb
             OR EXISTS (
               SELECT 1 FROM live_trade_groups g
               WHERE g.group_id = ($4::jsonb ->> 'groupId')::uuid
                 AND g.owner_user_id = $2
             )
           )
         RETURNING item_id`,
        [itemId, ownerId, version, patchJson]
      ),
      db.query(
        `-- lt:update-item:classify
         SELECT it.version,
           ($3::uuid IS NULL OR EXISTS (
             SELECT 1 FROM live_trade_groups g
             WHERE g.group_id = $3 AND g.owner_user_id = $2
           )) AS group_owned
         FROM live_trade_items it
         WHERE it.item_id = $1 AND it.owner_user_id = $2`,
        [itemId, ownerId, requestedGroupId]
      ),
      db.query(
        `-- lt:update-item:read
         SELECT ${ITEM_COLUMNS}
         FROM live_trade_items it
         JOIN instruments i ON i.instrument_id = it.instrument_id
         WHERE it.item_id = $1 AND it.owner_user_id = $2`,
        [itemId, ownerId]
      ),
    ]);
  } catch (error) {
    throw mapDbError(error, ITEM_UNIQUE_CONSTRAINTS);
  }

  const [groupLock, updated, current, readBack] = results;
  if (updated.length === 0) {
    if (current.length === 0) throw new LiveTradeError("NOT_FOUND");
    const row = current[0];
    if (toNumber(row.version) !== version) {
      throw new LiveTradeError("EDIT_CONFLICT", undefined, {
        currentVersion: toNumber(row.version),
      });
    }
    if (
      requestedGroupId !== null &&
      (groupLock.length === 0 || !row.group_owned)
    ) {
      throw new LiveTradeError("INVALID_GROUP");
    }
    throw new LiveTradeError("INTERNAL");
  }
  return mapItem(readBack[0]);
}

// ─── Items: delete ───────────────────────────────────────────────────────────

export async function deleteItem(
  ownerId: LiveTradeOwnerId,
  itemId: string,
  expectedVersion: number
): Promise<void> {
  assertOwner(ownerId);
  const db = liveTradeDb();

  let results: DbRow[][];
  try {
    results = await db.transaction([
      // Deleting an item changes the owned set that reorder validates, so it
      // participates in the same per-owner advisory lock.
      db.query(
        `-- lt:lock
         SELECT pg_advisory_xact_lock(hashtext('live_trade'), hashtext($1::text))`,
        [ownerId]
      ),
      db.query(
        `-- lt:delete-item:delete
         DELETE FROM live_trade_items
         WHERE item_id = $1 AND owner_user_id = $2 AND version = $3
         RETURNING item_id`,
        [itemId, ownerId, expectedVersion]
      ),
      db.query(
        `-- lt:delete-item:classify
         SELECT version FROM live_trade_items
         WHERE item_id = $1 AND owner_user_id = $2`,
        [itemId, ownerId]
      ),
    ]);
  } catch (error) {
    throw mapDbError(error);
  }

  const [, deleted, current] = results;
  if (deleted.length === 0) {
    if (current.length === 0) throw new LiveTradeError("NOT_FOUND");
    throw new LiveTradeError("EDIT_CONFLICT", undefined, {
      currentVersion: toNumber(current[0].version),
    });
  }
}

// ─── Items: reorder ──────────────────────────────────────────────────────────

export async function reorderItems(
  ownerId: LiveTradeOwnerId,
  orderedItemIds: string[]
): Promise<LiveTradeItemDto[]> {
  assertOwner(ownerId);
  const db = liveTradeDb();

  let results: DbRow[][];
  try {
    results = await db.transaction([
      db.query(
        `-- lt:lock
         SELECT pg_advisory_xact_lock(hashtext('live_trade'), hashtext($1::text))`,
        [ownerId]
      ),
      // Pin every owned item before the CTE counts and renumbers the set. A
      // concurrent delete waits on these row locks, so the count and the
      // update can never observe different sets inside this transaction.
      db.query(
        `-- lt:reorder-items:lock-rows
         SELECT item_id
         FROM live_trade_items
         WHERE owner_user_id = $1
         FOR UPDATE`,
        [ownerId]
      ),
      db.query(
        `-- lt:reorder-items:update
         WITH incoming AS (
           SELECT item_id, ord
           FROM unnest($2::uuid[]) WITH ORDINALITY AS t(item_id, ord)
         ),
         guard AS (
           SELECT
             (SELECT count(*) FROM live_trade_items WHERE owner_user_id = $1)
               = cardinality($2::uuid[]) AS count_ok,
             (SELECT count(DISTINCT item_id) FROM incoming)
               = cardinality($2::uuid[]) AS distinct_ok,
             NOT EXISTS (
               SELECT 1 FROM incoming inc
               WHERE NOT EXISTS (
                 SELECT 1 FROM live_trade_items owned
                 WHERE owned.owner_user_id = $1 AND owned.item_id = inc.item_id
               )
             ) AS owned_ok
         ),
         updated AS (
           UPDATE live_trade_items it
           SET sort_order = (inc.ord - 1)::integer,
               version = it.version + 1,
               updated_at = NOW()
           FROM incoming inc
           WHERE it.owner_user_id = $1
             AND it.item_id = inc.item_id
             AND (SELECT count_ok AND distinct_ok AND owned_ok FROM guard)
           RETURNING it.item_id
         )
         SELECT
           (SELECT (count_ok AND distinct_ok AND owned_ok) FROM guard) AS ok,
           (SELECT count(*) FROM updated) AS updated_count,
           cardinality($2::uuid[]) AS expected_count`,
        [ownerId, orderedItemIds]
      ),
      db.query(
        `-- lt:reorder-items:list
         SELECT ${ITEM_COLUMNS}
         FROM live_trade_items it
         JOIN instruments i ON i.instrument_id = it.instrument_id
         WHERE it.owner_user_id = $1
         ORDER BY it.sort_order ASC, it.item_id ASC`,
        [ownerId]
      ),
    ]);
  } catch (error) {
    throw mapDbError(error);
  }

  const status = results[2][0] ?? {};
  if (!status.ok) throw new LiveTradeError("REORDER_STALE");
  if (toNumber(status.updated_count) !== toNumber(status.expected_count)) {
    throw new LiveTradeError("INTERNAL");
  }
  return results[3].map(mapItem);
}

// ─── Instrument master (read-only, not owner-scoped) ─────────────────────────
//
// Search and freshness read the scanner-maintained instrument master. They are
// deliberately not owner-scoped: the master is shared reference data and never
// contains Live Trade rows. Routes still require an authenticated owner.

export interface InstrumentMasterInfoDto {
  /** Newest `updated_at` among Kite-sourced NSE rows — not a sync timestamp. */
  latestInstrumentUpdateAt: string | null;
  activeInstrumentCount: number;
}

export interface InstrumentSearchResultDto {
  instrumentId: number;
  symbol: string;
  /** The same stored Kite trading symbol; kept for an explicit client field. */
  tradingSymbol: string;
  name: string | null;
  exchange: string;
  active: boolean;
  updatedAt: string | null;
}

function toIsoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : toIso(value);
}

function mapInstrumentSearch(row: DbRow): InstrumentSearchResultDto {
  const symbol = String(row.symbol);
  return {
    instrumentId: toNumber(row.instrument_id),
    symbol,
    tradingSymbol: symbol,
    name: row.company_name === null || row.company_name === undefined
      ? null
      : String(row.company_name),
    exchange: String(row.exchange),
    active: row.active === true,
    updatedAt: toIsoOrNull(row.updated_at),
  };
}

/**
 * `MAX(updated_at)` over Kite-sourced NSE rows. This is the newest individual
 * row update, not proof that a full sync completed: `bulkUpsert` writes chunks
 * as separate statements without a wrapping transaction, so an interrupted
 * sync can leave recent timestamps on a partial set of rows. There is no
 * dedicated sync-metadata table, so callers must not derive staleness from it.
 */
export async function getInstrumentMasterInfo(): Promise<InstrumentMasterInfoDto> {
  const db = liveTradeDb();
  try {
    const rows = await db.query(
      `-- lt:instrument-master-info
       SELECT
         (SELECT MAX(updated_at) FROM instruments
          WHERE source = 'kite' AND exchange = 'NSE') AS latest_instrument_update_at,
         (SELECT count(*) FROM instruments
          WHERE active = TRUE AND exchange = 'NSE') AS active_instrument_count`,
      []
    );
    const row = rows[0] ?? {};
    return {
      latestInstrumentUpdateAt: toIsoOrNull(row.latest_instrument_update_at),
      activeInstrumentCount: toNumber(row.active_instrument_count ?? 0),
    };
  } catch (error) {
    throw mapDbError(error);
  }
}

/**
 * Case-insensitive partial match on symbol or company name.
 *
 * `position()` with `upper()` treats `%` and `_` literally, so user input
 * cannot inject wildcard semantics. There is no symbol/name index in the
 * current schema; the scan is bounded by the active-NSE filter and LIMIT.
 */
export async function searchNseInstruments(
  query: string
): Promise<InstrumentSearchResultDto[]> {
  const db = liveTradeDb();
  try {
    const rows = await db.query(
      `-- lt:search-instruments
       SELECT instrument_id, symbol, exchange, company_name, active, updated_at
       FROM instruments
       WHERE active = TRUE
         AND exchange = 'NSE'
         AND (
           position(upper($1) in upper(symbol)) > 0
           OR position(upper($1) in upper(COALESCE(company_name, ''))) > 0
         )
       ORDER BY
         CASE
           WHEN upper(symbol) = upper($1) THEN 0
           WHEN position(upper($1) in upper(symbol)) = 1 THEN 1
           WHEN position(upper($1) in upper(symbol)) > 1 THEN 2
           ELSE 3
         END,
         symbol ASC
       LIMIT ${LIVE_TRADE_INSTRUMENT_SEARCH_LIMIT}`,
      [query]
    );
    return rows.map(mapInstrumentSearch);
  } catch (error) {
    throw mapDbError(error);
  }
}

// ─── Market snapshot: owner-selected instruments ────────────────────────────
//
// Quotes and zones only ever read instruments that are on the authenticated
// owner's board. The owner filter is in SQL, so a foreign instrument id yields
// no row and is reported as NOT_FOUND by the service.

export interface OwnerQuoteInstrumentDto {
  instrumentId: number;
  symbol: string;
}

/**
 * One bounded read (at most 200 rows because of the item limit) in saved order.
 * The route never performs a per-instrument lookup.
 */
export async function listOwnerQuoteInstruments(
  ownerId: LiveTradeOwnerId
): Promise<OwnerQuoteInstrumentDto[]> {
  assertOwner(ownerId);
  const db = liveTradeDb();
  try {
    const rows = await db.query(
      `-- lt:list-quote-instruments
       SELECT it.instrument_id, i.symbol
       FROM live_trade_items it
       JOIN instruments i ON i.instrument_id = it.instrument_id
       WHERE it.owner_user_id = $1
       ORDER BY it.sort_order ASC, it.item_id ASC`,
      [ownerId]
    );
    return rows.map((row) => ({
      instrumentId: toNumber(row.instrument_id),
      symbol: String(row.symbol),
    }));
  } catch (error) {
    throw mapDbError(error);
  }
}

// ─── Market snapshot: cooldown ───────────────────────────────────────────────

export interface QuoteCooldownClaimDto {
  allowed: boolean;
  /** Seconds until another request is accepted; 0 when allowed. */
  retryAfterSeconds: number;
  /** Database time of the accepted claim; null when rejected. */
  claimedAt: string | null;
}

/**
 * Owns the 5-second per-owner cooldown.
 *
 * The claim is a single atomic upsert. PostgreSQL serializes concurrent
 * claimants on the primary-key row: exactly one statement sees a stale
 * `last_request_at` and updates it; every other statement's `WHERE` fails and
 * returns no row. This works across server instances and holds no transaction
 * or row lock while the Kite request runs — `db.query` is autocommit.
 *
 * The rejected path is a separate small read used only to compute the retry
 * hint; it never changes state.
 */
export async function claimQuoteCooldown(
  ownerId: LiveTradeOwnerId
): Promise<QuoteCooldownClaimDto> {
  assertOwner(ownerId);
  const db = liveTradeDb();
  const cooldown = LIVE_TRADE_QUOTE_COOLDOWN_SECONDS;

  let rows: DbRow[];
  try {
    rows = await db.query(
      `-- lt:quote-cooldown:claim
       INSERT INTO live_trade_quote_state (owner_user_id, last_request_at, updated_at)
       VALUES ($1::text, NOW(), NOW())
       ON CONFLICT (owner_user_id) DO UPDATE
         SET last_request_at = NOW(), updated_at = NOW()
         WHERE live_trade_quote_state.last_request_at
               <= NOW() - make_interval(secs => $2::double precision)
       RETURNING last_request_at`,
      [ownerId, cooldown]
    );

    if (rows.length > 0) {
      return {
        allowed: true,
        retryAfterSeconds: 0,
        claimedAt: toIso(rows[0].last_request_at),
      };
    }

    const status = await db.query(
      `-- lt:quote-cooldown:status
       SELECT
         GREATEST(
           1,
           CEIL(EXTRACT(EPOCH FROM (
             last_request_at + make_interval(secs => $2::double precision) - NOW()
           )))
         )::int AS retry_after_seconds
       FROM live_trade_quote_state
       WHERE owner_user_id = $1`,
      [ownerId, cooldown]
    );

    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        toNumber(status[0]?.retry_after_seconds ?? 1)
      ),
      claimedAt: null,
    };
  } catch (error) {
    throw mapDbError(error);
  }
}

// ─── Zones: nearest demand/supply ────────────────────────────────────────────

export interface NearestZoneDto {
  instrumentId: number;
  symbol: string;
  preferredTimeframe: LiveTradeTimeframe | null;
  zoneId: string;
  side: ZoneSide;
  timeframe: Timeframe;
  pattern: Pattern;
  zoneLow: number;
  zoneHigh: number;
  proximal: number;
  distal: number;
  formationTs: string;
  formationScore: number;
  lifecycleState: LifecycleState;
  lastTouchTs: string | null;
  touchCount: number;
  createdAt: string;
}

function mapNearestZone(row: DbRow): NearestZoneDto {
  return {
    instrumentId: toNumber(row.instrument_id),
    symbol: String(row.symbol),
    preferredTimeframe:
      row.preferred_timeframe === null || row.preferred_timeframe === undefined
        ? null
        : (String(row.preferred_timeframe) as LiveTradeTimeframe),
    zoneId: String(row.zone_id),
    side: row.side as ZoneSide,
    timeframe: row.timeframe as Timeframe,
    pattern: row.pattern as Pattern,
    zoneLow: toNumber(row.zone_low),
    zoneHigh: toNumber(row.zone_high),
    proximal: toNumber(row.proximal),
    distal: toNumber(row.distal),
    formationTs: toIso(row.formation_ts),
    formationScore: toNumber(row.score),
    lifecycleState: row.lifecycle_state as LifecycleState,
    lastTouchTs: toIsoOrNull(row.last_touch_ts),
    touchCount: toNumber(row.touch_count),
    createdAt: toIso(row.created_at),
  };
}

/**
 * Picks, per owned instrument and side, exactly one eligible zone.
 *
 * Eligibility: the instrument is on the owner's board, the side matches, the
 * zone is not BROKEN, its proximal is a usable positive number, and — when a
 * current price is supplied for the instrument — the zone is on the correct
 * side of that price:
 *
 *   DEMAND: z.distal <= currentPrice
 *   SUPPLY: z.distal >= currentPrice
 *
 * Using the distal boundary intentionally keeps a zone that contains the
 * current price eligible. Ordering after eligibility:
 *
 *  1. preferred timeframe first (when the item has one),
 *  2. structural nearest — highest proximal for DEMAND, lowest for SUPPLY,
 *  3. newest formation, then zone id for a stable tie-break.
 *
 * A missing/invalid price leaves that instrument's selection structural. The
 * board and `/zones` always pass no prices; only `/quotes` passes the prices of
 * quotes it has already validated.
 *
 * BROKEN zones never participate. The query is one statement for all requested
 * instruments regardless of how many there are; there is no per-instrument
 * round trip.
 *
 * `timeframeOverride` is `true` when the caller supplied `timeframe`; a null
 * override then means "all timeframes". When false, each item's saved
 * timeframe is used (itself possibly NULL = Any).
 */
export async function getNearestZones(
  ownerId: LiveTradeOwnerId,
  instrumentIds: number[],
  timeframeOverride: LiveTradeTimeframe | null,
  hasTimeframeOverride: boolean,
  currentPrices?: ReadonlyMap<number, number> | null
): Promise<NearestZoneDto[]> {
  assertOwner(ownerId);
  if (instrumentIds.length === 0) return [];
  const db = liveTradeDb();

  const priceInstrumentIds: number[] = [];
  const priceValues: number[] = [];
  if (currentPrices) {
    for (const instrumentId of instrumentIds) {
      const price = currentPrices.get(instrumentId);
      if (
        typeof price === "number" &&
        Number.isFinite(price) &&
        price > 0
      ) {
        priceInstrumentIds.push(instrumentId);
        priceValues.push(price);
      }
    }
  }

  try {
    const rows = await db.query(
      `-- lt:zones:nearest
       WITH requested AS (
         SELECT it.instrument_id,
                CASE WHEN $4::boolean THEN $3::text ELSE it.timeframe END
                  AS preferred_timeframe,
                i.symbol,
                p.current_price
         FROM live_trade_items it
         JOIN instruments i ON i.instrument_id = it.instrument_id
         LEFT JOIN unnest($5::bigint[], $6::numeric[])
           AS p(instrument_id, current_price)
           ON p.instrument_id = it.instrument_id
         WHERE it.owner_user_id = $1
           AND it.instrument_id = ANY($2::bigint[])
       )
       SELECT r.instrument_id, r.symbol, r.preferred_timeframe,
              s.side AS request_side,
              z.zone_id, z.timeframe, z.pattern, z.side,
              z.zone_low, z.zone_high, z.proximal, z.distal,
              z.formation_ts, z.score, z.lifecycle_state,
              z.last_touch_ts, z.touch_count, z.created_at
       FROM requested r
       CROSS JOIN (VALUES ('DEMAND'::text), ('SUPPLY'::text)) AS s(side)
       LEFT JOIN LATERAL (
         SELECT z.zone_id, z.timeframe, z.pattern, z.side,
                z.zone_low, z.zone_high, z.proximal, z.distal,
                z.formation_ts, z.score, z.lifecycle_state,
                z.last_touch_ts, z.touch_count, z.created_at
         FROM zones z
         WHERE z.instrument_id = r.instrument_id
           AND z.side = s.side
           AND z.lifecycle_state <> 'BROKEN'
           AND z.proximal > 0
           AND z.proximal <> 'NaN'::numeric
           AND z.proximal <> 'Infinity'::numeric
           AND z.distal <> 'NaN'::numeric
           AND z.distal <> 'Infinity'::numeric
           AND z.distal <> '-Infinity'::numeric
           AND (
             r.current_price IS NULL
             OR (s.side = 'DEMAND' AND z.distal <= r.current_price)
             OR (s.side = 'SUPPLY' AND z.distal >= r.current_price)
           )
         ORDER BY
           CASE
             WHEN r.preferred_timeframe IS NOT NULL
              AND z.timeframe = r.preferred_timeframe THEN 0
             ELSE 1
           END,
           CASE WHEN s.side = 'DEMAND' THEN -z.proximal ELSE z.proximal END,
           z.formation_ts DESC,
           z.zone_id ASC
         LIMIT 1
       ) z ON TRUE
       ORDER BY r.instrument_id ASC, s.side ASC`,
      [
        ownerId,
        instrumentIds,
        timeframeOverride,
        hasTimeframeOverride,
        priceInstrumentIds,
        priceValues,
      ]
    );
    return rows
      .filter((row) => row.zone_id !== null && row.zone_id !== undefined)
      .map(mapNearestZone);
  } catch (error) {
    throw mapDbError(error);
  }
}

// ─── Zones: coverage evidence ────────────────────────────────────────────────

export interface ZoneCoverageRowDto {
  instrumentId: number;
  symbol: string;
  preferredTimeframe: LiveTradeTimeframe | null;
  inUniverse: boolean;
  zoneCount: number;
  activeZoneCount: number;
  latestZoneFormationAt: string | null;
  latestZoneCreatedAt: string | null;
  latestCoveringScanAt: string | null;
  hasAnySuccessScan: boolean;
  hasUnattributableScan: boolean;
}

/**
 * Per-instrument coverage evidence in one statement.
 *
 * A scan covers an instrument when it completed successfully and its
 * `instrument_ids` JSONB array contains the id, or when a successful
 * DETECT_ZONES batch in a successful job lists it. The batch fallback exists
 * for legacy or externally populated history only: the current scanner's batch
 * writer records an empty `instrument_ids` array for every batch, so live scans
 * are attributed through the job-level list. A job whose `completed_at` is
 * NULL is not evidence, and a null/empty instrument list stays conservative
 * (`has_unattributable_scan`) instead of producing a false `AVAILABLE`.
 */
export async function getZoneCoverage(
  ownerId: LiveTradeOwnerId,
  instrumentIds: number[]
): Promise<ZoneCoverageRowDto[]> {
  assertOwner(ownerId);
  if (instrumentIds.length === 0) return [];
  const db = liveTradeDb();

  try {
    const rows = await db.query(
      `-- lt:zones:coverage
       WITH requested AS (
         SELECT it.instrument_id, it.timeframe AS preferred_timeframe, i.symbol
         FROM live_trade_items it
         JOIN instruments i ON i.instrument_id = it.instrument_id
         WHERE it.owner_user_id = $1
           AND it.instrument_id = ANY($2::bigint[])
       ),
       universe AS (
         SELECT DISTINCT m.instrument_id
         FROM nifty500_membership m
         JOIN instruments i ON i.instrument_id = m.instrument_id
         WHERE m.effective_to IS NULL
           AND i.active = TRUE
           AND m.instrument_id = ANY($2::bigint[])
       ),
       zone_stats AS (
         SELECT z.instrument_id,
                count(*)::int AS zone_count,
                count(*) FILTER (WHERE z.lifecycle_state <> 'BROKEN')::int
                  AS active_zone_count,
                max(z.formation_ts) AS latest_zone_formation_at,
                max(z.created_at) AS latest_zone_created_at
         FROM zones z
         WHERE z.instrument_id = ANY($2::bigint[])
         GROUP BY z.instrument_id
       ),
       job_evidence AS (
         SELECT e.instrument_id,
                max(e.completed_at) AS latest_covering_scan_at
         FROM (
           SELECT r.instrument_id, j.completed_at
           FROM requested r
           JOIN scan_jobs j
             ON j.status = 'SUCCESS'
            AND j.completed_at IS NOT NULL
            AND j.instrument_ids @> to_jsonb(r.instrument_id)
           UNION ALL
           SELECT r.instrument_id, j.completed_at
           FROM requested r
           JOIN scan_job_batches b
             ON b.stage = 'DETECT_ZONES'
            AND b.status = 'SUCCESS'
            AND b.instrument_ids @> to_jsonb(r.instrument_id)
           JOIN scan_jobs j
             ON j.job_id = b.job_id
            AND j.status = 'SUCCESS'
            AND j.completed_at IS NOT NULL
         ) e
         GROUP BY e.instrument_id
       )
       SELECT r.instrument_id, r.symbol, r.preferred_timeframe,
              (u.instrument_id IS NOT NULL) AS in_universe,
              COALESCE(zs.zone_count, 0) AS zone_count,
              COALESCE(zs.active_zone_count, 0) AS active_zone_count,
              zs.latest_zone_formation_at, zs.latest_zone_created_at,
              je.latest_covering_scan_at,
              (SELECT EXISTS(
                 SELECT 1 FROM scan_jobs j
                 WHERE j.status = 'SUCCESS' AND j.completed_at IS NOT NULL
               )) AS has_any_success_scan,
              (SELECT EXISTS(
                 SELECT 1 FROM scan_jobs j
                 WHERE j.status = 'SUCCESS'
                   AND j.completed_at IS NOT NULL
                   AND j.instrument_ids IS NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM scan_job_batches b
                     WHERE b.job_id = j.job_id
                       AND b.stage = 'DETECT_ZONES'
                       AND b.status = 'SUCCESS'
                       AND b.instrument_ids <> '[]'::jsonb
                   )
               )) AS has_unattributable_scan
       FROM requested r
       LEFT JOIN universe u ON u.instrument_id = r.instrument_id
       LEFT JOIN zone_stats zs ON zs.instrument_id = r.instrument_id
       LEFT JOIN job_evidence je ON je.instrument_id = r.instrument_id
       ORDER BY r.instrument_id ASC`,
      [ownerId, instrumentIds]
    );

    return rows.map((row) => ({
      instrumentId: toNumber(row.instrument_id),
      symbol: String(row.symbol),
      preferredTimeframe:
        row.preferred_timeframe === null || row.preferred_timeframe === undefined
          ? null
          : (String(row.preferred_timeframe) as LiveTradeTimeframe),
      inUniverse: row.in_universe === true,
      zoneCount: toNumber(row.zone_count),
      activeZoneCount: toNumber(row.active_zone_count),
      latestZoneFormationAt: toIsoOrNull(row.latest_zone_formation_at),
      latestZoneCreatedAt: toIsoOrNull(row.latest_zone_created_at),
      latestCoveringScanAt: toIsoOrNull(row.latest_covering_scan_at),
      hasAnySuccessScan: row.has_any_success_scan === true,
      hasUnattributableScan: row.has_unattributable_scan === true,
    }));
  } catch (error) {
    throw mapDbError(error);
  }
}

// ─── Zones: expanded list (paginated) ───────────────────────────────────────

export interface ExpandedZoneDto {
  zoneId: string;
  instrumentId: number;
  symbol: string;
  timeframe: Timeframe;
  pattern: Pattern;
  side: ZoneSide;
  zoneLow: number;
  zoneHigh: number;
  proximal: number;
  distal: number;
  baseStart: string;
  baseEnd: string;
  legInTs: string;
  legOutTs: string;
  formationTs: string;
  formationScore: number;
  lifecycleState: LifecycleState;
  lastTouchTs: string | null;
  touchCount: number;
  configVersion: number;
  createdAt: string;
}

function mapExpandedZone(row: DbRow): ExpandedZoneDto {
  return {
    zoneId: String(row.zone_id),
    instrumentId: toNumber(row.instrument_id),
    symbol: String(row.symbol),
    timeframe: row.timeframe as Timeframe,
    pattern: row.pattern as Pattern,
    side: row.side as ZoneSide,
    zoneLow: toNumber(row.zone_low),
    zoneHigh: toNumber(row.zone_high),
    proximal: toNumber(row.proximal),
    distal: toNumber(row.distal),
    baseStart: toIso(row.base_start),
    baseEnd: toIso(row.base_end),
    legInTs: toIso(row.leg_in_ts),
    legOutTs: toIso(row.leg_out_ts),
    formationTs: toIso(row.formation_ts),
    formationScore: toNumber(row.score),
    lifecycleState: row.lifecycle_state as LifecycleState,
    lastTouchTs: toIsoOrNull(row.last_touch_ts),
    touchCount: toNumber(row.touch_count),
    configVersion: toNumber(row.config_version),
    createdAt: toIso(row.created_at),
  };
}

/**
 * Expanded list for one owned instrument. BROKEN zones are retained, no
 * Formation Score floor is applied, and the ordering is deterministic.
 *
 * The caller fetches `limit + 1` rows so `hasMore` needs no second COUNT query.
 * The ownership guard is part of the statement: a foreign instrument id
 * matches no `live_trade_items` row and returns an empty list.
 */
export async function listExpandedZones(
  ownerId: LiveTradeOwnerId,
  instrumentId: number,
  limitPlusOne: number,
  offset: number
): Promise<ExpandedZoneDto[]> {
  assertOwner(ownerId);
  const db = liveTradeDb();

  try {
    const rows = await db.query(
      `-- lt:zones:expanded
       SELECT z.zone_id, z.instrument_id, i.symbol, z.timeframe, z.pattern, z.side,
              z.base_start, z.base_end, z.leg_in_ts, z.leg_out_ts,
              z.zone_low, z.zone_high, z.proximal, z.distal,
              z.formation_ts, z.config_version, z.score, z.lifecycle_state,
              z.last_touch_ts, z.touch_count, z.created_at
       FROM zones z
       JOIN instruments i ON i.instrument_id = z.instrument_id
       WHERE z.instrument_id = $1
         AND EXISTS (
           SELECT 1 FROM live_trade_items it
           WHERE it.owner_user_id = $2 AND it.instrument_id = $1
         )
       ORDER BY z.formation_ts DESC, z.score DESC, z.zone_id ASC
       LIMIT $3 OFFSET $4`,
      [instrumentId, ownerId, limitPlusOne, offset]
    );
    return rows.map(mapExpandedZone);
  } catch (error) {
    throw mapDbError(error);
  }
}
