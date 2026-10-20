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

  // Fetch all active (non-broken) zones.
  const activeZoneRows = await sql`
    SELECT zone_id, instrument_id, side,
           zone_low, zone_high, proximal, distal,
           lifecycle_state, touch_count
    FROM zones
    WHERE lifecycle_state != 'BROKEN'
  `;

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
      await sql`
        UPDATE zones
        SET lifecycle_state = 'BROKEN',
            last_touch_ts   = ${snapshot.date},
            touch_count     = touch_count + 1
        WHERE zone_id = ${zone.zoneId}
      `;
      await appendZoneEvent(zone.zoneId, 'BREAK', snapshot.date, {
        close: snapshot.close,
        distal: zone.distal,
      }, isHistorical);
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

      await sql`
        UPDATE zones
        SET lifecycle_state = ${newState},
            last_touch_ts   = ${snapshot.date},
            touch_count     = ${newTouches}
        WHERE zone_id = ${zone.zoneId}
      `;
      await appendZoneEvent(zone.zoneId, eventType, snapshot.date, {
        close: snapshot.close,
        proximal: zone.proximal,
        touchCount: newTouches,
      }, isHistorical);
    }
  }
}

/**
 * Append an immutable event to `zone_events`.
 * If isHistorical is true, the event is flagged as a historical replay record.
 */
async function appendZoneEvent(
  zoneId: string,
  eventType: ZoneEventType,
  candleTs: Date,
  details: Record<string, unknown>,
  isHistorical = false
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO zone_events (zone_id, event_type, candle_ts, details_json, is_historical, as_of_date)
    VALUES (
      ${zoneId}, ${eventType}, ${candleTs},
      ${JSON.stringify(details)}::jsonb,
      ${isHistorical},
      ${isHistorical ? candleTs : null}::date
    )
  `;
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
