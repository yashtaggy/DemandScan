/**
 * Stateful in-memory stand-in for the Neon HTTP driver.
 *
 * The repository talks SQL, so the fake dispatches on the `-- lt:<marker>`
 * comment at the start of every statement and implements the same guards the
 * SQL does: owner scoping, version matching, per-owner limits, group ownership
 * and the case-insensitive group-name index.
 *
 * Transaction model:
 *  - A batch runs against a snapshot and commits only if every statement
 *    succeeds (an injected failure rolls the whole batch back).
 *  - A batch whose first statement is `lt:lock` is serialized per owner. The
 *    lock parameter is the owner id, mirroring `pg_advisory_xact_lock`. The
 *    fake records overlap so tests can assert the lock actually serialized.
 *  - Row locks declared by `lt:*-lock-rows`, `lt:delete-group:lock-row` and
 *    `lt:update-item:lock-group` are acquired before the batch executes and
 *    held until it commits or rolls back. Conflicting holders wait; key-share
 *    holders are mutually compatible.
 *  - Every dispatched statement asserts its exact bind-parameter count.
 *
 * This is a test double, not a PostgreSQL emulator: numeric/date semantics are
 * limited to what the repository reads back, and row locks are acquired up
 * front rather than at the statement that declares them.
 */

import type {
  LiveTradeDirection,
  LiveTradePriority,
  LiveTradeStatus,
  LiveTradeTimeframe,
} from "@/lib/live-trade/constants";

// ─── Rows ────────────────────────────────────────────────────────────────────

export interface FakeInstrumentRow {
  instrument_id: number;
  symbol: string;
  exchange: string;
  company_name: string | null;
  active: boolean;
  source: string;
  updated_at: Date;
}

export interface FakeGroupRow {
  group_id: string;
  owner_user_id: string;
  name: string;
  sort_order: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface FakeItemRow {
  item_id: string;
  owner_user_id: string;
  instrument_id: number;
  group_id: string | null;
  priority: LiveTradePriority;
  direction: LiveTradeDirection | null;
  timeframe: LiveTradeTimeframe | null;
  entry_price: number | null;
  target_price: number | null;
  stop_loss: number | null;
  notes: string;
  trade_status: LiveTradeStatus;
  sort_order: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export type FakeLifecycleState =
  | "CONFIRMED_FRESH"
  | "TOUCHED_ONCE"
  | "RETESTED"
  | "BROKEN";

export interface FakeZoneRow {
  zone_id: string;
  instrument_id: number;
  timeframe: LiveTradeTimeframe;
  pattern: "DBR" | "RBR" | "RBD" | "DBD";
  side: "DEMAND" | "SUPPLY";
  base_start: Date;
  base_end: Date;
  leg_in_ts: Date;
  leg_out_ts: Date;
  zone_low: number;
  zone_high: number;
  proximal: number;
  distal: number;
  formation_ts: Date;
  config_version: number;
  score: number;
  lifecycle_state: FakeLifecycleState;
  last_touch_ts: Date | null;
  touch_count: number;
  created_at: Date;
}

export interface FakeScanJobRow {
  job_id: string;
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
  completed_at: Date | null;
  /** Null mirrors legacy jobs created before checkpoint columns existed. */
  instrument_ids: number[] | null;
}

export interface FakeScanBatchRow {
  job_id: string;
  stage: string;
  status: "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";
  instrument_ids: number[];
}

export type FakeResult = Record<string, unknown>[];

// ─── Query descriptor ────────────────────────────────────────────────────────

export interface FakeQuery {
  readonly text: string;
  readonly params: unknown[];
  then: (
    onFulfilled?: (value: FakeResult) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => Promise<unknown>;
  catch: (onRejected?: (reason: unknown) => unknown) => Promise<unknown>;
}

export interface FakeStatementRecord {
  marker: string;
  params: unknown[];
}

export interface FakeTransactionRecord {
  connectionId: number;
  owner: string | null;
  markers: string[];
  statements: FakeStatementRecord[];
  committed: boolean;
}

export type FakeLockMode = "update" | "key_share";

interface FakeRowLock {
  mode: FakeLockMode;
  holders: Set<number>;
}

interface FakeRowLockRequest {
  key: string;
  mode: FakeLockMode;
}

export interface FakeEvent {
  connectionId: number;
  owner: string | null;
  kind: "begin" | "statement" | "commit" | "rollback";
  marker?: string;
}

// ─── Marker and helpers ──────────────────────────────────────────────────────

function markerOf(text: string): string {
  const match = text.match(/--\s*lt:([a-z0-9:-]+)/);
  return match ? match[1] : "unknown";
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function instrumentSearchRank(symbol: string, needle: string): number {
  const upper = symbol.toUpperCase();
  if (upper === needle) return 0;
  const index = upper.indexOf(needle);
  if (index === 0) return 1;
  if (index > 0) return 2;
  return 3;
}

function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`simulated database error ${code}`), {
    code,
    constraint,
  });
}

// ─── Fake database ───────────────────────────────────────────────────────────

export class FakeLiveTradeDb {
  groups: FakeGroupRow[] = [];
  items: FakeItemRow[] = [];
  instruments = new Map<number, FakeInstrumentRow>();
  zones: FakeZoneRow[] = [];
  /** Current Nifty 500 membership (effective_to IS NULL). */
  membership = new Set<number>();
  scanJobs: FakeScanJobRow[] = [];
  scanJobBatches: FakeScanBatchRow[] = [];
  /** Cooldown metadata keyed by owner. */
  quoteState = new Map<string, Date>();

  /** One record per transaction batch, committed or rolled back. */
  transactions: FakeTransactionRecord[] = [];
  /** Interleaving log used to prove lock ordering and serialization. */
  events: FakeEvent[] = [];
  /** Statements executed outside `transaction()` (list reads). */
  standaloneMarkers: string[] = [];

