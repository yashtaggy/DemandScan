/**
 * Kite Connect timestamp normalization.
 *
 * Kite returns quote timestamps as IST wall-clock values
 * (`YYYY-MM-DD HH:MM:SS`). The SDK converts exactly those 19-character fields
 * to a `Date` with `new Date(value)`, which interprets the wall clock in the
 * *server's* local timezone. On a non-IST runtime that instant is wrong by the
 * difference between the server timezone and IST.
 *
 * `normalizeKiteTimestamp` recovers the IST wall clock from an SDK `Date`
 * (its local components are exactly the original string, whatever the runtime
 * timezone), parses zone-less strings as IST directly, and leaves strings with
 * an explicit `Z`/offset as the absolute instant they declare. The result is
 * an ISO-8601 UTC string or `null`.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * A zone-less date-time. Kite emits 19 characters; fractional seconds are
 * accepted too so no zone-less value falls back to the runtime timezone.
 */
const WALL_CLOCK_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

function istWallClockToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number
): Date | null {
  if (
    year < 1000 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    millisecond > 999
  ) {
    return null;
  }

  const utcMs = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond
  );
  const roundTrip = new Date(utcMs);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute ||
    roundTrip.getUTCSeconds() !== second
  ) {
    return null;
  }

  return new Date(utcMs - IST_OFFSET_MS);
}

function sdkDateToInstant(value: Date): Date | null {
  return istWallClockToInstant(
    value.getFullYear(),
    value.getMonth() + 1,
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
    value.getSeconds(),
    value.getMilliseconds()
  );
}

/**
 * Normalizes a raw Kite timestamp to ISO-8601 UTC.
 *
 * - `Date`: an SDK-converted value. Its local components are the original IST
 *   wall clock, so they are reinterpreted as IST independent of runtime zone.
 * - Zone-less string: parsed as IST.
 * - String with `Z` or an explicit offset: parsed as that absolute instant.
 * - Anything else, or an impossible date: `null`.
 */
export function normalizeKiteTimestamp(value: unknown): string | null {
  let parsed: Date | null = null;

  if (value instanceof Date) {
    parsed = Number.isNaN(value.getTime()) ? null : sdkDateToInstant(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;

    const wallClock = WALL_CLOCK_PATTERN.exec(trimmed);
    if (wallClock) {
      parsed = istWallClockToInstant(
        Number(wallClock[1]),
        Number(wallClock[2]),
        Number(wallClock[3]),
        Number(wallClock[4]),
        Number(wallClock[5]),
        Number(wallClock[6]),
        wallClock[7] === undefined ? 0 : Number(wallClock[7].padEnd(3, "0"))
      );
    } else {
      const absolute = new Date(trimmed);
      parsed = Number.isNaN(absolute.getTime()) ? null : absolute;
    }
  }

  return parsed === null ? null : parsed.toISOString();
}
