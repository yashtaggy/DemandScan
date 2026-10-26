import { getDb } from "../db";
import { createKiteClient } from "../kite-client";
import type { KiteSession } from "../types";
import { bulkUpsert } from "./bulk";
import { seedNifty500Membership, type MembershipSeedResult } from "./universe";

/**
 * Extract NSE equity rows from a Kite instrument master.
 * Deduplicated by instrument token (the master can contain repeated tokens).
 */
function nseEquityRows(
  rawInstruments: any[]
): Array<[number, string, string, string | null, boolean, string, Date]> {
  const byToken = new Map<number, [number, string, string, string | null, boolean, string, Date]>();
  const now = new Date();

  for (const raw of rawInstruments) {
    if (raw.segment !== "NSE" && raw.segment !== "NSE-EQ") continue;
    if (raw.instrument_type !== "EQ") continue;
    const token = Number(raw.instrument_token);
    if (!Number.isFinite(token)) continue;
    byToken.set(token, [
      token,
      raw.tradingsymbol as string,
      raw.exchange as string,
      (raw.name ?? null) as string | null,
      true,
      "kite",
      now,
    ]);
  }

  return [...byToken.values()];
}

async function upsertInstrumentRows(
  rows: Array<[number, string, string, string | null, boolean, string, Date]>
): Promise<number> {
  return bulkUpsert({
    table: "instruments",
    columns: [
      "instrument_id",
      "symbol",
      "exchange",
      "company_name",
      "active",
      "source",
      "updated_at",
    ],
    rows,
    conflictClause: `ON CONFLICT (instrument_id) DO UPDATE SET
      symbol       = EXCLUDED.symbol,
      exchange     = EXCLUDED.exchange,
      company_name = EXCLUDED.company_name,
      active       = EXCLUDED.active,
      source       = EXCLUDED.source,
      updated_at   = EXCLUDED.updated_at`,
  });
}

export interface InstrumentSyncResult {
  /** Instrument rows upserted from the Kite master. */
  upserted: number;
  /** Rows added to nifty500_membership by this sync (0 if already seeded). */
  membershipSeeded: number;
  universe: MembershipSeedResult;
}

/**
 * Download the NSE instrument master ONCE, upsert all NSE EQ rows, and seed
 * the Nifty 500 membership table from the curated constituent list.
 *
 * One download per sync stage — the previous chunked implementation
 * re-downloaded the full master for every 120 instruments.
 */
export async function syncInstrumentMaster(
  session: KiteSession
): Promise<InstrumentSyncResult> {
  const kc = createKiteClient(session.accessToken);
  const rawInstruments = (await kc.getInstruments("NSE")) as unknown as any[];

  const rows = nseEquityRows(rawInstruments);
  const upserted = await upsertInstrumentRows(rows);
  const universe = await seedNifty500Membership();

  console.info(
    `[scanner] instrument sync: nseEquity=${upserted} curated=${universe.curated} ` +
      `matched=${universe.matched} membershipSeeded=${universe.seeded} ` +
      `membershipClosed=${universe.removed} placeholdersExcluded=${universe.excludedPlaceholders.length}`
  );

  return { upserted, membershipSeeded: universe.seeded, universe };
}

/** Full instrument sync (kept for local/long-running callers). */
export async function syncNseInstruments(session: KiteSession): Promise<number> {
  return (await syncInstrumentMaster(session)).upserted;
}

export async function listActiveInstrumentIds(limitToIds?: number[]): Promise<number[]> {
  const sql = getDb();
  let rows;
  if (limitToIds && limitToIds.length > 0) {
    rows = await sql`
      SELECT instrument_id FROM instruments
      WHERE active = true AND instrument_id = ANY(${limitToIds}::bigint[])
      ORDER BY instrument_id
    `;
  } else {
    rows = await sql`
      SELECT instrument_id FROM instruments WHERE active = true ORDER BY instrument_id
    `;
  }
  return rows.map((r: any) => Number(r.instrument_id));
}

export async function resolveInstrumentIdsBySymbol(symbols: string[]): Promise<number[]> {
  if (symbols.length === 0) return [];
  const sql = getDb();
  const rows = await sql`
    SELECT instrument_id FROM instruments
    WHERE active = true AND symbol = ANY(${symbols}::text[])
    ORDER BY instrument_id
  `;
  return rows.map((r: any) => Number(r.instrument_id));
}

/** Alias for backward compatibility with orchestrator imports. */
export const syncInstruments = syncNseInstruments;