  maxConcurrentPerOwner = 0;

  private uuidCounter = 0;
  private connectionCounter = 0;
  private perOwnerChain = new Map<string, Promise<void>>();
  private activePerOwner = new Map<string, number>();
  private failures = new Map<string, Error[]>();
  private hooks = new Map<string, Array<() => void>>();
  private rowLocks = new Map<string, FakeRowLock>();
  private rowLockWaiters = new Map<string, Array<() => void>>();
  /** Database clock; tests move it to exercise cooldown/freshness boundaries. */
  private clock = new Date();

  /** Read-only SQL handle returned by the mocked `getDb()`. */
  readonly sql = {
    query: (text: string, params: unknown[] = []): FakeQuery =>
      this.makeQuery(text, params),
    transaction: (queries: FakeQuery[]): Promise<FakeResult[]> =>
      this.runTransaction(queries),
  };

  reset(): void {
    this.groups = [];
    this.items = [];
    this.instruments.clear();
    this.zones = [];
    this.membership.clear();
    this.scanJobs = [];
    this.scanJobBatches = [];
    this.quoteState.clear();
    this.transactions = [];
    this.events = [];
    this.standaloneMarkers = [];
    this.maxConcurrentPerOwner = 0;
    this.uuidCounter = 0;
    this.connectionCounter = 0;
    this.perOwnerChain.clear();
    this.activePerOwner.clear();
    this.failures.clear();
    this.hooks.clear();
    this.rowLocks.clear();
    this.rowLockWaiters.clear();
    this.clock = new Date();
  }

  /** Moves the fake database clock (used by cooldown/time-travel tests). */
  setNow(value: Date): void {
    this.clock = new Date(value);
  }

  advance(ms: number): void {
    this.clock = new Date(this.clock.getTime() + ms);
  }

  clockNow(): Date {
    return new Date(this.clock);
  }

  uuid(): string {
    this.uuidCounter += 1;
    return `00000000-0000-4000-8000-${this.uuidCounter
      .toString(16)
      .padStart(12, "0")}`;
  }

  seedInstrument(row: Partial<FakeInstrumentRow> & { instrument_id: number }): void {
    this.instruments.set(row.instrument_id, {
      instrument_id: row.instrument_id,
      symbol: row.symbol ?? `SYM${row.instrument_id}`,
      exchange: row.exchange ?? "NSE",
      company_name: row.company_name ?? null,
      active: row.active ?? true,
      source: row.source ?? "kite",
      updated_at: row.updated_at ?? new Date(),
    });
  }

  seedGroup(input: {
    owner: string;
    name: string;
    sortOrder?: number;
    version?: number;
  }): FakeGroupRow {
    const id = this.uuid();
    const now = new Date();
    const row: FakeGroupRow = {
      group_id: id,
      owner_user_id: input.owner,
      name: input.name,
      sort_order: input.sortOrder ?? this.nextGroupOrder(input.owner),
      version: input.version ?? 1,
      created_at: now,
      updated_at: now,
    };
    this.groups.push(row);
    return row;
  }

  seedItem(input: {
    owner: string;
    instrumentId: number;
    groupId?: string | null;
    priority?: LiveTradePriority;
    direction?: LiveTradeDirection | null;
    timeframe?: LiveTradeTimeframe | null;
    entryPrice?: number | null;
    targetPrice?: number | null;
    stopLoss?: number | null;
    notes?: string;
    tradeStatus?: LiveTradeStatus;
    sortOrder?: number;
    version?: number;
  }): FakeItemRow {
    const id = this.uuid();
    const now = new Date();
    const row: FakeItemRow = {
      item_id: id,
      owner_user_id: input.owner,
      instrument_id: input.instrumentId,
      group_id: input.groupId ?? null,
      priority: input.priority ?? "MEDIUM",
      direction: input.direction ?? null,
      timeframe: input.timeframe === undefined ? "1D" : input.timeframe,
      entry_price: input.entryPrice ?? null,
      target_price: input.targetPrice ?? null,
      stop_loss: input.stopLoss ?? null,
      notes: input.notes ?? "",
      trade_status: input.tradeStatus ?? "WATCHING",
      sort_order: input.sortOrder ?? this.nextItemOrder(input.owner),
      version: input.version ?? 1,
      created_at: now,
      updated_at: now,
    };
    this.items.push(row);
    return row;
  }

  seedZone(input: {
    instrumentId: number;
    side: "DEMAND" | "SUPPLY";
    timeframe?: LiveTradeTimeframe;
    pattern?: FakeZoneRow["pattern"];
    proximal?: number;
    distal?: number;
    zoneLow?: number;
    zoneHigh?: number;
    score?: number;
    lifecycle?: FakeLifecycleState;
    formationTs?: Date;
    createdAt?: Date;
    touchCount?: number;
    lastTouchTs?: Date | null;
    zoneId?: string;
  }): FakeZoneRow {
    const now = this.clockNow();
    const side = input.side;
    const proximal =
      input.proximal ?? (side === "DEMAND" ? 100 : 200);
    const distal =
      input.distal ?? (side === "DEMAND" ? proximal - 10 : proximal + 10);
    const row: FakeZoneRow = {
      zone_id: input.zoneId ?? this.uuid(),
      instrument_id: input.instrumentId,
      timeframe: input.timeframe ?? "1D",
      pattern: input.pattern ?? (side === "DEMAND" ? "DBR" : "RBD"),
      side,
      base_start: input.formationTs ?? now,
      base_end: input.formationTs ?? now,
      leg_in_ts: input.formationTs ?? now,
      leg_out_ts: input.formationTs ?? now,
      zone_low: input.zoneLow ?? Math.min(proximal, distal),
      zone_high: input.zoneHigh ?? Math.max(proximal, distal),
      proximal,
      distal,
      formation_ts: input.formationTs ?? now,
      config_version: 1,
      score: input.score ?? 60,
      lifecycle_state: input.lifecycle ?? "CONFIRMED_FRESH",
      last_touch_ts: input.lastTouchTs ?? null,
      touch_count: input.touchCount ?? 0,
      created_at: input.createdAt ?? input.formationTs ?? now,
    };
    this.zones.push(row);
    return row;
  }

