/**
 * Staging integration test harness.
 *
 * Seeds and removes ONLY rows belonging to one run, using a reserved
 * synthetic instrument range and ZZTEST-prefixed symbols. All SQL runs through
 * the real Neon HTTP driver; application code is exercised through the real
 * repository/service/route modules.
 *
 * No TRUNCATE and no owner-wide deletes outside the run's synthetic owners.
 */

import { randomUUID } from "crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { LiveTradeOwnerId } from "@/lib/live-trade/types";

export const SYNTHETIC_OWNER_PREFIX = "zztest-";
export const SYNTHETIC_INSTRUMENT_BASE = 9_100_000_000_000;
const SYNTHETIC_INSTRUMENT_STRIDE = 10;

export type Sql = NeonQueryFunction<false, false>;
type Row = Record<string, unknown>;

export interface SyntheticInstrument {
  id: number;
  symbol: string;
  active: boolean;
  exchange: string;
}

export interface ZoneSeed {
  side: "DEMAND" | "SUPPLY";
  timeframe: "1D" | "1W";
  proximal: number;
  distal: number;
  lifecycle?: string;
  formationDaysAgo?: number;
  score?: number;
}

export interface ScanJobSeed {
  instrumentIds: number[] | null;
  completedAt: Date;
  viaBatch?: boolean;
  batchInstrumentIds?: number[];
}

function runOffset(runId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < runId.length; index += 1) {
    hash ^= runId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 1_000_000;
}

/**
 * Cleanup safety invariant: every identifier it deletes by must belong to the
 * reserved synthetic space. A future harness edit that widens the scope fails
 * here instead of touching real rows.
 */
export function assertSyntheticOwners(owners: string[]): void {
  for (const owner of owners) {
    if (
      !owner.startsWith(SYNTHETIC_OWNER_PREFIX) ||
      owner.length <= SYNTHETIC_OWNER_PREFIX.length
    ) {
      throw new Error(
        "Refusing staging cleanup: owner is not a synthetic ZZTEST identifier."
      );
    }
  }
}

export function assertSyntheticInstrumentIds(ids: number[]): void {
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < SYNTHETIC_INSTRUMENT_BASE) {
      throw new Error(
        "Refusing staging cleanup: instrument id is outside the reserved range."
      );
    }
  }
}

function symbolFor(runId: string, suffix: string): string {
  return `ZZTEST${runId.slice(0, 8).toUpperCase()}${suffix}`;
}

export class StagingRun {
  readonly sql: Sql;
  readonly runId: string;
  readonly ownerA: LiveTradeOwnerId;
  readonly ownerB: LiveTradeOwnerId;
  readonly instrumentIds: Record<
    "active" | "active2" | "inactive" | "nonNse" | "outside" | "noHistory" | "stale" | "noZones",
    number
  >;
  readonly symbols: Record<
    "active" | "active2" | "inactive" | "nonNse" | "outside" | "noHistory" | "stale" | "noZones",
    string
  >;

  readonly configId: string;

  private readonly instruments = new Set<number>();
  private readonly zoneIds = new Set<string>();
  private readonly jobIds = new Set<string>();
  private readonly batchIds = new Set<string>();

  constructor(sql: Sql, runId: string) {
    const offset = runOffset(runId);
    const base = SYNTHETIC_INSTRUMENT_BASE + offset * SYNTHETIC_INSTRUMENT_STRIDE;

    this.sql = sql;
    this.runId = runId;
    this.ownerA = `${SYNTHETIC_OWNER_PREFIX}${runId}-a` as LiveTradeOwnerId;
    this.ownerB = `${SYNTHETIC_OWNER_PREFIX}${runId}-b` as LiveTradeOwnerId;

    this.instrumentIds = {
      active: base + 1,
      active2: base + 2,
      inactive: base + 3,
      nonNse: base + 4,
      outside: base + 5,
      noHistory: base + 6,
      stale: base + 7,
      noZones: base + 8,
    };

    this.symbols = {
      active: symbolFor(runId, "A"),
      active2: symbolFor(runId, "B"),
      inactive: symbolFor(runId, "C"),
      nonNse: symbolFor(runId, "D"),
      outside: symbolFor(runId, "E"),
      noHistory: symbolFor(runId, "F"),
      stale: symbolFor(runId, "G"),
      noZones: symbolFor(runId, "H"),
    };

    this.configId = randomUUID();
  }

