import { getDb } from "../db";
import { createKiteClient } from "../kite-client";
import type { KiteSession } from "../types";
import type { Instrument } from "./types";

/**
 * Fetch the NSE instrument master from Kite and upsert into the `instruments` table.
 *
 * The function is idempotent – repeated calls will update existing rows without
 * deleting any data. It records the `source` as "kite" and updates `updated_at`.
 *
 * @param session - Valid Kite session containing an access token.
 * @returns the number of rows upserted/updated.
 */
function nseEquityRows(rawInstruments: any[]): Array<[number, string, string, string | null, boolean, string, Date]> {
  return rawInstruments
    .filter((raw) => raw.segment === "NSE" || raw.segment === "NSE-EQ")
    .filter((raw) => raw.instrument_type === "EQ")
    .map((raw) => [
      Number(raw.instrument_token),
      raw.tradingsymbol as string,
      raw.exchange as string,
      (raw.name ?? null) as string | null,
      true,
      "kite",
      new Date(),
    ]);
}

async function upsertInstrumentRow(
  sql: ReturnType<typeof getDb>,
  v: [number, string, string, string | null, boolean, string, Date]
): Promise<void> {
  await sql`
    INSERT INTO instruments (
      instrument_id, symbol, exchange, company_name, active, source, updated_at
    ) VALUES (
      ${v[0]}, ${v[1]}, ${v[2]},
      ${v[3]}, ${v[4]}, ${v[5]}, ${v[6]}
    )
    ON CONFLICT (instrument_id) DO UPDATE SET
      symbol       = EXCLUDED.symbol,
      exchange     = EXCLUDED.exchange,
      company_name = EXCLUDED.company_name,
      active       = EXCLUDED.active,
      source       = EXCLUDED.source,
      updated_at   = EXCLUDED.updated_at
  `;
}

export async function syncNseInstruments(session: KiteSession): Promise<number> {
  const kc = createKiteClient(session.accessToken);
  const rawInstruments = (await kc.getInstruments("NSE")) as any[];
  const sql = getDb();
  let upsertCount = 0;

  const BATCH_SIZE = 500;
  const values = nseEquityRows(rawInstruments);
  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const batch = values.slice(i, i + BATCH_SIZE);
    for (const v of batch) {
      await upsertInstrumentRow(sql, v);
      upsertCount++;
    }
  }

  return upsertCount;
}

/**
 * Idempotent instrument-master upsert for one bounded slice, ordered by token.
 * Re-fetches the Kite master each call (one API request) then skips tokens
 * already processed according to `afterInstrumentId`.
 */
export async function syncNseInstrumentsChunk(
  session: KiteSession,
  afterInstrumentId: number,
  limit: number
): Promise<{ upserted: number; lastId: number; done: boolean }> {
  const kc = createKiteClient(session.accessToken);
  const rawInstruments = (await kc.getInstruments("NSE")) as any[];
  const sql = getDb();

  const remaining = nseEquityRows(rawInstruments)
    .sort((a, b) => a[0] - b[0])
    .filter((v) => v[0] > afterInstrumentId);

  const batch = remaining.slice(0, limit);
  for (const v of batch) {
    await upsertInstrumentRow(sql, v);
  }

  const lastId = batch.length > 0 ? batch[batch.length - 1][0] : afterInstrumentId;
  return {
    upserted: batch.length,
    lastId,
    done: remaining.length <= limit,
  };
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