  seedMembership(instrumentId: number): void {
    this.membership.add(instrumentId);
  }

  seedScanJob(input: {
    status: FakeScanJobRow["status"];
    completedAt?: Date | null;
    instrumentIds?: number[] | null;
  }): FakeScanJobRow {
    const row: FakeScanJobRow = {
      job_id: this.uuid(),
      status: input.status,
      completed_at: input.completedAt ?? null,
      instrument_ids:
        input.instrumentIds === undefined ? null : input.instrumentIds,
    };
    this.scanJobs.push(row);
    return row;
  }

  seedScanBatch(input: {
    jobId: string;
    stage?: string;
    status?: FakeScanBatchRow["status"];
    instrumentIds: number[];
  }): FakeScanBatchRow {
    const row: FakeScanBatchRow = {
      job_id: input.jobId,
      stage: input.stage ?? "DETECT_ZONES",
      status: input.status ?? "SUCCESS",
      instrument_ids: input.instrumentIds,
    };
    this.scanJobBatches.push(row);
    return row;
  }

  /** Injects a failure into the next execution of a marker. */
  failOnce(marker: string, error: Error = pgError("XX000")): void {
    const queue = this.failures.get(marker) ?? [];
    queue.push(error);
    this.failures.set(marker, queue);
  }

  /**
   * Runs a hook immediately before the next execution of a marker. Hooks model
   * changes committed by another backend (for example an instrument
   * deactivation) that land between two statements of the current batch.
   */
  beforeOnce(marker: string, hook: () => void): void {
    const queue = this.hooks.get(marker) ?? [];
    queue.push(hook);
    this.hooks.set(marker, queue);
  }

  /** Deactivates an instrument as an independent committed write. */
  deactivateInstrument(instrumentId: number): void {
    const instrument = this.instruments.get(instrumentId);
    if (instrument) instrument.active = false;
  }

  /** Row locks currently held, exposed for assertions. */
  heldRowLocks(): Array<{ key: string; mode: FakeLockMode; holders: number }> {
    return [...this.rowLocks.entries()].map(([key, lock]) => ({
      key,
      mode: lock.mode,
      holders: lock.holders.size,
    }));
  }

  groupById(groupId: string): FakeGroupRow | undefined {
    return this.groups.find((row) => row.group_id === groupId);
  }

  itemById(itemId: string): FakeItemRow | undefined {
    return this.items.find((row) => row.item_id === itemId);
  }

  // ── Query creation ─────────────────────────────────────────────────────────

  private makeQuery(text: string, params: unknown[]): FakeQuery {
    const query: FakeQuery = {
      text,
      params,
      then: (onFulfilled, onRejected) =>
        Promise.resolve()
          .then(() => this.runStandalone(text, params))
          .then(onFulfilled, onRejected),
      catch: (onRejected) =>
        Promise.resolve()
          .then(() => this.runStandalone(text, params))
          .catch(onRejected),
    };
    return query;
  }

  private runStandalone(text: string, params: unknown[]): FakeResult {
    const marker = markerOf(text);
    this.standaloneMarkers.push(marker);
    this.throwIfInjected(marker);
    return this.dispatch(marker, params);
  }

  // ── Transactions ───────────────────────────────────────────────────────────

  private async runTransaction(queries: FakeQuery[]): Promise<FakeResult[]> {
    const lockQuery = queries[0];
    const owner =
      lockQuery && markerOf(lockQuery.text) === "lock"
        ? String(lockQuery.params[0])
        : null;

    if (owner === null) return this.runWithRowLocks(queries, null);

    const previous = this.perOwnerChain.get(owner) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.perOwnerChain.set(
      owner,
      previous.then(() => gate)
    );

    await previous;

    const active = (this.activePerOwner.get(owner) ?? 0) + 1;
    this.activePerOwner.set(owner, active);
    this.maxConcurrentPerOwner = Math.max(this.maxConcurrentPerOwner, active);

    try {
      return await this.runWithRowLocks(queries, owner);
    } finally {
      this.activePerOwner.set(owner, (this.activePerOwner.get(owner) ?? 1) - 1);
      release();
    }
  }

  /**
   * Acquires every row lock the batch declares before the batch executes.
   *
   * This approximates PostgreSQL for the repository's statement order: each
   * lock statement is the first statement that touches its rows, so acquiring
   * it up front produces the same conflict outcome while keeping the fake's
   * batch execution synchronous. A conflicting holder makes the batch wait;
   * locks are released when the batch commits or rolls back.
   */
  private async runWithRowLocks(
    queries: FakeQuery[],
    owner: string | null
  ): Promise<FakeResult[]> {
    this.connectionCounter += 1;
    const connectionId = this.connectionCounter;
    const locks = this.locksFor(queries);

    await this.acquireRowLocks(locks, connectionId);
    try {
      // Yield once so a competing transaction can attempt to acquire.
      await Promise.resolve();
      return this.executeBatch(queries, owner, connectionId);
    } finally {
      this.releaseRowLocks(locks, connectionId);
    }
  }

