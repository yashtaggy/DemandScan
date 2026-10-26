/**
 * lib/scanner/universe.ts
 *
 * Explicit scan-universe resolution.
 *
 * A full scan must process the intended Nifty 500 membership — never the
 * entire Kite NSE instrument master. Membership lives in
 * `nifty500_membership` (effective_to IS NULL = current constituent). The
 * curated list in lib/nifty500.ts is the seed source; it is inserted during
 * instrument sync and can be corrected in the database afterwards without
 * editing code.
 *
 * Seeding is strict: a partial, ambiguous, or inactive mapping aborts before
 * any membership row is changed. Resolution NEVER falls back to "all active
 * instruments".
 */

import { getDb } from '@/lib/db';
import {
  NIFTY500_LAST_UPDATED,
  getNifty500Constituents,
  resolveNifty500Candidates,
  validateNifty500Source,
  type Nifty500Constituent,
} from '@/lib/nifty500';

export interface MembershipSeedResult {
  /** Rows inserted by this call (0 when already seeded). */
  seeded: number;
  /** Official tradeable constituents in the curated snapshot. */
  curated: number;
  /** Constituents mapped to exactly one active instrument. */
  matched: number;
  /** Current membership rows closed because they left the official list. */
  removed: number;
  /** Official symbols with no instrument candidate in the master. */
  missingSymbols: string[];
  /** Official symbols that only match inactive instruments. */
  inactiveSymbols: string[];
  /** Official symbols matching more than one active instrument. */
  ambiguousSymbols: string[];
  /** Placeholder rows intentionally excluded from the source snapshot. */
  excludedPlaceholders: string[];
}

interface InstrumentRow {
  instrument_id: number | string;
  symbol: string;
  active: boolean;
}

interface MatchedConstituent {
  constituent: Nifty500Constituent;
  instrumentId: number;
  dbSymbol: string;
  candidate: string;
}

export interface UniverseMapping {
  matched: MatchedConstituent[];
  missing: Nifty500Constituent[];
  inactive: Nifty500Constituent[];
  ambiguous: Array<{ constituent: Nifty500Constituent; hits: Array<{ symbol: string; instrumentId: number }> }>;
}

function permanentUniverseError(message: string): Error {
  return Object.assign(new Error(message), { permanent: true });
}

/**
 * Map official constituents to instrument rows. Pure so the reconciliation
 * rules can be tested without a database.
 *
 * A constituent may have more than one candidate because Kite suffixes
 * non-EQ series (HFCL-BE) and some NSE symbols are renamed (ICICIPRULI ->
 * ICICILIFE). Exactly one active hit is required; zero, all-inactive, or
 * multiple active hits are reported instead of guessed.
 */
export function mapConstituentsToInstruments(
  constituents: readonly Nifty500Constituent[],
  rows: readonly InstrumentRow[]
): UniverseMapping {
  const bySymbol = new Map<string, InstrumentRow[]>();
  for (const row of rows) {
    const list = bySymbol.get(row.symbol) ?? [];
    list.push(row);
    bySymbol.set(row.symbol, list);
  }

  const result: UniverseMapping = {
    matched: [],
    missing: [],
    inactive: [],
    ambiguous: [],
  };

  for (const constituent of constituents) {
    const candidates = resolveNifty500Candidates(constituent);
    const hitsById = new Map<number, { symbol: string; instrumentId: number; active: boolean; candidate: string }>();

    for (const candidate of candidates) {
      for (const row of bySymbol.get(candidate) ?? []) {
        const instrumentId = Number(row.instrument_id);
        if (!Number.isFinite(instrumentId)) continue;
        if (!hitsById.has(instrumentId)) {
          hitsById.set(instrumentId, {
            symbol: row.symbol,
            instrumentId,
            active: Boolean(row.active),
            candidate,
          });
        }
      }
    }

    const hits = [...hitsById.values()];
    const activeHits = hits.filter((h) => h.active);

    if (hits.length === 0) {
      result.missing.push(constituent);
    } else if (activeHits.length === 0) {
      result.inactive.push(constituent);
    } else if (activeHits.length > 1) {
      result.ambiguous.push({
        constituent,
        hits: activeHits.map((h) => ({ symbol: h.symbol, instrumentId: h.instrumentId })),
      });
    } else {
      result.matched.push({
        constituent,
        instrumentId: activeHits[0].instrumentId,
        dbSymbol: activeHits[0].symbol,
        candidate: activeHits[0].candidate,
      });
    }
  }

  return result;
}

function describeMappingProblems(mapping: UniverseMapping): string {
  const parts: string[] = [];
  if (mapping.missing.length > 0) {
    parts.push(
      `missing ${mapping.missing.length}: ${mapping.missing
        .map((c) => `${c.symbol}(${c.series}, ${c.isin})`)
        .join(", ")}`
    );
  }
  if (mapping.inactive.length > 0) {
    parts.push(
      `inactive ${mapping.inactive.length}: ${mapping.inactive
        .map((c) => `${c.symbol}(${c.series})`)
        .join(", ")}`
    );
  }
  if (mapping.ambiguous.length > 0) {
    parts.push(
      `ambiguous ${mapping.ambiguous.length}: ${mapping.ambiguous
        .map(
          (a) =>
            `${a.constituent.symbol} -> ${a.hits
              .map((h) => `${h.symbol}#${h.instrumentId}`)
              .join("/")}`
        )
        .join(", ")}`
    );
  }
  return parts.join("; ");
}

