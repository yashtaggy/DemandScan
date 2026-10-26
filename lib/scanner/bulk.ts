/**
 * lib/scanner/bulk.ts
 *
 * Multi-row parameterized INSERT helper for the Neon HTTP driver.
 *
 * The tagged-template API (`sql\`...\``) issues one HTTP round trip per call,
 * which made per-candle inserts the dominant cost of a cold scan. `sql.query`
 * accepts numbered placeholders, so many rows can be written per round trip.
 *
 * Table/column/conflict strings are code constants — never user input. All
 * values are bound parameters.
 */

import { getDb } from '@/lib/db';

type Sql = ReturnType<typeof getDb>;

export interface BulkUpsertOptions {
  table: string;
  columns: string[];
  rows: unknown[][];
  /** Full conflict clause, e.g. "ON CONFLICT (a, b) DO UPDATE SET ..." */
  conflictClause: string;
  /** Rows per statement. 500 rows × 8 columns = 4,000 bind params. */
  chunkSize?: number;
}

export async function bulkUpsert(opts: BulkUpsertOptions): Promise<number> {
  if (opts.rows.length === 0) return 0;
  const sql: Sql = getDb();
  const chunkSize = opts.chunkSize ?? 500;
  const width = opts.columns.length;

  let written = 0;
  for (let start = 0; start < opts.rows.length; start += chunkSize) {
    const chunk = opts.rows.slice(start, start + chunkSize);
    const params: unknown[] = [];
    const tuples = chunk.map((row, rowIdx) => {
      if (row.length !== width) {
        throw new Error(`bulkUpsert(${opts.table}): row has ${row.length} values, expected ${width}`);
      }
      const placeholders: string[] = [];
      for (let col = 0; col < width; col++) {
        placeholders.push(`$${rowIdx * width + col + 1}`);
      }
      for (const value of row) params.push(value);
      return `(${placeholders.join(', ')})`;
    });

    const text =
      `INSERT INTO ${opts.table} (${opts.columns.join(', ')}) ` +
      `VALUES ${tuples.join(', ')} ${opts.conflictClause}`;

    await sql.query(text, params);
    written += chunk.length;
  }
  return written;
}