  private executeBatch(
    queries: FakeQuery[],
    owner: string | null,
    connectionId: number
  ): FakeResult[] {
    const markers: string[] = [];
    const statements: FakeStatementRecord[] = [];
    const snapshot = {
      groups: this.groups.map((row) => ({ ...row })),
      items: this.items.map((row) => ({ ...row })),
    };

    this.events.push({ connectionId, owner, kind: "begin" });

    try {
      const results = queries.map((query) => {
        const marker = markerOf(query.text);
        markers.push(marker);
        statements.push({ marker, params: query.params });
        this.events.push({ connectionId, owner, kind: "statement", marker });
        this.runHooks(marker);
        this.throwIfInjected(marker);
        return this.dispatch(marker, query.params, snapshot);
      });

      this.groups = snapshot.groups;
      this.items = snapshot.items;
      this.transactions.push({
        connectionId,
        owner,
        markers,
        statements,
        committed: true,
      });
      this.events.push({ connectionId, owner, kind: "commit" });
      return results;
    } catch (error) {
      // Snapshot discarded: no partial writes.
      this.transactions.push({
        connectionId,
        owner,
        markers,
        statements,
        committed: false,
      });
      this.events.push({ connectionId, owner, kind: "rollback" });
      throw error;
    }
  }

  private runHooks(marker: string): void {
    const queue = this.hooks.get(marker);
    if (!queue || queue.length === 0) return;
    const hook = queue.shift() as () => void;
    hook();
  }

  private throwIfInjected(marker: string): void {
    const queue = this.failures.get(marker);
    if (!queue || queue.length === 0) return;
    const error = queue.shift() as Error;
    throw error;
  }

  // ── Row locks ──────────────────────────────────────────────────────────────

  private locksFor(queries: FakeQuery[]): FakeRowLockRequest[] {
    const requests: FakeRowLockRequest[] = [];

    for (const query of queries) {
      const marker = markerOf(query.text);
      if (marker === "delete-group:lock-row") {
        const [groupId, owner] = query.params as [string, string];
        if (
          this.groups.some(
            (group) =>
              group.group_id === groupId && group.owner_user_id === owner
          )
        ) {
          requests.push({ key: `groups:${groupId}`, mode: "update" });
        }
      } else if (marker === "reorder-groups:lock-rows") {
        const owner = String(query.params[0]);
        for (const group of this.groups) {
          if (group.owner_user_id === owner) {
            requests.push({ key: `groups:${group.group_id}`, mode: "update" });
          }
        }
      } else if (marker === "reorder-items:lock-rows") {
        const owner = String(query.params[0]);
        for (const item of this.items) {
          if (item.owner_user_id === owner) {
            requests.push({ key: `items:${item.item_id}`, mode: "update" });
          }
        }
      } else if (marker === "update-item:lock-group") {
        const [groupId, owner] = query.params as [string | null, string];
        if (
          groupId !== null &&
          this.groups.some(
            (group) =>
              group.group_id === groupId && group.owner_user_id === owner
          )
        ) {
          requests.push({ key: `groups:${groupId}`, mode: "key_share" });
        }
      }
    }

    requests.sort((a, b) => a.key.localeCompare(b.key));
    return requests;
  }

  private async acquireRowLocks(
    locks: FakeRowLockRequest[],
    connectionId: number
  ): Promise<void> {
    for (const lock of locks) {
      await this.acquireRowLock(lock, connectionId);
    }
  }

  private async acquireRowLock(
    lock: FakeRowLockRequest,
    connectionId: number
  ): Promise<void> {
    for (;;) {
      const current = this.rowLocks.get(lock.key);
      if (!current) {
        this.rowLocks.set(lock.key, {
          mode: lock.mode,
          holders: new Set([connectionId]),
        });
        return;
      }
      if (current.holders.has(connectionId)) return;
      if (current.mode === "key_share" && lock.mode === "key_share") {
        current.holders.add(connectionId);
        return;
      }
      await new Promise<void>((resolve) => {
        const waiters = this.rowLockWaiters.get(lock.key) ?? [];
        waiters.push(resolve);
        this.rowLockWaiters.set(lock.key, waiters);
      });
    }
  }

  private releaseRowLocks(
    locks: FakeRowLockRequest[],
    connectionId: number
  ): void {
    for (const lock of locks) {
      const current = this.rowLocks.get(lock.key);
      if (!current) continue;
      current.holders.delete(connectionId);
      if (current.holders.size > 0) continue;
      this.rowLocks.delete(lock.key);
      const waiters = this.rowLockWaiters.get(lock.key);
      this.rowLockWaiters.delete(lock.key);
      waiters?.forEach((resolve) => resolve());
    }
  }

  // ── Statement dispatch ─────────────────────────────────────────────────────

