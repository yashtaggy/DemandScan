/**
 * lib/scanner/confluence.ts
 *
 * Phase 7 — Confluence & Opposing-Zone Risk
 *
 * Confluence (same-side alignment across timeframes):
 *   A demand zone on the 1D chart that sits inside a demand zone on the 1W
 *   and 1M charts is said to have "confluence". Higher confluence → stronger zone.
 *
 * Opposition risk (supply zone above a demand zone, or vice-versa):
 *   If a fresh supply zone sits close above a demand zone, it limits the
 *   upside before sellers re-enter. This is quantified as an "opposition risk"
 *   score (0–100, higher = more dangerous).
 *
 * ─── Scoring summary ──────────────────────────────────────────────────────────
 *  confluenceScore  0–100  – number of higher-TF same-side zones containing
 *                            this zone, weighted by timeframe quality.
 *  oppositionRisk   0–100  – proximity and freshness of the nearest opposing
 *                            zone in the trade's direction.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getDb } from '@/lib/db';
import type { Zone, Timeframe, ZoneSide } from './types';

// ─── Timeframe ordering (ascending granularity) ───────────────────────────────

const TF_ORDER: Timeframe[] = ['1H', '4H', '1D', '1W', '1M', '3M', '6M', '1Y'];
const TF_WEIGHT: Record<Timeframe, number> = {
  '1H': 1,
  '4H': 3,
  '1D': 5,
  '1W': 10,
  '1M': 15,
  '3M': 20,
  '6M': 25,
  '1Y': 30,
};

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConfluenceResult {
  zoneId: string;
  confluenceScore: number;   // 0–100 – how many higher-TF same-side zones contain this one
  confluenceDetails: Array<{
    timeframe: Timeframe;
    containingZoneId: string;
  }>;
  oppositionRisk: number;    // 0–100 – risk from opposing zones in the trade direction
  oppositionDetails: Array<{
    zoneId: string;
    timeframe: Timeframe;
    side: ZoneSide;
    distancePct: number;     // distance from this zone's proximal to opposing zone's proximal (%)
  }>;
}

// ─── Confluence helpers ───────────────────────────────────────────────────────

/**
 * Returns true if `candidate` zone is fully contained within `container` zone's
 * price boundaries. Allows a 0.1 % tolerance.
 */
function isContainedBy(candidate: Zone, container: Zone): boolean {
  const tol = 0.001;
  return (
    candidate.zoneLow  >= container.zoneLow  * (1 - tol) &&
    candidate.zoneHigh <= container.zoneHigh * (1 + tol)
  );
}

/**
 * Returns true if `higher` timeframe is strictly more granular than `lower`.
 * e.g. '1W' is higher than '1D'.
 */