/**
 * Idempotently seed `nifty500_membership` from the curated constituent list.
 *
 * The whole official list must map before anything is written. Once matched,
 * rows are inserted for the current effective date, superseded current rows are
 * closed, and constituents no longer in the official list are closed with a
 * reason. Existing candle and zone data is never touched.
 */
export async function seedNifty500Membership(): Promise<MembershipSeedResult> {
  const sql = getDb();
  const constituents = getNifty500Constituents();

  try {
    validateNifty500Source(constituents);
  } catch (err: any) {
    throw permanentUniverseError(err?.message ?? "Invalid Nifty 500 source data.");
  }

  const candidates = [
    ...new Set(constituents.flatMap((c) => resolveNifty500Candidates(c))),
  ];

  const rows = (await sql.query(
    "SELECT instrument_id, symbol, active FROM instruments WHERE symbol = ANY($1::text[])",
    [candidates]
  )) as InstrumentRow[];

  const mapping = mapConstituentsToInstruments(constituents, rows);

  if (
    mapping.missing.length > 0 ||
    mapping.inactive.length > 0 ||
    mapping.ambiguous.length > 0
  ) {
    throw permanentUniverseError(
      `Nifty 500 membership cannot be seeded: ${describeMappingProblems(mapping)}. ` +
        "No membership rows were changed. Reconcile the official constituents against the active instrument master before scanning."
    );
  }

  const instrumentIds = mapping.matched.map((m) => m.instrumentId);
  const seededReason = `seed:lib/nifty500.ts@${NIFTY500_LAST_UPDATED}`;

  // Insert first: if a later cleanup fails, the universe is still complete.
  const inserted = await sql`
    INSERT INTO nifty500_membership (instrument_id, effective_from, effective_to, added_reason)
    SELECT instrument_id, ${NIFTY500_LAST_UPDATED}::date, NULL, ${seededReason}
    FROM unnest(${instrumentIds}::bigint[]) AS instrument_id
    ON CONFLICT (instrument_id, effective_from) DO NOTHING
    RETURNING instrument_id
  `;

  // Close older current rows for instruments that remain in the list so only
  // one row per instrument is current after an index refresh.
  await sql`
    UPDATE nifty500_membership
    SET effective_to = ${NIFTY500_LAST_UPDATED}::date,
        removed_reason = ${"superseded by NSE Nifty 500 refresh " + NIFTY500_LAST_UPDATED}
    WHERE effective_to IS NULL
      AND effective_from <> ${NIFTY500_LAST_UPDATED}::date
      AND instrument_id = ANY(${instrumentIds}::bigint[])
  `;

  const removedRows = await sql`
    UPDATE nifty500_membership
    SET effective_to = ${NIFTY500_LAST_UPDATED}::date,
        removed_reason = ${"not in NSE Nifty 500 list " + NIFTY500_LAST_UPDATED}
    WHERE effective_to IS NULL
      AND NOT (instrument_id = ANY(${instrumentIds}::bigint[]))
    RETURNING instrument_id
  `;

  return {
    seeded: inserted.length,
    curated: constituents.length,
    matched: instrumentIds.length,
    removed: removedRows.length,
    missingSymbols: mapping.missing.map((c) => c.symbol),
    inactiveSymbols: mapping.inactive.map((c) => c.symbol),
    ambiguousSymbols: mapping.ambiguous.map((a) => a.constituent.symbol),
    excludedPlaceholders: ["DUMMYHEG"],
  };
}

/**
 * Current constituents that exist in the active instrument master.
 * Deduplicated by instrument token, ordered deterministically.
 */
export async function listNifty500InstrumentIds(): Promise<number[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT DISTINCT i.instrument_id
    FROM nifty500_membership m
    JOIN instruments i ON i.instrument_id = m.instrument_id
    WHERE m.effective_to IS NULL
      AND i.active = TRUE
    ORDER BY i.instrument_id
  `;
  return [...new Set(rows.map((r: any) => Number(r.instrument_id)))];
}

/**
 * Refuse to run a full scan on a partial universe. `expected` is the official
 * constituent count; extra manual members are allowed, missing ones are not.
 */
export function assertUniversePlayable(selected: number, expected: number): void {
  if (selected === 0) {
    throw permanentUniverseError(
      "Nifty 500 universe is empty. Apply the database migrations, then run the scan again to seed nifty500_membership from the active instrument master. The scan will not fall back to all NSE instruments."
    );
  }
  if (expected > 0 && selected < expected) {
    throw permanentUniverseError(
      `Nifty 500 universe resolved to only ${selected} of ${expected} official constituents. ` +
        "Refusing to run a full scan on a partial universe; check nifty500_membership and reconcile the official list against the instrument master."
    );
  }
}