  private dispatch(
    marker: string,
    params: unknown[],
    tables?: { groups: FakeGroupRow[]; items: FakeItemRow[] }
  ): FakeResult {
    const groups = tables?.groups ?? this.groups;
    const items = tables?.items ?? this.items;
    const now = this.clockNow();

    switch (marker) {
      case "lock":
        this.expectParams(marker, params, 1);
        return [];

      case "list-groups":
        this.expectParams(marker, params, 1);
        return this.selectGroups(groups, String(params[0]));

      case "create-group:diagnostics": {
        this.expectParams(marker, params, 2);
        const [owner, name] = params as [string, string];
        return [
          {
            group_count: groups.filter((row) => row.owner_user_id === owner).length,
            name_taken: groups.some(
              (row) =>
                row.owner_user_id === owner &&
                normalizeName(row.name) === normalizeName(name)
            ),
          },
        ];
      }

      case "create-group:insert": {
        this.expectParams(marker, params, 3);
        const [groupId, owner, name] = params as [string, string, string];
        const owned = groups.filter((row) => row.owner_user_id === owner);
        if (owned.length >= 20) return [];
        if (
          owned.some(
            (row) => normalizeName(row.name) === normalizeName(name)
          )
        ) {
          return [];
        }
        const sortOrder =
          owned.length === 0
            ? 0
            : Math.max(...owned.map((row) => row.sort_order)) + 1;
        groups.push({
          group_id: groupId,
          owner_user_id: owner,
          name,
          sort_order: sortOrder,
          version: 1,
          created_at: now,
          updated_at: now,
        });
        return [{ group_id: groupId }];
      }

      case "create-group:read": {
        this.expectParams(marker, params, 2);
        const [groupId, owner] = params as [string, string];
        return this.selectGroups(groups, owner).filter(
          (row) => row.group_id === groupId
        );
      }

      case "update-group:update": {
        this.expectParams(marker, params, 4);
        const [groupId, owner, version, name] = params as [
          string,
          string,
          number,
          string
        ];
        const row = groups.find(
          (group) =>
            group.group_id === groupId &&
            group.owner_user_id === owner &&
            group.version === version
        );
        if (!row) return [];
        const duplicate = groups.some(
          (group) =>
            group.owner_user_id === owner &&
            group.group_id !== groupId &&
            normalizeName(group.name) === normalizeName(name)
        );
        if (duplicate) {
          throw pgError("23505", "live_trade_groups_owner_name_uq");
        }
        row.name = name;
        row.version += 1;
        row.updated_at = now;
        return [{ group_id: groupId }];
      }

      case "update-group:classify": {
        this.expectParams(marker, params, 2);
        const [groupId, owner] = params as [string, string];
        const row = groups.find(
          (group) =>
            group.group_id === groupId && group.owner_user_id === owner
        );
        return row ? [{ version: row.version }] : [];
      }

      case "update-group:read": {
        this.expectParams(marker, params, 2);
        const [groupId, owner] = params as [string, string];
        return this.selectGroups(groups, owner).filter(
          (row) => row.group_id === groupId
        );
      }

      case "reorder-groups:lock-rows": {
        this.expectParams(marker, params, 1);
        const owner = String(params[0]);
        return groups
          .filter((group) => group.owner_user_id === owner)
          .map((group) => ({ group_id: group.group_id }));
      }

      case "reorder-groups:update": {
        this.expectParams(marker, params, 2);
        const [owner, ids] = params as [string, string[]];
        return this.reorder(
          groups,
          (row) => row.owner_user_id === owner,
          (row) => row.group_id,
          ids,
          now
        );
      }

      case "reorder-groups:list":
        this.expectParams(marker, params, 1);
        return this.selectGroups(groups, String(params[0]));

      case "delete-group:lock-row": {
        this.expectParams(marker, params, 2);
        const [groupId, owner] = params as [string, string];
        return groups
          .filter(
            (group) =>
              group.group_id === groupId && group.owner_user_id === owner
          )
          .map((group) => ({ group_id: group.group_id }));
      }

      case "delete-group:ungroup": {
        this.expectParams(marker, params, 3);
        const [owner, groupId, version] = params as [string, string, number];
        const group = groups.find(
          (row) =>
            row.group_id === groupId &&
            row.owner_user_id === owner &&
            row.version === version
        );
        if (!group) return [];
        for (const item of items) {
          if (item.owner_user_id === owner && item.group_id === groupId) {
            item.group_id = null;
            item.version += 1;
            item.updated_at = now;
          }
        }
        return [];
      }

      case "delete-group:delete": {
        this.expectParams(marker, params, 3);
        const [owner, groupId, version] = params as [string, string, number];
        const index = groups.findIndex(
          (row) =>
            row.group_id === groupId &&
            row.owner_user_id === owner &&
            row.version === version
        );
        if (index === -1) return [];
        if (items.some((item) => item.group_id === groupId)) {
          throw pgError("23503", "live_trade_items_group_owner_fk");
        }
        groups.splice(index, 1);
        return [{ group_id: groupId }];
      }

      case "delete-group:classify": {
        this.expectParams(marker, params, 2);
        const [owner, groupId] = params as [string, string];
        const row = groups.find(
          (group) =>
            group.group_id === groupId && group.owner_user_id === owner
        );
        return row ? [{ version: row.version }] : [];
      }

      case "list-items":
        this.expectParams(marker, params, 1);
        return this.selectItems(items, String(params[0]));

      case "create-item:classify": {
        this.expectParams(marker, params, 3);
        const [owner, groupId, instrumentId] = params as [
          string,
          string | null,
          number
        ];
        const instrument = this.instruments.get(Number(instrumentId));
        return [
          {
            instrument_exists: Boolean(instrument),
            instrument_active: instrument?.active ?? false,
            instrument_exchange: instrument?.exchange ?? null,
            group_owned:
              groupId === null ||
              groups.some(
                (group) =>
                  group.group_id === groupId && group.owner_user_id === owner
              ),
            item_count: items.filter((item) => item.owner_user_id === owner)
              .length,
          },
        ];
      }

      case "create-item:insert": {
        this.expectParams(marker, params, 12);
        const [
          itemId,
          owner,
          groupId,
          priority,
          direction,
          timeframe,
          entryPrice,
          targetPrice,
          stopLoss,
          notes,
          tradeStatus,
          instrumentId,
        ] = params as [
          string,
          string,
          string | null,
          LiveTradePriority,
          LiveTradeDirection | null,
          LiveTradeTimeframe | null,
          number | null,
          number | null,
          number | null,
          string,
          LiveTradeStatus,
          number
        ];
        const instrument = this.instruments.get(Number(instrumentId));
        if (!instrument || !instrument.active) return [];
        if (instrument.exchange !== "NSE") return [];
        if (
          groupId !== null &&
          !groups.some(
            (group) =>
              group.group_id === groupId && group.owner_user_id === owner
          )
        ) {
          return [];
        }
        const owned = items.filter((item) => item.owner_user_id === owner);
        if (owned.length >= 200) return [];
        const sortOrder =
          owned.length === 0
            ? 0
            : Math.max(...owned.map((item) => item.sort_order)) + 1;
        items.push({
          item_id: itemId,
          owner_user_id: owner,
          instrument_id: Number(instrumentId),
          group_id: groupId,
          priority,
          direction,
          timeframe,
          entry_price: entryPrice,
          target_price: targetPrice,
          stop_loss: stopLoss,
          notes,
          trade_status: tradeStatus,
          sort_order: sortOrder,
          version: 1,
          created_at: now,
          updated_at: now,
        });
        return [{ item_id: itemId }];
      }

      case "create-item:read": {
        this.expectParams(marker, params, 2);
        const [itemId, owner] = params as [string, string];
        return this.selectItems(items, owner).filter(
          (row) => row.item_id === itemId
        );
      }

      case "update-item:lock-group": {
        this.expectParams(marker, params, 2);
        const [groupId, owner] = params as [string | null, string];
        if (groupId === null) return [];
        return groups
          .filter(
            (group) =>
              group.group_id === groupId && group.owner_user_id === owner
          )
          .map((group) => ({ group_id: group.group_id }));
      }

      case "update-item:update": {
        this.expectParams(marker, params, 4);
        const [itemId, owner, version, patchJson] = params as [
          string,
          string,
          number,
          string
        ];
        const row = items.find(
          (item) =>
            item.item_id === itemId &&
            item.owner_user_id === owner &&
            item.version === version
        );
        if (!row) return [];

        const patch = JSON.parse(patchJson) as Record<string, unknown>;

        if ("groupId" in patch) {
          const groupId =
            patch.groupId === null ? null : String(patch.groupId);
          if (
            groupId !== null &&
            !groups.some(
              (group) =>
                group.group_id === groupId && group.owner_user_id === owner
            )
          ) {
            return [];
          }
          row.group_id = groupId;
        }
        if ("priority" in patch) {
          row.priority = patch.priority as LiveTradePriority;
        }
        if ("direction" in patch) {
          row.direction = patch.direction as LiveTradeDirection | null;
        }
        if ("timeframe" in patch) {
          row.timeframe = patch.timeframe as LiveTradeTimeframe | null;
        }
        if ("entryPrice" in patch) {
          row.entry_price = patch.entryPrice as number | null;
        }
        if ("targetPrice" in patch) {
          row.target_price = patch.targetPrice as number | null;
        }
        if ("stopLoss" in patch) {
          row.stop_loss = patch.stopLoss as number | null;
        }
        if ("notes" in patch) {
          row.notes = String(patch.notes);
        }
        if ("tradeStatus" in patch) {
          row.trade_status = patch.tradeStatus as LiveTradeStatus;
        }
        row.version += 1;
        row.updated_at = now;
        return [{ item_id: itemId }];
      }

      case "update-item:classify": {
        this.expectParams(marker, params, 3);
        const [itemId, owner, requestedGroupId] = params as [
          string,
          string,
          string | null
        ];
        const row = items.find(
          (item) =>
            item.item_id === itemId && item.owner_user_id === owner
        );
        if (!row) return [];
        return [
          {
            version: row.version,
            group_owned:
              requestedGroupId === null ||
              groups.some(
                (group) =>
                  group.group_id === requestedGroupId &&
                  group.owner_user_id === owner
              ),
          },
        ];
      }

      case "update-item:read": {
        this.expectParams(marker, params, 2);
        const [itemId, owner] = params as [string, string];
        return this.selectItems(items, owner).filter(
          (row) => row.item_id === itemId
        );
      }

      case "delete-item:delete": {
        this.expectParams(marker, params, 3);
        const [itemId, owner, version] = params as [string, string, number];
        const index = items.findIndex(
          (item) =>
            item.item_id === itemId &&
            item.owner_user_id === owner &&
            item.version === version
        );
        if (index === -1) return [];
        items.splice(index, 1);
        return [{ item_id: itemId }];
      }

      case "delete-item:classify": {
        this.expectParams(marker, params, 2);
        const [itemId, owner] = params as [string, string];
        const row = items.find(
          (item) =>
            item.item_id === itemId && item.owner_user_id === owner
        );
        return row ? [{ version: row.version }] : [];
      }

      case "reorder-items:lock-rows": {
        this.expectParams(marker, params, 1);
        const owner = String(params[0]);
        return items
          .filter((item) => item.owner_user_id === owner)
          .map((item) => ({ item_id: item.item_id }));
      }

      case "reorder-items:update": {
        this.expectParams(marker, params, 2);
        const [owner, ids] = params as [string, string[]];
        return this.reorder(
          items,
          (row) => row.owner_user_id === owner,
          (row) => row.item_id,
          ids,
          now
        );
      }

      case "reorder-items:list":
        this.expectParams(marker, params, 1);
        return this.selectItems(items, String(params[0]));

      case "instrument-master-info": {
        this.expectParams(marker, params, 0);
        const nse = [...this.instruments.values()].filter(
          (row) => row.exchange === "NSE"
        );
        const lastSynced = nse
          .filter((row) => row.source === "kite")
          .reduce<Date | null>(
            (max, row) => (max === null || row.updated_at > max ? row.updated_at : max),
            null
          );
        return [
          {
            latest_instrument_update_at: lastSynced,
            active_instrument_count: nse.filter((row) => row.active).length,
          },
        ];
      }

      case "search-instruments": {
        this.expectParams(marker, params, 1);
        const needle = String(params[0]).toUpperCase();
        return [...this.instruments.values()]
          .filter(
            (row) =>
              row.active &&
              row.exchange === "NSE" &&
              (row.symbol.toUpperCase().includes(needle) ||
                (row.company_name ?? "").toUpperCase().includes(needle))
          )
          .sort(
            (a, b) =>
              instrumentSearchRank(a.symbol, needle) -
                instrumentSearchRank(b.symbol, needle) ||
              a.symbol.localeCompare(b.symbol)
          )
          .slice(0, 20)
          .map((row) => ({ ...row }));
      }

      case "list-quote-instruments": {
        this.expectParams(marker, params, 1);
        const owner = String(params[0]);
        return items
          .filter((item) => item.owner_user_id === owner)
          .sort(
            (a, b) =>
              a.sort_order - b.sort_order || a.item_id.localeCompare(b.item_id)
          )
          .map((item) => ({
            instrument_id: item.instrument_id,
            symbol: this.instruments.get(item.instrument_id)?.symbol ?? "",
          }));
      }

      // Standalone statements execute synchronously, so the read-check-write
      // below cannot interleave between concurrent requests. That mirrors the
      // single atomic upsert PostgreSQL runs for the real claim.
      case "quote-cooldown:claim": {
        this.expectParams(marker, params, 2);
        const owner = String(params[0]);
        const seconds = Number(params[1]);
        const nowMs = this.clock.getTime();
        const last = this.quoteState.get(owner);
        if (last && last.getTime() > nowMs - seconds * 1000) return [];
        const claimed = new Date(nowMs);
        this.quoteState.set(owner, claimed);
        return [{ last_request_at: claimed }];
      }

      case "quote-cooldown:status": {
        this.expectParams(marker, params, 2);
        const owner = String(params[0]);
        const seconds = Number(params[1]);
        const last = this.quoteState.get(owner);
        if (!last) return [{ retry_after_seconds: 1 }];
        return [
          {
            retry_after_seconds: Math.max(
              1,
              Math.ceil(
                (last.getTime() + seconds * 1000 - this.clock.getTime()) / 1000
              )
            ),
          },
        ];
      }

      case "zones:nearest": {
        this.expectParams(marker, params, 6);
        const [
          owner,
          rawIds,
          rawOverride,
          hasOverride,
          rawPriceIds,
          rawPrices,
        ] = params as [
          string,
          number[],
          string | null,
          boolean,
          number[],
          number[]
        ];
        const ids = new Set(rawIds.map(Number));
        const prices = new Map<number, number>();
        rawPriceIds.forEach((id, index) => {
          const price = rawPrices[index];
          if (
            typeof price === "number" &&
            Number.isFinite(price) &&
            price > 0
          ) {
            prices.set(Number(id), price);
          }
        });
        const requested = items
          .filter(
            (item) =>
              item.owner_user_id === owner && ids.has(item.instrument_id)
          )
          .sort(
            (a, b) =>
              a.sort_order - b.sort_order || a.item_id.localeCompare(b.item_id)
          );

        const result: FakeResult = [];
        for (const item of requested) {
          const symbol = this.instruments.get(item.instrument_id)?.symbol ?? "";
          const preferred = hasOverride
            ? rawOverride === null
              ? null
              : String(rawOverride)
            : item.timeframe;
          const currentPrice = prices.get(item.instrument_id) ?? null;

          for (const side of ["DEMAND", "SUPPLY"] as const) {
            const candidates = this.zones.filter(
              (zone) =>
                zone.instrument_id === item.instrument_id &&
                zone.side === side &&
                zone.lifecycle_state !== "BROKEN" &&
                zone.proximal > 0 &&
                Number.isFinite(zone.proximal) &&
                Number.isFinite(zone.distal) &&
                (currentPrice === null ||
                  (side === "DEMAND"
                    ? zone.distal <= currentPrice
                    : zone.distal >= currentPrice))
            );
            const rank = (zone: FakeZoneRow): number =>
              preferred !== null && zone.timeframe === preferred ? 0 : 1;
            candidates.sort(
              (a, b) =>
                rank(a) - rank(b) ||
                (side === "DEMAND"
                  ? b.proximal - a.proximal
                  : a.proximal - b.proximal) ||
                b.formation_ts.getTime() - a.formation_ts.getTime() ||
                a.zone_id.localeCompare(b.zone_id)
            );
            const zone = candidates[0];
            if (!zone) continue;

            result.push({
              instrument_id: item.instrument_id,
              symbol,
              preferred_timeframe: preferred,
              request_side: side,
              zone_id: zone.zone_id,
              timeframe: zone.timeframe,
              pattern: zone.pattern,
              side: zone.side,
              zone_low: zone.zone_low,
              zone_high: zone.zone_high,
              proximal: zone.proximal,
              distal: zone.distal,
              formation_ts: zone.formation_ts,
              score: zone.score,
              lifecycle_state: zone.lifecycle_state,
              last_touch_ts: zone.last_touch_ts,
              touch_count: zone.touch_count,
              created_at: zone.created_at,
            });
          }
        }
        return result;
      }

      case "zones:coverage": {
        this.expectParams(marker, params, 2);
        const [owner, rawIds] = params as [string, number[]];
        const ids = new Set(rawIds.map(Number));
        const requested = items
          .filter(
            (item) =>
              item.owner_user_id === owner && ids.has(item.instrument_id)
          )
          .sort(
            (a, b) =>
              a.sort_order - b.sort_order || a.item_id.localeCompare(b.item_id)
          );

        const hasAnySuccessScan = this.scanJobs.some(
          (job) => job.status === "SUCCESS" && job.completed_at !== null
        );
        const hasUnattributableScan = this.scanJobs.some(
          (job) =>
            job.status === "SUCCESS" &&
            job.completed_at !== null &&
            job.instrument_ids === null &&
            !this.scanJobBatches.some(
              (batch) =>
                batch.job_id === job.job_id &&
                batch.stage === "DETECT_ZONES" &&
                batch.status === "SUCCESS" &&
                batch.instrument_ids.length > 0
            )
        );

        const latest = (dates: Date[]): Date | null =>
          dates.length === 0
            ? null
            : new Date(Math.max(...dates.map((date) => date.getTime())));

        return requested.map((item) => {
          const instrument = this.instruments.get(item.instrument_id);
          const zoneRows = this.zones.filter(
            (zone) => zone.instrument_id === item.instrument_id
          );

          const jobEvidence = this.scanJobs
            .filter(
              (job) =>
                job.status === "SUCCESS" &&
                job.completed_at !== null &&
                job.instrument_ids !== null &&
                job.instrument_ids.includes(item.instrument_id)
            )
            .map((job) => job.completed_at as Date);

          const batchEvidence = this.scanJobBatches
            .filter(
              (batch) =>
                batch.stage === "DETECT_ZONES" &&
                batch.status === "SUCCESS" &&
                batch.instrument_ids.includes(item.instrument_id)
            )
            .map((batch) => {
              const job = this.scanJobs.find(
                (candidate) => candidate.job_id === batch.job_id
              );
              return job && job.status === "SUCCESS" ? job.completed_at : null;
            })
            .filter((date): date is Date => date !== null);

          return {
            instrument_id: item.instrument_id,
            symbol: instrument?.symbol ?? "",
            preferred_timeframe: item.timeframe,
            in_universe:
              this.membership.has(item.instrument_id) &&
              instrument?.active === true,
            zone_count: zoneRows.length,
            active_zone_count: zoneRows.filter(
              (zone) => zone.lifecycle_state !== "BROKEN"
            ).length,
            latest_zone_formation_at: latest(
              zoneRows.map((zone) => zone.formation_ts)
            ),
            latest_zone_created_at: latest(
              zoneRows.map((zone) => zone.created_at)
            ),
            latest_covering_scan_at: latest([
              ...jobEvidence,
              ...batchEvidence,
            ]),
            has_any_success_scan: hasAnySuccessScan,
            has_unattributable_scan: hasUnattributableScan,
          };
        });
      }

      case "zones:expanded": {
        this.expectParams(marker, params, 4);
        const [instrumentId, owner, limitPlusOne, offset] = params as [
          number,
          string,
          number,
          number
        ];
        const owned = items.some(
          (item) =>
            item.owner_user_id === owner &&
            item.instrument_id === Number(instrumentId)
        );
        if (!owned) return [];
        const symbol = this.instruments.get(Number(instrumentId))?.symbol ?? "";
        return this.zones
          .filter((zone) => zone.instrument_id === Number(instrumentId))
          .sort(
            (a, b) =>
              b.formation_ts.getTime() - a.formation_ts.getTime() ||
              b.score - a.score ||
              a.zone_id.localeCompare(b.zone_id)
          )
          .slice(offset, offset + limitPlusOne)
          .map((zone) => ({ ...zone, symbol }));
      }

      default:
        throw new Error(`fake-db: unhandled marker ${marker}`);
    }
  }

