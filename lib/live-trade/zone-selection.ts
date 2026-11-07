/**
 * Demand/supply zone classification for Live Trade.
 *
 * Pure helpers only. The SQL that chooses the nearest zone lives in the
 * repository; these functions decide how the returned evidence is described to
 * the client, so the rules can be tested without a database.
 *
 * Coverage is derived from three independent signals:
 *   1. current Nifty 500 membership (is the instrument in the scanner universe?)
 *   2. presence of zone rows (has the scanner produced output for it?)
 *   3. the latest successfully completed scan that covers it
 *
 * Zones are idempotent and are not rewritten when re-detected, so
 * `zones.created_at` cannot prove freshness. A completed scan is the only
 * reliable recency signal.
 *
 * `AVAILABLE` is deliberately a conservative composite: it means a successful
 * scan covering the instrument completed inside the freshness window AND zone
 * rows currently exist for it. It does not prove those particular rows were
 * written by that scan — zone rows and scan coverage are independent evidence.
 * `latestZoneFormationAt` is returned separately for display and may be older
 * than the covering scan. When coverage cannot be attributed, the classifier
 * returns `UNKNOWN` rather than guessing.
 */

import {
  LIVE_TRADE_ZONE_FRESHNESS_DAYS,
  type LiveTradeZoneCoverage,
  type LiveTradeZoneTimeframeMatch,
} from "./constants";

const FRESHNESS_MS = LIVE_TRADE_ZONE_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;

export interface ZoneCoverageInput {
  inUniverse: boolean;
  zoneCount: number;
  latestCoveringScanAt: Date | null;
  hasAnySuccessScan: boolean;
  /**
   * True when a successful scan exists whose instrument set cannot be
   * attributed (NULL `instrument_ids` with no successful DETECT_ZONES batch).
   * In that case an empty result cannot distinguish NO_ZONES from
   * NO_SCAN_HISTORY.
   */
  hasUnattributableScan: boolean;
  now: Date;
}

export function isCoveringScanFresh(
  completedAt: Date | null,
  now: Date
): boolean {
  if (completedAt === null) return false;
  return now.getTime() - completedAt.getTime() <= FRESHNESS_MS;
}

/**
 * Coverage precedence:
 *
 *  1. Not a current universe member → OUTSIDE_SCANNER_UNIVERSE (zones may still
 *     exist from a single-symbol scan and are still returned).
 *  2. Zones exist + fresh covering scan → AVAILABLE
 *  3. Zones exist + old covering scan   → STALE
 *  4. Zones exist + no attributable scan→ UNKNOWN (freshness cannot be proven)
 *  5. No zones + fresh covering scan    → NO_ZONES
 *  6. No zones + old covering scan      → STALE
 *  7. No zones + attributable scans that do not cover it → NO_SCAN_HISTORY
 *  8. Otherwise                         → UNKNOWN
 */
export function classifyZoneCoverage(input: ZoneCoverageInput): LiveTradeZoneCoverage {
  if (!input.inUniverse) return "OUTSIDE_SCANNER_UNIVERSE";

  const hasZones = input.zoneCount > 0;
  const fresh = isCoveringScanFresh(input.latestCoveringScanAt, input.now);

  if (hasZones) {
    if (fresh) return "AVAILABLE";
    if (input.latestCoveringScanAt !== null) return "STALE";
    return "UNKNOWN";
  }

  if (input.latestCoveringScanAt !== null) {
    return fresh ? "NO_ZONES" : "STALE";
  }

  if (input.hasAnySuccessScan && !input.hasUnattributableScan) {
    return "NO_SCAN_HISTORY";
  }

  return "UNKNOWN";
}

/**
 * Describes whether the selected zone is in the item's preferred timeframe.
 * A null preference means "Any timeframe", so there is no fallback.
 */
export function describeTimeframeMatch(
  preferredTimeframe: string | null,
  actualTimeframe: string
): LiveTradeZoneTimeframeMatch {
  if (preferredTimeframe === null) return "ANY";
  return actualTimeframe === preferredTimeframe ? "PREFERRED" : "FALLBACK";
}
