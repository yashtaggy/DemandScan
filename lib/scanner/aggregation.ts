import { getDb } from '@/lib/db';
import type { AggregationTimeframe } from './types';

/**
 * Aggregates daily candles into higher timeframes and stores results in
 * `aggregated_candles` (idempotent – safe to re-run).
 *
 * Supported timeframes:
 *  - '1W'  → ISO week (Monday start)
 *  - '1M'  → calendar month
 *  - '3M'  → calendar quarter (Jan/Apr/Jul/Oct)
 *  - '6M'  → half-year (Jan or Jul start)
 *  - '1Y'  → calendar year
 *
 * All period boundaries are calculated in Asia/Kolkata timezone so they
 * align with Indian market days.
 */
export async function aggregateAllTimeframes(): Promise<void> {
  const sql = getDb();

  const timeframes: AggregationTimeframe[] = ['1W', '1M', '3M', '6M', '1Y'];

  for (const tf of timeframes) {
    // Build the period_start expression per timeframe.
    // daily_candles.candle_date is a DATE column (no timezone); we cast it to
    // TIMESTAMPTZ assuming midnight IST before truncating.
    const periodExpr = getPeriodExpression(tf);

    await sql.unsafe(`
      INSERT INTO aggregated_candles (
        instrument_token, timeframe, period_start,
        open, high, low, close, volume, created_at
      )
      SELECT
        sub.instrument_token,
        '${tf}'                 AS timeframe,
        sub.period_start,
        sub.open,
        sub.high,
        sub.low,
        sub.close,
        sub.volume,
        NOW()                   AS created_at
      FROM (
        SELECT
          instrument_id                                         AS instrument_token,
          (${periodExpr})                                       AS period_start,
          (ARRAY_AGG(open  ORDER BY candle_date ASC ))[1]      AS open,
          MAX(high)                                             AS high,
          MIN(low)                                              AS low,
          (ARRAY_AGG(close ORDER BY candle_date DESC))[1]      AS close,
          SUM(volume)                                           AS volume
        FROM daily_candles
        GROUP BY instrument_id, (${periodExpr})
      ) sub
      ON CONFLICT (instrument_token, timeframe, period_start)
      DO UPDATE SET
        open       = EXCLUDED.open,
        high       = EXCLUDED.high,
        low        = EXCLUDED.low,
        close      = EXCLUDED.close,
        volume     = EXCLUDED.volume,
        created_at = EXCLUDED.created_at
    `);
  }
}

/**
 * Returns the SQL expression that computes the period_start DATE for a row in
 * daily_candles, given a timeframe. The `candle_date` column is a plain DATE.
 */
function getPeriodExpression(tf: AggregationTimeframe): string {
  switch (tf) {
    case '1W':
      // ISO week Monday
      return "date_trunc('week', candle_date + INTERVAL '0' DAY)::date";
    case '1M':
      return "date_trunc('month', candle_date)::date";
    case '3M':
      return "date_trunc('quarter', candle_date)::date";
    case '6M':
      // Half-year: Jan 1 or Jul 1 of the same year
      return `make_date(
          EXTRACT(YEAR FROM candle_date)::int,
          CASE WHEN EXTRACT(MONTH FROM candle_date) <= 6 THEN 1 ELSE 7 END,
          1
        )`;
    case '1Y':
      return "date_trunc('year', candle_date)::date";
  }
}

/**
 * Aggregate a single instrument across all timeframes.
 * Useful for incremental updates after new candles arrive.
 */
export async function aggregateInstrument(instrumentId: number): Promise<void> {
  const sql = getDb();
  const timeframes: AggregationTimeframe[] = ['1W', '1M', '3M', '6M', '1Y'];

  for (const tf of timeframes) {
    const periodExpr = getPeriodExpression(tf);

    await sql.unsafe(`
      INSERT INTO aggregated_candles (
        instrument_token, timeframe, period_start,
        open, high, low, close, volume, created_at
      )
      SELECT
        sub.instrument_token,
        '${tf}'        AS timeframe,
        sub.period_start,
        sub.open, sub.high, sub.low, sub.close, sub.volume,
        NOW()          AS created_at
      FROM (
        SELECT
          instrument_id                                         AS instrument_token,
          (${periodExpr})                                       AS period_start,
          (ARRAY_AGG(open  ORDER BY candle_date ASC ))[1]      AS open,
          MAX(high)                                             AS high,
          MIN(low)                                              AS low,
          (ARRAY_AGG(close ORDER BY candle_date DESC))[1]      AS close,
          SUM(volume)                                           AS volume
        FROM daily_candles
        WHERE instrument_id = ${instrumentId}
        GROUP BY instrument_id, (${periodExpr})
      ) sub
      ON CONFLICT (instrument_token, timeframe, period_start)
      DO UPDATE SET
        open       = EXCLUDED.open,
        high       = EXCLUDED.high,
        low        = EXCLUDED.low,
        close      = EXCLUDED.close,
        volume     = EXCLUDED.volume,
        created_at = EXCLUDED.created_at
    `);
  }
}

/**
 * Fetch aggregated candles for an instrument + timeframe ordered by period_start ASC.
 */
export async function getAggregatedCandles(
  instrumentId: number,
  timeframe: AggregationTimeframe,
  limit = 500
): Promise<Array<{
  instrumentToken: number;
  timeframe: AggregationTimeframe;
  periodStart: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}>> {
  const sql = getDb();
  const rows = await sql`
    SELECT instrument_token, timeframe, period_start,
           open, high, low, close, volume
    FROM aggregated_candles
    WHERE instrument_token = ${instrumentId}
      AND timeframe = ${timeframe}
    ORDER BY period_start ASC
    LIMIT ${limit}
  `;
  return rows.map((r: any) => ({
    instrumentToken: Number(r.instrument_token),
    timeframe: r.timeframe as AggregationTimeframe,
    periodStart: new Date(r.period_start),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}
