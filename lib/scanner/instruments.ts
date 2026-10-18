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
export async function syncNseInstruments(session: KiteSession): Promise<number> {
  const kc = createKiteClient(session.accessToken);
  // KiteConnect SDK method: getInstruments("NSE") returns a list of instruments.
  const rawInstruments = (await kc.getInstruments("NSE")) as any[]; // SDK typing is loose.

  const sql = getDb();
  let upsertCount = 0;

  // Process in batches to avoid huge single queries. Batch size 500.
  const BATCH_SIZE = 500;
  for (let i = 0; i < rawInstruments.length; i += BATCH_SIZE) {
    const batch = rawInstruments.slice(i, i + BATCH_SIZE);
    const values = batch
      .filter((raw) => raw.segment === "NSE" || raw.segment === "NSE-EQ")
      .filter((raw) => raw.instrument_type === "EQ")
      .map((raw) => [
        Number(raw.instrument_token), // instrument_id
        raw.tradingsymbol,
        raw.exchange,
        raw.name ?? null,
        true, // active – we only fetch currently active EQ instruments
        "kite",
        new Date(), // updated_at
      ]);

    if (values.length === 0) continue;

    // Use individual upserts per row to remain compatible with Neon's tagged-template driver.
    for (const v of values) {
      await sql`
        INSERT INTO instruments (
          instrument_id, symbol, exchange, company_name, active, source, updated_at
        ) VALUES (
          ${v[0] as number}, ${v[1] as string}, ${v[2] as string},
          ${v[3] as string | null}, ${v[4] as boolean}, ${v[5] as string}, ${v[6] as Date}
        )
        ON CONFLICT (instrument_id) DO UPDATE SET
          symbol       = EXCLUDED.symbol,
          exchange     = EXCLUDED.exchange,
          company_name = EXCLUDED.company_name,
          active       = EXCLUDED.active,
          source       = EXCLUDED.source,
          updated_at   = EXCLUDED.updated_at
      `;
      upsertCount++;
    }
  }

  return upsertCount;
}

/** Alias for backward compatibility with orchestrator imports. */
export const syncInstruments = syncNseInstruments;
