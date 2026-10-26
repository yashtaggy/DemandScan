/**
 * lib/scanner/lifecycle.ts
 *
 * Zone lifecycle management.
 *
 * After zones are identified and scored, the lifecycle engine tracks how the
 * market interacts with each zone:
 *
 *  CONFIRMED_FRESH  → zone just formed, price has not revisited it
 *  TOUCHED_ONCE     → price touched the proximal level once (first retest)
 *  RETESTED         → price touched the proximal level more than once
 *  BROKEN           → price closed beyond the distal level (zone is invalidated)
 *
 * The lifecycle is updated by comparing the latest daily close price against each
 * active zone's proximal and distal levels.
 *
 * This module also appends immutable events to `zone_events` for auditability.
 */

import { getDb } from '@/lib/db';
import { bulkUpsert } from './bulk';
import type { Zone, ScannerConfig } from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ZoneEventType = 'TOUCH' | 'RETEST' | 'BREAK';

interface PriceSnapshot {
  instrumentId: number;
  close: number;
  high: number;
  low: number;
  date: Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isInsideZone(price: number, zone: Zone, buffer: number): boolean {
  const low = zone.zoneLow * (1 - buffer);
  const high = zone.zoneHigh * (1 + buffer);
  return price >= low && price <= high;
}

function isBroken(snapshot: PriceSnapshot, zone: Zone): boolean {
  if (zone.side === 'DEMAND') {
    // Demand zone broken if close is below distal (lower boundary).
    return snapshot.close < zone.distal;
  } else {
    // Supply zone broken if close is above distal (upper boundary).
    return snapshot.close > zone.distal;
  }
}

function isTouched(snapshot: PriceSnapshot, zone: Zone, buffer: number): boolean {
  if (zone.side === 'DEMAND') {
    // Price touches demand zone if the low enters the zone area.
    return snapshot.low <= zone.proximal * (1 + buffer);
  } else {
    // Price touches supply zone if the high enters the zone area.
    return snapshot.high >= zone.proximal * (1 - buffer);
  }
}

// ─── Core lifecycle update ───────────────────────────────────────────────────

/**
 * Process latest price snapshots against all active zones and update their
 * lifecycle states accordingly. Appends events to `zone_events`.
 *
 * @param snapshots     Array of latest OHLCV snapshots, one per instrument.
 * @param cfg           Scanner configuration (for proximalBuffer threshold).
 * @param isHistorical  If true, zone_events are flagged as historical replay records.
 */
export async function updateZoneLifecycles(
  snapshots: PriceSnapshot[],
  cfg: ScannerConfig,
  isHistorical = false
): Promise<void> {
  const sql = getDb();
  const buffer = cfg.thresholds.proximalBuffer ?? 0.003;

  // Build a map from instrumentId → snapshot for O(1) lookup.
  const snapshotMap = new Map<number, PriceSnapshot>();
  for (const s of snapshots) {
    snapshotMap.set(s.instrumentId, s);
  }

  // Nothing to evaluate for an empty batch.
  if (snapshotMap.size === 0) return;

  // Fetch only active (non-broken) zones for this batch's instruments.
  // Previously every lifecycle batch re-read every non-broken zone in the
  // database; zones for instruments without a snapshot were skipped anyway.
  const instrumentIds = [...snapshotMap.keys()];
  const activeZoneRows = await sql`
    SELECT zone_id, instrument_id, side,
           zone_low, zone_high, proximal, distal,
           lifecycle_state, touch_count
    FROM zones
    WHERE lifecycle_state != 'BROKEN'
      AND instrument_id = ANY(${instrumentIds}::bigint[])
  `;

  const updates: LifecycleUpdate[] = [];
  const events: ZoneEventInsert[] = [];

  for (const row of activeZoneRows) {
    const snapshot = snapshotMap.get(Number(row.instrument_id));
    if (!snapshot) continue;

    const zone: Zone = {
      zoneId: row.zone_id,
      instrumentId: Number(row.instrument_id),
      timeframe: row.timeframe,
      pattern: row.pattern,
      side: row.side,
      baseStart: new Date(row.base_start ?? 0),
      baseEnd: new Date(row.base_end ?? 0),
      legInTs: new Date(row.leg_in_ts ?? 0),
      legOutTs: new Date(row.leg_out_ts ?? 0),
      zoneLow: Number(row.zone_low),
      zoneHigh: Number(row.zone_high),
      proximal: Number(row.proximal),
      distal: Number(row.distal),
      formationTs: new Date(row.formation_ts ?? 0),
      configVersion: Number(row.config_version ?? 1),
      score: Number(row.score ?? 0),
      lifecycleState: row.lifecycle_state,
      touchCount: Number(row.touch_count),
      createdAt: new Date(row.created_at ?? 0),
    };

    // Check BREAK first (takes priority).
    if (isBroken(snapshot, zone)) {
      const touchCount = zone.touchCount + 1;
      updates.push({
        zoneId: zone.zoneId,
        state: 'BROKEN',
        lastTouchTs: snapshot.date,
        touchCount,
      });
      events.push({
        zoneId: zone.zoneId,
        eventType: 'BREAK',
        candleTs: snapshot.date,
        details: { close: snapshot.close, distal: zone.distal },
      });
      continue;
    }

    // Check TOUCH.
    if (isTouched(snapshot, zone, buffer)) {
      const currentTouches = zone.touchCount;
      const newTouches = currentTouches + 1;
      const newState =
        currentTouches === 0
          ? 'TOUCHED_ONCE'
          : 'RETESTED';
      const eventType: ZoneEventType = currentTouches === 0 ? 'TOUCH' : 'RETEST';

      updates.push({
        zoneId: zone.zoneId,
        state: newState,
        lastTouchTs: snapshot.date,
        touchCount: newTouches,
      });
      events.push({
        zoneId: zone.zoneId,
        eventType,
        candleTs: snapshot.date,
        details: {
          close: snapshot.close,
          proximal: zone.proximal,
          touchCount: newTouches,
        },
      });
    }
  }

  // One multi-row UPDATE and one chunked INSERT replace two round trips per
  // changed zone. Values are identical to the previous per-zone statements.
  await applyLifecycleUpdates(updates);
  await insertZoneEvents(events, isHistorical);
}

interface LifecycleUpdate {
  zoneId: string;
  state: 'BROKEN' | 'TOUCHED_ONCE' | 'RETESTED';
  lastTouchTs: Date;
  touchCount: number;
}

interface ZoneEventInsert {
  zoneId: string;
  eventType: ZoneEventType;
  candleTs: Date;
  details: Record<string, unknown>;
}

const LIFECYCLE_WRITE_CHUNK = 500;

async function applyLifecycleUpdates(updates: LifecycleUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const sql = getDb();

  for (let start = 0; start < updates.length; start += LIFECYCLE_WRITE_CHUNK) {
    const chunk = updates.slice(start, start + LIFECYCLE_WRITE_CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((u) => {
      const base = params.length;
      params.push(u.zoneId, u.state, u.lastTouchTs, u.touchCount);
      return `($${base + 1}::uuid, $${base + 2}::text, $${base + 3}::timestamptz, $${base + 4}::int)`;
    });

    await sql.query(
      `UPDATE zones AS z
       SET lifecycle_state = v.lifecycle_state,
           last_touch_ts   = v.last_touch_ts,
           touch_count     = v.touch_count
       FROM (VALUES ${tuples.join(', ')})
            AS v(zone_id, lifecycle_state, last_touch_ts, touch_count)
       WHERE z.zone_id = v.zone_id`,
      params
    );
  }
}

/**
 * Append immutable events to `zone_events`. If isHistorical is true, events
 * are flagged as historical replay records.
 */
async function insertZoneEvents(
  events: ZoneEventInsert[],
  isHistorical: boolean
): Promise<void> {
  if (events.length === 0) return;

  await bulkUpsert({
    table: 'zone_events',
    columns: [
      'zone_id',
      'event_type',
      'candle_ts',
      'details_json',
      'is_historical',
      'as_of_date',
    ],
    rows: events.map((e) => [
      e.zoneId,
      e.eventType,
      e.candleTs,
      JSON.stringify(e.details),
      isHistorical,
      isHistorical ? e.candleTs : null,
    ]),
    conflictClause: 'ON CONFLICT DO NOTHING',
  });
}

// ─── Latest-price snapshot helper ────────────────────────────────────────────

/**
 * Build price snapshots from the latest candle in `daily_candles` per instrument.
 * Used to run a lifecycle update from the most recent data without a live feed.
 */
export async function buildLatestSnapshots(
  instrumentIds?: number[]
): Promise<PriceSnapshot[]> {
  const sql = getDb();
  let rows;
  if (instrumentIds && instrumentIds.length > 0) {
    rows = await sql`
      SELECT DISTINCT ON (instrument_id)
        instrument_id,
        close,
        high,
        low,
        candle_date AS date
      FROM daily_candles
      WHERE instrument_id = ANY(${instrumentIds}::bigint[])
      ORDER BY instrument_id, candle_date DESC
    `;
  } else {
    rows = await sql`
      SELECT DISTINCT ON (instrument_id)
        instrument_id,
        close,
        high,
        low,
        candle_date AS date
      FROM daily_candles
      ORDER BY instrument_id, candle_date DESC
    `;
  }
  return rows.map((r: any): PriceSnapshot => ({
    instrumentId: Number(r.instrument_id),
    close: Number(r.close),
    high: Number(r.high),
    low: Number(r.low),
    date: new Date(r.date),
  }));
}