  private expectParams(
    marker: string,
    params: unknown[],
    expected: number
  ): void {
    if (params.length !== expected) {
      throw new Error(
        `fake-db: ${marker} expected ${expected} bind parameters, received ${params.length}`
      );
    }
  }

  // ── Shared select/reorder helpers ──────────────────────────────────────────

  private selectGroups(groups: FakeGroupRow[], owner: string): FakeResult {
    return groups
      .filter((row) => row.owner_user_id === owner)
      .sort(
        (a, b) =>
          a.sort_order - b.sort_order || a.group_id.localeCompare(b.group_id)
      )
      .map((row) => ({ ...row }));
  }

  private selectItems(items: FakeItemRow[], owner: string): FakeResult {
    return items
      .filter((row) => row.owner_user_id === owner)
      .sort(
        (a, b) =>
          a.sort_order - b.sort_order || a.item_id.localeCompare(b.item_id)
      )
      .map((row) => ({
        ...row,
        symbol: this.instruments.get(row.instrument_id)?.symbol ?? "",
        company_name: this.instruments.get(row.instrument_id)?.company_name ?? null,
      }));
  }

  private reorder<T extends { sort_order: number; version: number; updated_at: Date }>(
    rows: T[],
    isOwned: (row: T) => boolean,
    idOf: (row: T) => string,
    ids: string[],
    now: Date
  ): FakeResult {
    const owned = rows.filter(isOwned);
    const distinct = new Set(ids).size;
    const countOk = owned.length === ids.length;
    const distinctOk = distinct === ids.length;
    const ownedOk = ids.every((id) => owned.some((row) => idOf(row) === id));
    const ok = countOk && distinctOk && ownedOk;

    let updatedCount = 0;
    if (ok) {
      ids.forEach((id, index) => {
        const row = owned.find((candidate) => idOf(candidate) === id) as T;
        row.sort_order = index;
        row.version += 1;
        row.updated_at = now;
        updatedCount += 1;
      });
    }

    return [
      {
        ok,
        updated_count: updatedCount,
        expected_count: ids.length,
      },
    ];
  }

  private nextGroupOrder(owner: string): number {
    const owned = this.groups.filter((row) => row.owner_user_id === owner);
    return owned.length === 0
      ? 0
      : Math.max(...owned.map((row) => row.sort_order)) + 1;
  }

  private nextItemOrder(owner: string): number {
    const owned = this.items.filter((row) => row.owner_user_id === owner);
    return owned.length === 0
      ? 0
      : Math.max(...owned.map((row) => row.sort_order)) + 1;
  }
}
