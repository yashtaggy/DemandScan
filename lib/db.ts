/**
 * Neon serverless Postgres client.
 *
 * Uses @neondatabase/serverless which is optimised for serverless/edge:
 *  - HTTP-mode queries (no persistent TCP connection required).
 *  - Works in Vercel serverless functions without any special config.
 *
 * The DATABASE_URL env var must be the Neon connection string from your
 * Neon project dashboard (starts with postgres:// or postgresql://).
 *
 * This module NEVER returns credentials or raw SQL to the browser.
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<false, false> | null = null;

/**
 * Returns a lazy-initialised Neon SQL query function.
 * Throws a clear configuration error if DATABASE_URL is absent.
 */
export function getDb(): NeonQueryFunction<false, false> {
  if (_sql) return _sql;

  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === "") {
    throw new Error(
      "DATABASE_URL environment variable is not set. " +
        "Create a Neon project at https://neon.tech, copy the connection string, " +
        "and add it to your .env.local file and Vercel environment variables."
    );
  }

  _sql = neon(url.trim());
  return _sql;
}
