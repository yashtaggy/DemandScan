/**
 * Kite timestamp normalization tests.
 *
 * The helper must produce the correct UTC instant from the raw shapes Kite and
 * its SDK can supply, without depending on the process timezone:
 *  - 19-character IST wall clock strings,
 *  - SDK `Date` objects created from those wall clocks,
 *  - ISO strings with `Z` or an explicit offset,
 *  - invalid or impossible values.
 */

import { normalizeKiteTimestamp } from "@/lib/kite-timestamp";

describe("normalizeKiteTimestamp", () => {
  it("interprets the 19-character Kite wall clock as IST", () => {
    expect(normalizeKiteTimestamp("2026-11-06 09:28:41")).toBe(
      "2026-11-06T03:58:41.000Z"
    );
    expect(normalizeKiteTimestamp("2026-11-06T09:28:41")).toBe(
      "2026-11-06T03:58:41.000Z"
    );
    expect(normalizeKiteTimestamp(" 2026-11-06 09:28:41.250 ")).toBe(
      "2026-11-06T03:58:41.250Z"
    );
  });

  it("recovers the IST wall clock from an SDK Date", () => {
    // Constructed with local components, exactly like the SDK's
    // `new Date("YYYY-MM-DD HH:MM:SS")`. The local getters used by the helper
    // return the same components under every runtime timezone.
    expect(normalizeKiteTimestamp(new Date(2026, 10, 6, 9, 28, 41))).toBe(
      "2026-11-06T03:58:41.000Z"
    );
  });

  it("honours an explicit ISO UTC timestamp", () => {
    expect(normalizeKiteTimestamp("2026-11-06T09:28:41Z")).toBe(
      "2026-11-06T09:28:41.000Z"
    );
  });

  it("honours an explicit offset", () => {
    expect(normalizeKiteTimestamp("2026-11-06T09:28:41+05:30")).toBe(
      "2026-11-06T03:58:41.000Z"
    );
    expect(normalizeKiteTimestamp("2026-11-06T04:28:41-05:00")).toBe(
      "2026-11-06T09:28:41.000Z"
    );
  });

  it("rejects empty, unsupported and impossible values", () => {
    expect(normalizeKiteTimestamp("")).toBeNull();
    expect(normalizeKiteTimestamp("   ")).toBeNull();
    expect(normalizeKiteTimestamp("not-a-date")).toBeNull();
    expect(normalizeKiteTimestamp("2026-02-30 09:00:00")).toBeNull();
    expect(normalizeKiteTimestamp("2026-13-01 09:00:00")).toBeNull();
    expect(normalizeKiteTimestamp(null)).toBeNull();
    expect(normalizeKiteTimestamp(undefined)).toBeNull();
    expect(normalizeKiteTimestamp(42)).toBeNull();
    expect(normalizeKiteTimestamp(new Date(Number.NaN))).toBeNull();
  });

  it.each(["UTC", "Asia/Kolkata", "America/New_York"])(
    "normalizes identically under TZ=%s",
    (timezone) => {
      const original = process.env.TZ;
      try {
        process.env.TZ = timezone;
        expect(normalizeKiteTimestamp("2026-11-06 09:28:41")).toBe(
          "2026-11-06T03:58:41.000Z"
        );
        expect(normalizeKiteTimestamp(new Date(2026, 10, 6, 9, 28, 41))).toBe(
          "2026-11-06T03:58:41.000Z"
        );
      } finally {
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
      }
    }
  );
});