function isHigherTimeframe(lower: Timeframe, higher: Timeframe): boolean {
  return TF_ORDER.indexOf(higher) > TF_ORDER.indexOf(lower);
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Compute confluence and opposition-risk metrics for a single zone.
 *
 * @param zone     The zone to analyse.
 * @param allZones All currently active (non-broken) zones for the same instrument.
 *                 Caller is responsible for pre-fetching them.
 */
export function computeConfluence(
  zone: Zone,
  allZones: Zone[]
): ConfluenceResult {
  const confluenceDetails: ConfluenceResult['confluenceDetails'] = [];
  const oppositionDetails: ConfluenceResult['oppositionDetails'] = [];

  for (const other of allZones) {
    if (other.zoneId === zone.zoneId) continue;
    if (other.instrumentId !== zone.instrumentId) continue;

    // ── Same-side confluence ──────────────────────────────────────────────
    if (
      other.side === zone.side &&
      isHigherTimeframe(zone.timeframe, other.timeframe) &&
      isContainedBy(zone, other)
    ) {
      confluenceDetails.push({
        timeframe: other.timeframe,
        containingZoneId: other.zoneId,
      });
    }

    // ── Opposition risk ───────────────────────────────────────────────────
    // For a DEMAND zone: opposing zones are SUPPLY zones above the demand proximal.
    // For a SUPPLY zone: opposing zones are DEMAND zones below the supply proximal.
    const isOpposing = other.side !== zone.side;
    if (!isOpposing) continue;

    let isInTradePath = false;
    let distancePct = 0;

    if (zone.side === 'DEMAND') {
      // Trade direction is upward. Opposition = supply zones above us.
      if (other.proximal > zone.proximal) {
        isInTradePath = true;
        distancePct = ((other.proximal - zone.proximal) / zone.proximal) * 100;
      }
    } else {
      // Trade direction is downward. Opposition = demand zones below us.
      if (other.proximal < zone.proximal) {
        isInTradePath = true;
        distancePct = ((zone.proximal - other.proximal) / zone.proximal) * 100;
      }
    }

    if (isInTradePath && distancePct <= 20) {
      // Only count opposing zones within 20 % of proximal as relevant risk.
      oppositionDetails.push({
        zoneId: other.zoneId,
        timeframe: other.timeframe,
        side: other.side,
        distancePct: Math.round(distancePct * 100) / 100,
      });
    }
  }

  // ── Score confluence ──────────────────────────────────────────────────────
  // Each containing TF contributes its weight (capped at 100).
  const rawConfluence = confluenceDetails.reduce(
    (sum, d) => sum + TF_WEIGHT[d.timeframe],
    0
  );
  const confluenceScore = clamp(rawConfluence, 0, 100);

  // ── Score opposition risk ────────────────────────────────────────────────
  // Closer opposing zones → higher risk. Cap at 100.
  // Each opposing zone within 20 % adds (20 - distancePct) / 20 * 20 points.
  const rawOpposition = oppositionDetails.reduce((sum, d) => {
    const proximity = clamp((20 - d.distancePct) / 20, 0, 1); // 1 = very close, 0 = far
    const tfWeight = TF_WEIGHT[d.timeframe] / 30; // normalise weight to [0,1]
    return sum + proximity * tfWeight * 30; // max 30 per opposing zone
  }, 0);
  const oppositionRisk = clamp(Math.round(rawOpposition), 0, 100);

  return {
    zoneId: zone.zoneId,
    confluenceScore,
    confluenceDetails,
    oppositionRisk,
    oppositionDetails,
  };
}

// ─── Batch DB helpers ─────────────────────────────────────────────────────────

/**
 * Fetch all non-broken zones for a given instrument from the database.
 * Includes symbol from the instruments join.
 */
export async function getActiveZonesForInstrument(
  instrumentId: number
): Promise<Zone[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT
      z.zone_id, z.instrument_id, i.symbol,
      z.timeframe, z.pattern, z.side,
      z.base_start, z.base_end, z.leg_in_ts, z.leg_out_ts,
      z.zone_low, z.zone_high, z.proximal, z.distal,
      z.formation_ts, z.config_version, z.score,
      z.lifecycle_state, z.last_touch_ts, z.touch_count, z.created_at
    FROM zones z
    JOIN instruments i ON i.instrument_id = z.instrument_id
    WHERE z.instrument_id = ${instrumentId}
      AND z.lifecycle_state != 'BROKEN'
    ORDER BY z.score DESC
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
 * Convenience wrapper: fetch all non-broken zones for an instrument then
 * compute confluence/opposition for a specific zone.
 */
export async function computeConfluenceForZone(
  zoneId: string
): Promise<ConfluenceResult | null> {
  const sql = getDb();

  // Fetch the target zone.
  const zoneRows = await sql`
    SELECT
      z.zone_id, z.instrument_id, i.symbol,
      z.timeframe, z.pattern, z.side,
      z.base_start, z.base_end, z.leg_in_ts, z.leg_out_ts,
      z.zone_low, z.zone_high, z.proximal, z.distal,
      z.formation_ts, z.config_version, z.score,
      z.lifecycle_state, z.last_touch_ts, z.touch_count, z.created_at
    FROM zones z
    JOIN instruments i ON i.instrument_id = z.instrument_id
    WHERE z.zone_id = ${zoneId}
    LIMIT 1
  `;
  if (!zoneRows.length) return null;

  const r = zoneRows[0];
  const zone: Zone = {
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

  const allZones = await getActiveZonesForInstrument(zone.instrumentId);
  return computeConfluence(zone, allZones);
}
