/**
 * lib/scanner/four_hour_agg.ts
 *
 * Aggregates 60-minute candles into 4-hour session bars for NSE.
 *
 * ─── Session alignment (documented) ─────────────────────────────────────────
 *
 * NSE trading hours: 09:15 – 15:30 IST (375 minutes per day)
 *
 * Two sessions per day:
 *   AM session: 09:15 – 13:15 IST (4 × 60-min candles: 09:15, 10:15, 11:15, 12:15)
 *               → is_complete = TRUE  → eligible for zone formation
 *   PM session: 13:15 – 15:30 IST (3 × 60-min candles: 13:15, 14:15, 15:15)
 *               → is_complete = FALSE → stored but EXCLUDED from zone formation
 *               (only ~2h 15min, not a full 4-hour session)
 *
 * Cross-session grouping is NEVER performed.
 * Zones may only be detected from bars where is_complete = TRUE (AM session).
 *
 * ─── Validation example ────────────────────────────────────────────────────
 * Date: 2024-01-15 (Monday)
 * 1H bars: 09:15, 10:15, 11:15, 12:15, 13:15, 14:15, 15:15
 * AM bar:  open=09:15.open, high=max(09:15–12:15), low=min, close=12:15.close, count=4, complete=TRUE
 * PM bar:  open=13:15.open, high=max(13:15–15:15), low=min, close=15:15.close, count=3, complete=FALSE
 */

import { getDb } from '../db';
import { bulkUpsert } from './bulk';

// IST offset in minutes
const IST_OFFSET_MIN = 5 * 60 + 30; // 330