  async seedBase(): Promise<void> {
    const entries: Array<[keyof StagingRun["instrumentIds"], boolean, string]> = [
      ["active", true, "NSE"],
      ["active2", true, "NSE"],
      ["inactive", false, "NSE"],
      ["nonNse", true, "BSE"],
      ["outside", true, "NSE"],
      ["noHistory", true, "NSE"],
      ["stale", true, "NSE"],
      ["noZones", true, "NSE"],
    ];

    for (const [key, active, exchange] of entries) {
      await this.addInstrument({
        id: this.instrumentIds[key],
        symbol: this.symbols[key],
        active,
        exchange,
      });
    }

    // In-universe: active, active2, outside is excluded deliberately.
    for (const key of ["active", "active2", "noHistory", "stale", "noZones"] as const) {
      await this.addUniverseMember(this.instrumentIds[key]);
    }

    await this.addScannerConfig();

    // Recent job-level evidence.
    await this.addScanJob({
      instrumentIds: [this.instrumentIds.active],
      completedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    // Evidence attributed only through a successful DETECT_ZONES batch.
    await this.addScanJob({
      instrumentIds: null,
      completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      viaBatch: true,
      batchInstrumentIds: [this.instrumentIds.active2],
    });
    // Outside-universe instrument still has scan evidence.
    await this.addScanJob({
      instrumentIds: [this.instrumentIds.outside],
      completedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    // Stale evidence (older than the 7-day freshness window).
    await this.addScanJob({
      instrumentIds: [this.instrumentIds.stale],
      completedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    // Fresh evidence with no zones.
    await this.addScanJob({
      instrumentIds: [this.instrumentIds.noZones],
      completedAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    });

    // active: multiple demand/supply zones, including price-ineligible and broken ones.
    await this.addZone(this.instrumentIds.active, {
      side: "DEMAND",
      timeframe: "1D",
      proximal: 95,
      distal: 90,
      formationDaysAgo: 1,
    });
    await this.addZone(this.instrumentIds.active, {
      side: "SUPPLY",
      timeframe: "1D",
      proximal: 105,
      distal: 110,
      formationDaysAgo: 2,
    });
    await this.addZone(this.instrumentIds.active, {
      side: "DEMAND",
      timeframe: "1W",
      proximal: 98,
      distal: 96,
      formationDaysAgo: 3,
    });
    await this.addZone(this.instrumentIds.active, {
      side: "DEMAND",
      timeframe: "1D",
      proximal: 101,
      distal: 101,
      formationDaysAgo: 4,
    });
    await this.addZone(this.instrumentIds.active, {
      side: "SUPPLY",
      timeframe: "1D",
      proximal: 99,
      distal: 99,
      formationDaysAgo: 5,
    });
    await this.addZone(this.instrumentIds.active, {
      side: "SUPPLY",
      timeframe: "1W",
      proximal: 115,
      distal: 120,
      formationDaysAgo: 7,
    });
    await this.addZone(this.instrumentIds.active, {
      side: "DEMAND",
      timeframe: "1D",
      proximal: 97,
      distal: 94,
      lifecycle: "BROKEN",
      formationDaysAgo: 6,
    });

    await this.addZone(this.instrumentIds.active2, {
      side: "DEMAND",
      timeframe: "1D",
      proximal: 90,
      distal: 88,
      formationDaysAgo: 1,
    });
    await this.addZone(this.instrumentIds.stale, {
      side: "DEMAND",
      timeframe: "1D",
      proximal: 50,
      distal: 48,
      formationDaysAgo: 40,
    });
  }

  async addInstrument(input: SyntheticInstrument): Promise<void> {
    await this.sql.query(
      `INSERT INTO instruments
         (instrument_id, symbol, exchange, company_name, active, source, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'zztest-staging', NOW())`,
      [
        input.id,
        input.symbol,
        input.exchange,
        `ZZTEST ${input.symbol}`,
        input.active,
      ]
    );
    this.instruments.add(input.id);
  }

  async addUniverseMember(instrumentId: number): Promise<void> {
    await this.sql.query(
      `INSERT INTO nifty500_membership
         (instrument_id, effective_from, effective_to, added_reason)
       VALUES ($1, DATE '2000-01-01', NULL, 'zztest-staging')`,
      [instrumentId]
    );
  }

  private async addScannerConfig(): Promise<void> {
    await this.sql.query(
      `INSERT INTO scanner_configs (config_id, version, config_json)
       VALUES ($1::uuid, 1, '{}'::jsonb)`,
      [this.configId]
    );
  }

  async addScanJob(seed: ScanJobSeed): Promise<string> {
    const jobId = randomUUID();
    await this.sql.query(
      `INSERT INTO scan_jobs
         (job_id, completed_at, status, progress_percent, config_id,
          instrument_ids, current_stage)
       VALUES ($1::uuid, $2, 'SUCCESS', 100, $3::uuid, $4::jsonb, 'DETECT_ZONES')`,
      [
        jobId,
        seed.completedAt,
        this.configId,
        seed.instrumentIds === null ? null : JSON.stringify(seed.instrumentIds),
      ]
    );
    this.jobIds.add(jobId);

    if (seed.viaBatch) {
      await this.addBatch(jobId, seed.batchInstrumentIds ?? []);
    }
    return jobId;
  }

  async addBatch(jobId: string, instrumentIds: number[]): Promise<string> {
    const batchId = randomUUID();
    await this.sql.query(
      `INSERT INTO scan_job_batches
         (batch_id, job_id, stage, cursor_start, cursor_end, instrument_ids,
          status, completed_at)
       VALUES ($1::uuid, $2::uuid, 'DETECT_ZONES', 0, 0, $3::jsonb,
               'SUCCESS', NOW())`,
      [batchId, jobId, JSON.stringify(instrumentIds)]
    );
    this.batchIds.add(batchId);
    return batchId;
  }

  async addZone(instrumentId: number, seed: ZoneSeed): Promise<string> {
    const zoneId = randomUUID();
    const formation = new Date(
      Date.now() - (seed.formationDaysAgo ?? 1) * 24 * 60 * 60 * 1000
    );
    const low = seed.side === "DEMAND" ? seed.distal : seed.proximal;
    const high = seed.side === "DEMAND" ? seed.proximal : seed.distal;

    await this.sql.query(
      `INSERT INTO zones
         (zone_id, instrument_id, timeframe, pattern, side,
          base_start, base_end, leg_in_ts, leg_out_ts,
          zone_low, zone_high, proximal, distal, formation_ts,
          config_version, score, lifecycle_state, touch_count)
       VALUES ($1::uuid, $2, $3, 'DBR', $4,
               $5, $6, $7, $8,
               $9, $10, $11, $12, $13,
               1, $14, $15, 0)`,
      [
        zoneId,
        instrumentId,
        seed.timeframe,
        seed.side,
        formation,
        formation,
        formation,
        formation,
        low,
        high,
        seed.proximal,
        seed.distal,
        formation,
        seed.score ?? 70,
        seed.lifecycle ?? "CONFIRMED_FRESH",
      ]
    );
    this.zoneIds.add(zoneId);
    return zoneId;
  }

  /**
   * Deletes only this run's rows. Safe to call more than once.
   */
  async cleanup(): Promise<void> {
    const owners = [this.ownerA as string, this.ownerB as string];
    const instrumentIds = [...this.instruments];
    const zoneIds = [...this.zoneIds];
    const jobIds = [...this.jobIds];
    const batchIds = [...this.batchIds];

    assertSyntheticOwners(owners);
    assertSyntheticInstrumentIds(instrumentIds);

    if (zoneIds.length > 0) {
      await this.sql.query(
        `DELETE FROM zone_events WHERE zone_id = ANY($1::uuid[])`,
        [zoneIds]
      );
      await this.sql.query(`DELETE FROM zones WHERE zone_id = ANY($1::uuid[])`, [
        zoneIds,
      ]);
    }

    if (batchIds.length > 0) {
      await this.sql.query(
        `DELETE FROM scan_job_batches WHERE batch_id = ANY($1::uuid[])`,
        [batchIds]
      );
    }
    if (jobIds.length > 0) {
      await this.sql.query(`DELETE FROM scan_jobs WHERE job_id = ANY($1::uuid[])`, [
        jobIds,
      ]);
    }

    await this.sql.query(`DELETE FROM scanner_configs WHERE config_id = $1::uuid`, [
      this.configId,
    ]);

    await this.sql.query(
      `DELETE FROM live_trade_items WHERE owner_user_id = ANY($1::text[])`,
      [owners]
    );
    await this.sql.query(
      `DELETE FROM live_trade_groups WHERE owner_user_id = ANY($1::text[])`,
      [owners]
    );
    await this.sql.query(
      `DELETE FROM live_trade_quote_state WHERE owner_user_id = ANY($1::text[])`,
      [owners]
    );

    if (instrumentIds.length > 0) {
      await this.sql.query(
        `DELETE FROM nifty500_membership WHERE instrument_id = ANY($1::bigint[])`,
        [instrumentIds]
      );
      await this.sql.query(
        `DELETE FROM instruments WHERE instrument_id = ANY($1::bigint[])`,
        [instrumentIds]
      );
    }

    await this.sql.query(
      `DELETE FROM kite_sessions WHERE user_id = ANY($1::text[])`,
      [owners]
    );
  }
}

export function createStagingRun(): StagingRun {
  const url = process.env.DATABASE_URL;
  const runId = process.env.STAGING_TEST_RUN_ID;
  if (!url || !runId) {
    throw new Error(
      "Staging run requires DATABASE_URL and STAGING_TEST_RUN_ID (set by setup-env.js)."
    );
  }
  return new StagingRun(neon(url), runId);
}

export function rowsOf(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}
