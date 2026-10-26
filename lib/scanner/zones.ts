/**
 * lib/scanner/zones.ts
 *
 * Zone creation, scoring, and persistence.
 *
 * ─── Scoring rubric (0–100) ───────────────────────────────────────────────
 *  +30  Timeframe quality (1Y=30, 6M=25, 3M=20, 1M=15, 1W=10, 1D=5)
 *  +20  Leg-out strength (body/range of leg-out candle, normalised to 20)
 *  +20  Base tightness (1 − avg body/range of base, normalised to 20)
 *  +10  Volume surge on leg-out vs 20-candle avg volume
 *  +20  Fresh zone bonus (lifecycle === CONFIRMED_FRESH, from config)
 *  ─────────────────────────────────────────────────────────────────────────
 *  Capped at 100.
 */

import { getDb } from '@/lib/db';
import { bulkUpsert } from './bulk';
import type {
  PatternMatch,
  Candle,
  ScannerConfig,
  Zone,
  Timeframe,
  ZoneSide,
} from './types';

// ─── Scoring helpers ─────────────────────────────────────────────────────────

const TIMEFRAME_SCORE: Record<Timeframe, number> = {
  '1Y': 30,
  '6M': 25,
  '3M': 20,
  '1M': 15,
  '1W': 10,
  '1D': 5,
  '4H': 3,
  '1H': 1,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function bodyRatio(c: Candle): number {
  const r = c.high - c.low;
  return r === 0 ? 0 : Math.abs(c.close - c.open) / r;
}

/**
 * Compute a 0–100 quality score for a zone given the matched candles and config.
 */
export function scoreZone(
  match: PatternMatch,
  candles: Candle[],
  cfg: ScannerConfig,
  isFresh: boolean
): number {
  let score = 0;

  // 1. Timeframe quality.
  score += TIMEFRAME_SCORE[match.timeframe] ?? 5;

  // 2. Leg-out strength (body/range → 0–20).
  const legOut = candles[match.legOutIndex];
  score += clamp(Math.round(bodyRatio(legOut) * 20), 0, 20);

  // 3. Base tightness (1 − avgBodyRatio of base candles → 0–20).
  const baseCandles = candles.slice(match.baseStartIndex, match.baseEndIndex + 1);
  const avgBaseBodyRatio =
    baseCandles.reduce((sum, c) => sum + bodyRatio(c), 0) / baseCandles.length;
  score += clamp(Math.round((1 - avgBaseBodyRatio) * 20), 0, 20);

  // 4. Volume surge on leg-out vs 20-candle average (capped at +10).
  const histStart = Math.max(0, match.legOutIndex - 20);
  const histCandles = candles.slice(histStart, match.legOutIndex);
  if (histCandles.length > 0) {
    const avgVol =
      histCandles.reduce((sum, c) => sum + c.volume, 0) / histCandles.length;
    const legOutVol = legOut.volume;
    const surge = avgVol > 0 ? legOutVol / avgVol : 1;
    score += clamp(Math.round((surge - 1) * 5), 0, 10); // 2× surge → +5, 3× → +10
  }

  // 5. Fresh zone bonus.
  if (isFresh) {
    score += cfg.thresholds.freshZoneScoreBonus ?? 20;
  }

  return clamp(score, 0, 100);
}

// ─── Zone persistence ────────────────────────────────────────────────────────

export const ZONE_INSERT_COLUMNS = [
  'instrument_id',
  'timeframe',
  'pattern',
  'side',
  'base_start',
  'base_end',
  'leg_in_ts',
  'leg_out_ts',
  'zone_low',
  'zone_high',
  'proximal',
  'distal',
  'formation_ts',
  'config_version',
  'score',
  'lifecycle_state',
  'touch_count',
];

interface PreparedZone {
  identity: string;
  baseStart: Date;
  baseEnd: Date;
  values: unknown[];
}

/** Zone identity is the same key the per-zone existence check used. */
function zoneIdentity(
  instrumentId: number,
  timeframe: string,
  pattern: string,
  baseStart: Date,
  baseEnd: Date
): string {
  return `${instrumentId}|${timeframe}|${pattern}|${baseStart.getTime()}|${baseEnd.getTime()}`;
}

function prepareZone(
  match: PatternMatch,
  candles: Candle[],
  cfg: ScannerConfig,
  configVersion: number
): PreparedZone {
  const legIn = candles[match.legInIndex];
  const baseStart = candles[match.baseStartIndex];
  const baseEnd = candles[match.baseEndIndex];
  const legOut = candles[match.legOutIndex];

  // Proximal and distal depend on zone side.
  const proximal = match.side === 'DEMAND' ? match.zoneHigh : match.zoneLow;
  const distal = match.side === 'DEMAND' ? match.zoneLow : match.zoneHigh;
  const score = scoreZone(match, candles, cfg, true /* fresh */);

  return {
    identity: zoneIdentity(
      match.instrumentId,
      match.timeframe,
      match.pattern,
      baseStart.date,
      baseEnd.date
    ),
    baseStart: baseStart.date,
    baseEnd: baseEnd.date,
    values: [
      match.instrumentId,
      match.timeframe,
      match.pattern,
      match.side,
      baseStart.date,
      baseEnd.date,
      legIn.date,
      legOut.date,
      match.zoneLow,
      match.zoneHigh,
      proximal,
      distal,
      legOut.date,
      configVersion,
      score,
      'CONFIRMED_FRESH',
      0,
    ],
  };
}

/**
 * Persist a detected pattern match as a zone in the `zones` table.
 * Returns the new zone_id (UUID).
 *
 * The zone is marked CONFIRMED_FRESH by default.
 * If an identical zone (same instrument, timeframe, pattern, base_start, base_end)
 * already exists it is NOT duplicated – the existing zone_id is returned.
 */
export async function upsertZone(
  match: PatternMatch,
  candles: Candle[],
  cfg: ScannerConfig,
  configVersion: number
): Promise<string> {
  const sql = getDb();
  const zone = prepareZone(match, candles, cfg, configVersion);

  // Check for existing zone (idempotent).
  const existing = await sql`
    SELECT zone_id FROM zones
    WHERE instrument_id = ${match.instrumentId}
      AND timeframe      = ${match.timeframe}
      AND pattern        = ${match.pattern}
      AND base_start     = ${zone.baseStart}
      AND base_end       = ${zone.baseEnd}
    LIMIT 1
  `;
  if (existing.length > 0) return existing[0].zone_id as string;

  const placeholders = zone.values.map((_, i) => `$${i + 1}`).join(', ');
  const result = await sql.query(
    `INSERT INTO zones (${ZONE_INSERT_COLUMNS.join(', ')})
     VALUES (${placeholders})
     RETURNING zone_id`,
    zone.values
  );

  return result[0].zone_id as string;
}

export interface DetectedZoneInput {
  match: PatternMatch;
  candles: Candle[];
}

interface ExistingZoneIdentityRow {
  instrument_id: number | string;
  timeframe: string;
  pattern: string;
  base_start: string | number | Date;
  base_end: string | number | Date;
}

/**
 * Persist all zones detected for an instrument in two round trips: one read of
 * existing identities, then one chunked multi-row insert.
 *
 * Idempotence is preserved with the same identity key as `upsertZone`
 * (instrument, timeframe, pattern, base_start, base_end). Duplicate matches
 * within the same batch are also collapsed before insert.
 */
export async function persistDetectedZones(
  inputs: DetectedZoneInput[],
  cfg: ScannerConfig,
  configVersion: number
): Promise<{ inserted: number; skipped: number }> {
  if (inputs.length === 0) return { inserted: 0, skipped: 0 };

  const sql = getDb();
  const instrumentIds = [...new Set(inputs.map((i) => i.match.instrumentId))];

  const existingRows = await sql`
    SELECT instrument_id, timeframe, pattern, base_start, base_end
    FROM zones
    WHERE instrument_id = ANY(${instrumentIds}::bigint[])
  `;
  const existing = new Set(
    (existingRows as ExistingZoneIdentityRow[]).map((r) =>
      zoneIdentity(
        Number(r.instrument_id),
        r.timeframe,
        r.pattern,
        new Date(r.base_start),
        new Date(r.base_end)
      )
    )
  );

  const seen = new Set<string>();
  const rows: unknown[][] = [];
  for (const input of inputs) {
    const zone = prepareZone(input.match, input.candles, cfg, configVersion);
    if (existing.has(zone.identity) || seen.has(zone.identity)) continue;
    seen.add(zone.identity);
    rows.push(zone.values);
  }

  if (rows.length > 0) {
    await bulkUpsert({
      table: 'zones',
      columns: ZONE_INSERT_COLUMNS,
      rows,
      conflictClause: 'ON CONFLICT DO NOTHING',
      chunkSize: 200,
    });
  }

  return { inserted: rows.length, skipped: inputs.length - rows.length };
}

// ─── Zone retrieval ──────────────────────────────────────────────────────────

export interface ZoneFilter {
  instrumentId?: number;
  timeframe?: Timeframe;
  side?: ZoneSide;
  lifecycleState?: string;
  minScore?: number;
  limit?: number;
  offset?: number;
}

/**
 * Retrieve zones matching the given filter criteria.
 */
export async function getZones(filter: ZoneFilter = {}): Promise<Zone[]> {
  const sql = getDb();
  const {
    instrumentId,
    timeframe,
    side,
    lifecycleState,
    minScore,
    limit = 50,
    offset = 0,
  } = filter;

  const rows = await sql`
    SELECT
      z.zone_id,
      z.instrument_id,
      i.symbol,
      z.timeframe,
      z.pattern,
      z.side,
      z.base_start,
      z.base_end,
      z.leg_in_ts,
      z.leg_out_ts,
      z.zone_low,
      z.zone_high,
      z.proximal,
      z.distal,
      z.formation_ts,
      z.config_version,
      z.score,
      z.lifecycle_state,
      z.last_touch_ts,
      z.touch_count,
      z.created_at
    FROM zones z
    JOIN instruments i ON i.instrument_id = z.instrument_id
    WHERE
      (${instrumentId}::bigint IS NULL OR z.instrument_id = ${instrumentId ?? null})
      AND (${timeframe ?? null}::text IS NULL OR z.timeframe = ${timeframe ?? null})
      AND (${side ?? null}::text IS NULL OR z.side = ${side ?? null})
      AND (${lifecycleState ?? null}::text IS NULL OR z.lifecycle_state = ${lifecycleState ?? null})
      AND (${minScore ?? null}::int IS NULL OR z.score >= ${minScore ?? null})
    ORDER BY z.score DESC, z.formation_ts DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  return rows.map((r: any): Zone => ({
    zoneId: r.zone_id,
    instrumentId: Number(r.instrument_id),
    symbol: r.symbol as string | undefined,
    timeframe: r.timeframe as Timeframe,
    pattern: r.pattern,
    side: r.side,
    baseStart: new Date(r.base_start),
    baseEnd: new Date(r.base_end),
    legInTs: new Date(r.leg_in_ts),
    legOutTs: new Date(r.leg_out_ts),
    zoneLow: Number(r.zone_low),
    zoneHigh: Number(r.zone_high),
    proximal: Number(r.proximal),
    distal: Number(r.distal),
    formationTs: new Date(r.formation_ts),
    configVersion: Number(r.config_version),
    score: Number(r.score),
    lifecycleState: r.lifecycle_state,
    lastTouchTs: r.last_touch_ts ? new Date(r.last_touch_ts) : undefined,
    touchCount: Number(r.touch_count),
    createdAt: new Date(r.created_at),
  }));
}

/**
 * Retrieve a single zone by ID.
 */
export async function getZoneById(zoneId: string): Promise<Zone | null> {
  const zones = await getZones({ limit: 1 });
  const sql = getDb();
  const rows = await sql`
    SELECT
      z.zone_id, z.instrument_id, i.symbol, z.timeframe, z.pattern, z.side,
      z.base_start, z.base_end, z.leg_in_ts, z.leg_out_ts,
      z.zone_low, z.zone_high, z.proximal, z.distal,
      z.formation_ts, z.config_version, z.score,
      z.lifecycle_state, z.last_touch_ts, z.touch_count, z.created_at
    FROM zones z
    JOIN instruments i ON i.instrument_id = z.instrument_id
    WHERE z.zone_id = ${zoneId}
    LIMIT 1
  `;
  if (!rows.length) return null;
  const r = rows[0];
  return {
    zoneId: r.zone_id,
    instrumentId: Number(r.instrument_id),
    symbol: r.symbol as string | undefined,
    timeframe: r.timeframe as Timeframe,
    pattern: r.pattern,
    side: r.side,
    baseStart: new Date(r.base_start),
    baseEnd: new Date(r.base_end),
    legInTs: new Date(r.leg_in_ts),
    legOutTs: new Date(r.leg_out_ts),
    zoneLow: Number(r.zone_low),
    zoneHigh: Number(r.zone_high),
    proximal: Number(r.proximal),
    distal: Number(r.distal),
    formationTs: new Date(r.formation_ts),
    configVersion: Number(r.config_version),
    score: Number(r.score),
    lifecycleState: r.lifecycle_state,
    lastTouchTs: r.last_touch_ts ? new Date(r.last_touch_ts) : undefined,
    touchCount: Number(r.touch_count),
    createdAt: new Date(r.created_at),
  };
}