// AM session start/end in minutes from midnight IST
const AM_START_MIN = 9  * 60 + 15; // 555
const AM_END_MIN   = 13 * 60 + 15; // 795
const PM_START_MIN = 13 * 60 + 15; // 795
const PM_END_MIN   = 15 * 60 + 30; // 930

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert UTC timestamp to IST minutes-since-midnight */
function toIstMinutes(ts: Date): number {
  const istMs = ts.getTime() + IST_OFFSET_MIN * 60 * 1000;
  const ist = new Date(istMs);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** Convert UTC timestamp to IST date string YYYY-MM-DD */
function toIstDateStr(ts: Date): string {
  const istMs = ts.getTime() + IST_OFFSET_MIN * 60 * 1000;
  const ist = new Date(istMs);
  const yyyy = ist.getUTCFullYear();
  const mm   = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(ist.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Build the session_ts (TIMESTAMPTZ in UTC) from an IST date string and IST start minutes */
function buildSessionTs(istDateStr: string, sessionStartMin: number): Date {
  // Parse YYYY-MM-DD in IST, then subtract IST offset to get UTC
  const [yyyy, mm, dd] = istDateStr.split('-').map(Number);
  const istMidnightUtcMs = Date.UTC(yyyy, mm - 1, dd) - IST_OFFSET_MIN * 60 * 1000;
  return new Date(istMidnightUtcMs + sessionStartMin * 60 * 1000);
}

interface HourlyRow {
  instrumentId: number;
  candleTs: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Aggregate a single instrument ───────────────────────────────────────────

/**
 * Build 4H candles for a single instrument from its stored hourly_candles.
 * Only processes candles within the NSE trading session (is_session_complete = TRUE).
 * Upserts into four_hour_candles.
 */
export async function aggregate4HForInstrument(instrumentId: number): Promise<number> {
  const sql = getDb();

  // Incremental: re-aggregate only from the last stored session onwards.
  // The last session is always rebuilt so an intraday-partial session is
  // corrected once its remaining hourly bars arrive. If a historical backfill
  // added hourly bars before the oldest stored session, rebuild from the start
  // once so backfilled history is never silently left out.
  const boundsRows = await sql`
    SELECT
      (SELECT MAX(session_ts) FROM four_hour_candles
       WHERE instrument_id = ${instrumentId}) AS last_ts,
      (SELECT MIN(session_ts) FROM four_hour_candles
       WHERE instrument_id = ${instrumentId}) AS first_session_ts,
      (SELECT MIN(candle_ts) FROM hourly_candles
       WHERE instrument_id = ${instrumentId} AND is_session_complete = TRUE) AS first_hourly_ts
  `;
  const rawLast = boundsRows[0]?.last_ts;
  const rawFirstSession = boundsRows[0]?.first_session_ts;
  const rawFirstHourly = boundsRows[0]?.first_hourly_ts;
  const parsedLast = rawLast ? new Date(rawLast as string) : null;
  const parsedFirstSession = rawFirstSession ? new Date(rawFirstSession as string) : null;
  const parsedFirstHourly = rawFirstHourly ? new Date(rawFirstHourly as string) : null;
  const backfilled =
    parsedFirstHourly != null &&
    !Number.isNaN(parsedFirstHourly.getTime()) &&
    (parsedFirstSession == null ||
      Number.isNaN(parsedFirstSession.getTime()) ||
      parsedFirstHourly < parsedFirstSession);
  const since =
    !backfilled && parsedLast && !Number.isNaN(parsedLast.getTime()) ? parsedLast : null;

  const rows = since
    ? await sql`
        SELECT instrument_id, candle_ts, open, high, low, close, volume
        FROM hourly_candles
        WHERE instrument_id   = ${instrumentId}
          AND is_session_complete = TRUE
          AND candle_ts >= ${since}
        ORDER BY candle_ts ASC
      `
    : await sql`
        SELECT instrument_id, candle_ts, open, high, low, close, volume
        FROM hourly_candles
        WHERE instrument_id   = ${instrumentId}
          AND is_session_complete = TRUE
        ORDER BY candle_ts ASC
      `;

  if (rows.length === 0) return 0;

  const candles: HourlyRow[] = rows.map((r: any) => ({
    instrumentId: Number(r.instrument_id),
    candleTs: new Date(r.candle_ts),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));

  // Group by IST date + session
  type SessionGroup = {
    dateStr: string;
    session: 'AM' | 'PM';
    bars: HourlyRow[];
  };

  const groupMap = new Map<string, SessionGroup>();

  for (const c of candles) {
    const istMin  = toIstMinutes(c.candleTs);
    const dateStr = toIstDateStr(c.candleTs);

    let session: 'AM' | 'PM' | null = null;
    if (istMin >= AM_START_MIN && istMin < AM_END_MIN)   session = 'AM';
    else if (istMin >= PM_START_MIN && istMin < PM_END_MIN) session = 'PM';

    if (!session) continue; // outside NSE hours — skip

    const key = `${dateStr}|${session}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, { dateStr, session, bars: [] });
    }
    groupMap.get(key)!.bars.push(c);
  }

  const fourHourRows: unknown[][] = [];

  for (const { dateStr, session, bars } of groupMap.values()) {
    if (bars.length === 0) continue;

    const open   = bars[0].open;
    const close  = bars[bars.length - 1].close;
    const high   = Math.max(...bars.map((b) => b.high));
    const low    = Math.min(...bars.map((b) => b.low));
    const volume = bars.reduce((s, b) => s + b.volume, 0);
    const count  = bars.length;

    // AM session is only "complete" when it has the expected 4 candles
    // (on holidays or data gaps, it may have fewer)
    const isComplete = session === 'AM' && count >= 4;

    const sessionStartMin = session === 'AM' ? AM_START_MIN : PM_START_MIN;
    const sessionTs = buildSessionTs(dateStr, sessionStartMin);

    fourHourRows.push([
      instrumentId,
      sessionTs,
      session,
      open,
      high,
      low,
      close,
      volume,
      count,
      isComplete,
    ]);
  }

  const upserted = await bulkUpsert({
    table: 'four_hour_candles',
    columns: [
      'instrument_id',
      'session_ts',
      'session_label',
      'open',
      'high',
      'low',
      'close',
      'volume',
      'candle_count',
      'is_complete',
    ],
    rows: fourHourRows,
    conflictClause: `ON CONFLICT (instrument_id, session_ts) DO UPDATE SET
      open         = EXCLUDED.open,
      high         = EXCLUDED.high,
      low          = EXCLUDED.low,
      close        = EXCLUDED.close,
      volume       = EXCLUDED.volume,
      candle_count = EXCLUDED.candle_count,
      is_complete  = EXCLUDED.is_complete`,
  });

  // Update candle coverage for 4H
  await sql`
    INSERT INTO candle_coverage (instrument_id, timeframe, first_candle, last_candle, total_candles, last_updated)
    SELECT
      instrument_id,
      '4H',
      MIN(session_ts::date),
      MAX(session_ts::date),
      COUNT(*),
      NOW()
    FROM four_hour_candles
    WHERE instrument_id = ${instrumentId}
    GROUP BY instrument_id
    ON CONFLICT (instrument_id, timeframe) DO UPDATE SET
      first_candle  = EXCLUDED.first_candle,
      last_candle   = EXCLUDED.last_candle,
      total_candles = EXCLUDED.total_candles,
      last_updated  = EXCLUDED.last_updated
  `;

  return upserted;
}

/**
 * Aggregate 4H candles for all instruments with hourly data.
 */
export async function aggregate4HForAll(): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    SELECT DISTINCT instrument_id FROM hourly_candles
  `;
  let total = 0;
  for (const r of rows) {
    total += await aggregate4HForInstrument(Number(r.instrument_id));
  }
  return total;
}
