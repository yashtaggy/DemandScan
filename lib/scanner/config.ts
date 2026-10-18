import { getDb } from "../db";
import { DEFAULT_SCANNER_CONFIG } from "./types";

/**
 * Insert a default scanner configuration row if none exists.
 * Returns the UUID of the config row.
 */
export async function getOrCreateDefaultConfig(): Promise<string> {
  const sql = getDb();
  const existing = await sql`SELECT config_id FROM scanner_configs ORDER BY created_at LIMIT 1`;
  if (existing.length) return existing[0].config_id as string;

  const configJson = JSON.stringify(DEFAULT_SCANNER_CONFIG);

  const result = await sql`
    INSERT INTO scanner_configs (version, config_json)
    VALUES (${DEFAULT_SCANNER_CONFIG.version}, ${configJson}::jsonb)
    RETURNING config_id
  `;
  return result[0].config_id as string;
}
