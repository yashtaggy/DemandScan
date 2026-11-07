/**
 * Demand/supply zone tests.
 *
 * Pure coverage classification, batched nearest-zone selection, the board
 * extension built on the same batched reads, expanded-zone pagination and the
 * strict query parser.
 *
 * The scaffold exercises the real service and repository against the stateful
 * fake database. Only the database driver is substituted.
 */

import type { LiveTradeOwnerId } from "@/lib/live-trade/types";
import { LiveTradeError } from "@/lib/live-trade/errors";
import {
  parseBoardQuery,
  parseInstrumentIdList,
  parseQuoteQuery,
  parseZoneListQuery,
} from "@/lib/live-trade/query";
import {
  classifyZoneCoverage,
  describeTimeframeMatch,
  isCoveringScanFresh,
} from "@/lib/live-trade/zone-selection";
import {
  getBoard,
  getZoneOverviewsAt,
  type LiveTradeZoneQueryOptions,
} from "@/lib/live-trade/service";
import { FakeLiveTradeDb } from "./fake-db";

jest.mock("@/lib/db", () => ({
  getDb: () => globalStore.__liveTradeDb,
}));

const mockFake = new FakeLiveTradeDb();
const globalStore = globalThis as typeof globalThis & {
  __liveTradeDb?: unknown;
};

const OWNER_A = "owner-a" as LiveTradeOwnerId;
const OWNER_B = "owner-b" as LiveTradeOwnerId;

/** Friday 2026-11-06, 10:30 IST. */
const NOW = new Date("2026-11-06T05:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function options(
  overrides: Partial<LiveTradeZoneQueryOptions> = {}
): LiveTradeZoneQueryOptions {
  return {
    hasTimeframeOverride: false,
    timeframeOverride: null,
    includeExpanded: false,
    limit: 100,
    offset: 0,
    ...overrides,
  };
}

async function expectLiveTradeError(
  promise: Promise<unknown>,
  code: string
): Promise<LiveTradeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LiveTradeError);
    const liveTradeError = error as LiveTradeError;
    expect(liveTradeError.code).toBe(code);
    return liveTradeError;
  }
  throw new Error(`expected LiveTradeError ${code}`);
}

function summaryOf(
  summaries: Awaited<ReturnType<typeof getZoneOverviewsAt>>["summaries"],
  instrumentId: number
) {
  const summary = summaries.find((row) => row.instrumentId === instrumentId);
  if (!summary) throw new Error(`missing summary for ${instrumentId}`);
  return summary;
}

beforeEach(() => {
  mockFake.reset();
  globalStore.__liveTradeDb = mockFake.sql;
  mockFake.setNow(NOW);
  mockFake.seedInstrument({ instrument_id: 1, symbol: "INFY" });
  mockFake.seedInstrument({ instrument_id: 2, symbol: "TCS" });
  mockFake.seedItem({ owner: "owner-a", instrumentId: 1, timeframe: "1D" });
  mockFake.seedItem({ owner: "owner-a", instrumentId: 2, timeframe: "1D" });
  mockFake.seedMembership(1);
  mockFake.seedMembership(2);
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Pure coverage classification ───────────────────────────────────────────

describe("zone coverage classification", () => {
  const base = {
    inUniverse: true,
    zoneCount: 1,
    latestCoveringScanAt: NOW,
    hasAnySuccessScan: true,
    hasUnattributableScan: false,
    now: NOW,
  };

  it("reports OUTSIDE_SCANNER_UNIVERSE before anything else", () => {
    expect(
      classifyZoneCoverage({ ...base, inUniverse: false })
    ).toBe("OUTSIDE_SCANNER_UNIVERSE");
  });

  it("reports AVAILABLE for zones with a fresh covering scan", () => {
    expect(classifyZoneCoverage(base)).toBe("AVAILABLE");
  });

  it("reports STALE when zones exist but the covering scan is old", () => {
    expect(
      classifyZoneCoverage({
        ...base,
        latestCoveringScanAt: new Date(NOW.getTime() - 8 * DAY),
      })
    ).toBe("STALE");
  });

  it("reports UNKNOWN when zones exist but no scan can be attributed", () => {
    expect(
      classifyZoneCoverage({ ...base, latestCoveringScanAt: null })
    ).toBe("UNKNOWN");
  });

  it("reports NO_ZONES for a fresh covering scan with no zone rows", () => {
    expect(classifyZoneCoverage({ ...base, zoneCount: 0 })).toBe("NO_ZONES");
  });

  it("reports STALE for an old covering scan with no zone rows", () => {
    expect(
      classifyZoneCoverage({
        ...base,
        zoneCount: 0,
        latestCoveringScanAt: new Date(NOW.getTime() - 8 * DAY),
      })
    ).toBe("STALE");
  });

  it("reports NO_SCAN_HISTORY only when scans exist but none cover it", () => {
    expect(
      classifyZoneCoverage({
        ...base,
        zoneCount: 0,
        latestCoveringScanAt: null,
      })
    ).toBe("NO_SCAN_HISTORY");
  });

  it("does not guess between NO_ZONES and NO_SCAN_HISTORY", () => {
    expect(
      classifyZoneCoverage({
        ...base,
        zoneCount: 0,
        latestCoveringScanAt: null,
        hasUnattributableScan: true,
      })
    ).toBe("UNKNOWN");
  });

  it("reports UNKNOWN when no successful scan exists at all", () => {
    expect(
      classifyZoneCoverage({
        ...base,
        zoneCount: 0,
        latestCoveringScanAt: null,
        hasAnySuccessScan: false,
      })
    ).toBe("UNKNOWN");
  });

  it("treats exactly seven days as fresh", () => {
    expect(isCoveringScanFresh(new Date(NOW.getTime() - 7 * DAY), NOW)).toBe(
      true
    );
    expect(isCoveringScanFresh(new Date(NOW.getTime() - 7 * DAY - 1), NOW)).toBe(
      false
    );
    expect(isCoveringScanFresh(null, NOW)).toBe(false);
  });

  it("describes ANY, PREFERRED and FALLBACK timeframe matches", () => {
    expect(describeTimeframeMatch(null, "1D")).toBe("ANY");
    expect(describeTimeframeMatch("1D", "1D")).toBe("PREFERRED");
    expect(describeTimeframeMatch("1D", "1W")).toBe("FALLBACK");
  });
});

// ─── Nearest selection ──────────────────────────────────────────────────────

describe("nearest zone selection", () => {
  it("prefers the item's saved timeframe over a structurally closer zone", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1W",
      proximal: 120,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 100,
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    const summary = summaryOf(result.summaries, 1);

    expect(summary.preferredTimeframe).toBe("1D");
    expect(summary.nearestDemand).toMatchObject({
      timeframe: "1D",
      proximal: 100,
      timeframeMatch: "PREFERRED",
    });
  });

  it("falls back to another timeframe and labels it FALLBACK", async () => {
    // Replace the default 1D item for this instrument with a 4H preference.
    const owned = mockFake.items.find(
      (item) => item.owner_user_id === "owner-a" && item.instrument_id === 1
    );
    owned!.timeframe = "4H";

    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 100,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1W",
      proximal: 110,
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    const demand = summaryOf(result.summaries, 1).nearestDemand;

    expect(demand).toMatchObject({
      timeframe: "1W",
      timeframeMatch: "FALLBACK",
    });
  });

  it("applies a timeframe override to every selected instrument", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1W",
      proximal: 90,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 100,
    });

    const result = await getZoneOverviewsAt(
      NOW,
      OWNER_A,
      options({ hasTimeframeOverride: true, timeframeOverride: "1W", instrumentIds: [1] })
    );

    expect(summaryOf(result.summaries, 1).nearestDemand).toMatchObject({
      timeframe: "1W",
      timeframeMatch: "PREFERRED",
    });
    expect(result.timeframeContext).toEqual({ hasOverride: true, value: "1W" });
  });

  it("treats an `any` override as all timeframes", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1W",
      proximal: 90,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      timeframe: "1D",
      proximal: 100,
    });

    const result = await getZoneOverviewsAt(
      NOW,
      OWNER_A,
      options({ hasTimeframeOverride: true, timeframeOverride: null, instrumentIds: [1] })
    );

    expect(summaryOf(result.summaries, 1).nearestDemand).toMatchObject({
      timeframe: "1D",
      proximal: 100,
      timeframeMatch: "ANY",
    });
  });

  it("selects the highest proximal demand zone", async () => {
    for (const proximal of [100, 120, 110]) {
      mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal });
    }
    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    expect(summaryOf(result.summaries, 1).nearestDemand?.proximal).toBe(120);
  });

  it("selects the lowest proximal supply zone", async () => {
    for (const proximal of [120, 90, 70]) {
      mockFake.seedZone({ instrumentId: 1, side: "SUPPLY", proximal });
    }
    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    expect(summaryOf(result.summaries, 1).nearestSupply?.proximal).toBe(70);
  });

  it("never selects a BROKEN zone, even when it is closest", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 150,
      lifecycle: "BROKEN",
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      lifecycle: "CONFIRMED_FRESH",
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    expect(summaryOf(result.summaries, 1).nearestDemand).toMatchObject({
      proximal: 100,
      lifecycleState: "CONFIRMED_FRESH",
    });
  });

  it("returns null when every zone on a side is BROKEN", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 150,
      lifecycle: "BROKEN",
    });
    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    expect(summaryOf(result.summaries, 1).nearestDemand).toBeNull();
  });

  it("excludes a non-positive proximal from selection", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 0 });
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    expect(summaryOf(result.summaries, 1).nearestDemand?.proximal).toBe(100);
  });

  it("breaks a proximal tie with the newest formation", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      formationTs: new Date("2026-10-01T00:00:00Z"),
      zoneId: "00000000-0000-4000-8000-000000000001",
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      formationTs: new Date("2026-11-01T00:00:00Z"),
      zoneId: "00000000-0000-4000-8000-000000000002",
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    expect(summaryOf(result.summaries, 1).nearestDemand?.zoneId).toBe(
      "00000000-0000-4000-8000-000000000002"
    );
  });

  it("retains zones with a Formation Score below 50 and uses zones.score", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      score: 37,
    });
    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());

    expect(summaryOf(result.summaries, 1).nearestDemand).toMatchObject({
      formationScore: 37,
    });
  });

  it("preserves the scanner lifecycle state", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "SUPPLY",
      proximal: 110,
      lifecycle: "TOUCHED_ONCE",
      touchCount: 1,
    });
    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());

    expect(summaryOf(result.summaries, 1).nearestSupply).toMatchObject({
      lifecycleState: "TOUCHED_ONCE",
      touchCount: 1,
    });
  });

  it("returns nulls and NO_ZONES when the instrument has no zones", async () => {
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 2 * DAY),
      instrumentIds: [1],
    });
    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    const summary = summaryOf(result.summaries, 1);

    expect(summary.nearestDemand).toBeNull();
    expect(summary.nearestSupply).toBeNull();
    expect(summary.coverage).toBe("NO_ZONES");
    expect(summary.zoneFreshness).toMatchObject({
      freshnessThresholdDays: 7,
      zoneCount: 0,
      activeZoneCount: 0,
    });
  });

  it("computes distances only when a quote is present, never on the board path", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());

    expect(summaryOf(result.summaries, 1).nearestDemand).toMatchObject({
      distancePercent: null,
      distanceBasis: "PROXIMAL",
    });
  });

  it("uses one batched statement for all instruments", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    mockFake.seedZone({ instrumentId: 2, side: "SUPPLY", proximal: 200 });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());

    expect(result.summaries).toHaveLength(2);
    expect(
      mockFake.standaloneMarkers.filter((marker) => marker === "zones:nearest")
    ).toHaveLength(1);
    expect(
      mockFake.standaloneMarkers.filter((marker) => marker === "zones:coverage")
    ).toHaveLength(1);
  });

  it("returns an empty overview without zone queries when nothing is selected", async () => {
    mockFake.reset();
    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());

    expect(result.summaries).toEqual([]);
    expect(result.expanded).toBeNull();
    expect(mockFake.standaloneMarkers).toEqual(["list-quote-instruments"]);
  });

  it("rejects includeExpanded on an empty board before returning an empty page", async () => {
    mockFake.reset();

    await expectLiveTradeError(
      getZoneOverviewsAt(NOW, OWNER_A, options({ includeExpanded: true })),
      "INVALID_QUERY"
    );
    expect(mockFake.standaloneMarkers).toEqual(["list-quote-instruments"]);
  });

  it("rejects a foreign instrument id without running zone queries", async () => {
    mockFake.seedInstrument({ instrument_id: 3, symbol: "FOREIGN" });
    mockFake.seedItem({ owner: "owner-b", instrumentId: 3 });
    mockFake.seedZone({ instrumentId: 3, side: "DEMAND", proximal: 100 });

    await expectLiveTradeError(
      getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [3] })),
      "NOT_FOUND"
    );
    expect(mockFake.standaloneMarkers).toEqual(["list-quote-instruments"]);
  });

  it("never returns another owner's zones", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 150 });
    mockFake.seedZone({ instrumentId: 2, side: "SUPPLY", proximal: 250 });

    const ownerA = await getZoneOverviewsAt(NOW, OWNER_A, options());
    mockFake.seedInstrument({ instrument_id: 4, symbol: "WIPRO" });
    mockFake.seedItem({ owner: "owner-b", instrumentId: 4 });
    mockFake.seedZone({ instrumentId: 4, side: "DEMAND", proximal: 999 });
    const ownerB = await getZoneOverviewsAt(NOW, OWNER_B, options());

    expect(ownerA.summaries.map((row) => row.instrumentId)).toEqual([1, 2]);
    expect(ownerB.summaries.map((row) => row.instrumentId)).toEqual([4]);
    expect(ownerB.summaries[0].nearestDemand?.proximal).toBe(999);
  });
});

describe("coverage service integration", () => {
  it("reports AVAILABLE with a fresh covering job", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 1 * DAY),
      instrumentIds: [1],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    expect(summaryOf(result.summaries, 1).coverage).toBe("AVAILABLE");
  });

  it("reports STALE when the only covering scan is old", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 8 * DAY),
      instrumentIds: [1],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    expect(summaryOf(result.summaries, 1).coverage).toBe("STALE");
  });

  it("reports OUTSIDE_SCANNER_UNIVERSE but still returns existing zones", async () => {
    mockFake.membership.delete(1);
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    const summary = summaryOf(result.summaries, 1);

    expect(summary.coverage).toBe("OUTSIDE_SCANNER_UNIVERSE");
    expect(summary.nearestDemand?.proximal).toBe(100);
  });

  it("reports NO_SCAN_HISTORY when scans exist but none cover the instrument", async () => {
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 1 * DAY),
      instrumentIds: [2],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    expect(summaryOf(result.summaries, 1).coverage).toBe("NO_SCAN_HISTORY");
  });

  it("reports UNKNOWN when an unattributable scan prevents a verdict", async () => {
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 1 * DAY),
      instrumentIds: null,
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    expect(summaryOf(result.summaries, 1).coverage).toBe("UNKNOWN");
  });

  it("reports UNKNOWN when no successful scan exists", async () => {
    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    expect(summaryOf(result.summaries, 1).coverage).toBe("UNKNOWN");
  });

  it("accepts evidence from a successful DETECT_ZONES batch on a legacy job", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    const job = mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 1 * DAY),
      instrumentIds: null,
    });
    mockFake.seedScanBatch({
      jobId: job.job_id,
      stage: "DETECT_ZONES",
      status: "SUCCESS",
      instrumentIds: [1],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    expect(summaryOf(result.summaries, 1).coverage).toBe("AVAILABLE");
  });

  it("reports AVAILABLE for a fresh scan while keeping older zone evidence separate", async () => {
    const formation = new Date(NOW.getTime() - 30 * DAY);
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      formationTs: formation,
    });
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 1 * DAY),
      instrumentIds: [1],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    const summary = summaryOf(result.summaries, 1);

    expect(summary.coverage).toBe("AVAILABLE");
    expect(summary.zoneFreshness.latestCoveringScanAt).toBe(
      new Date(NOW.getTime() - 1 * DAY).toISOString()
    );
    // Formation time is independent evidence; AVAILABLE does not claim the
    // existing rows were written by the covering scan.
    expect(summary.zoneFreshness.latestZoneFormationAt).toBe(
      formation.toISOString()
    );
  });

  it("does not report AVAILABLE when the successful scan lacks a completion time", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: null,
      instrumentIds: [1],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    expect(summaryOf(result.summaries, 1).coverage).toBe("UNKNOWN");
  });

  it("exposes the latest covering scan and zone timestamps", async () => {
    const formation = new Date(NOW.getTime() - 3 * DAY);
    const created = new Date(NOW.getTime() - 2 * DAY);
    const completed = new Date(NOW.getTime() - 1 * DAY);
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      formationTs: formation,
      createdAt: created,
    });
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: completed,
      instrumentIds: [1],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    expect(summaryOf(result.summaries, 1).zoneFreshness).toEqual({
      freshnessThresholdDays: 7,
      latestCoveringScanAt: completed.toISOString(),
      latestZoneFormationAt: formation.toISOString(),
      latestZoneCreatedAt: created.toISOString(),
      zoneCount: 1,
      activeZoneCount: 1,
    });
  });
});

// ─── Board integration ──────────────────────────────────────────────────────

// ─── Scan attribution regressions ───────────────────────────────────────────

describe("coverage scan attribution", () => {
  beforeEach(() => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    mockFake.seedZone({ instrumentId: 2, side: "SUPPLY", proximal: 200 });
  });

  it("reports the newest completed job when several cover one instrument", async () => {
    const newest = new Date(NOW.getTime() - 2 * DAY);
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 20 * DAY),
      instrumentIds: [1],
    });
    mockFake.seedScanJob({ status: "SUCCESS", completedAt: newest, instrumentIds: [1] });
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 9 * DAY),
      instrumentIds: [1],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    const summary = summaryOf(result.summaries, 1);

    expect(summary.coverage).toBe("AVAILABLE");
    expect(summary.zoneFreshness.latestCoveringScanAt).toBe(newest.toISOString());
  });

  it("attributes every instrument listed in one scan job", async () => {
    const completed = new Date(NOW.getTime() - 1 * DAY);
    mockFake.seedScanJob({ status: "SUCCESS", completedAt: completed, instrumentIds: [1, 2] });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    expect(summaryOf(result.summaries, 1).coverage).toBe("AVAILABLE");
    expect(summaryOf(result.summaries, 2).coverage).toBe("AVAILABLE");
    expect(summaryOf(result.summaries, 1).zoneFreshness.latestCoveringScanAt).toBe(
      completed.toISOString()
    );
    expect(summaryOf(result.summaries, 2).zoneFreshness.latestCoveringScanAt).toBe(
      completed.toISOString()
    );
  });

  it("attributes a batch-only instrument while another came from the job list", async () => {
    const completed = new Date(NOW.getTime() - 1 * DAY);
    const job = mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: completed,
      instrumentIds: [2],
    });
    mockFake.seedScanBatch({
      jobId: job.job_id,
      stage: "DETECT_ZONES",
      status: "SUCCESS",
      instrumentIds: [1],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    expect(summaryOf(result.summaries, 1).coverage).toBe("AVAILABLE");
    expect(summaryOf(result.summaries, 2).coverage).toBe("AVAILABLE");
    expect(summaryOf(result.summaries, 1).zoneFreshness.latestCoveringScanAt).toBe(
      completed.toISOString()
    );
  });

  it("merges job-level and batch-level history and keeps the newest evidence", async () => {
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 6 * DAY),
      instrumentIds: [1],
    });
    const legacy = mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 2 * DAY),
      instrumentIds: null,
    });
    mockFake.seedScanBatch({
      jobId: legacy.job_id,
      stage: "DETECT_ZONES",
      status: "SUCCESS",
      instrumentIds: [1],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    const summary = summaryOf(result.summaries, 1);

    expect(summary.coverage).toBe("AVAILABLE");
    expect(summary.zoneFreshness.latestCoveringScanAt).toBe(
      new Date(NOW.getTime() - 2 * DAY).toISOString()
    );
  });

  it("ignores failed jobs and successful jobs without a completion time", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 9 * DAY),
      instrumentIds: [1],
    });
    mockFake.seedScanJob({
      status: "FAILED",
      completedAt: new Date(NOW.getTime() - 1 * DAY),
      instrumentIds: [1],
    });
    mockFake.seedScanJob({ status: "SUCCESS", completedAt: null, instrumentIds: [1] });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    const summary = summaryOf(result.summaries, 1);

    expect(summary.coverage).toBe("STALE");
    expect(summary.zoneFreshness.latestCoveringScanAt).toBe(
      new Date(NOW.getTime() - 9 * DAY).toISOString()
    );
  });

  it("requires a successful batch to attribute a NULL job instrument list", async () => {
    const job = mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 1 * DAY),
      instrumentIds: null,
    });
    mockFake.seedScanBatch({
      jobId: job.job_id,
      stage: "DETECT_ZONES",
      status: "SUCCESS",
      instrumentIds: [2],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options());
    expect(summaryOf(result.summaries, 1).coverage).toBe("UNKNOWN");
    expect(summaryOf(result.summaries, 2).coverage).toBe("AVAILABLE");
  });

  it("prefers recent evidence over old evidence for the same instrument", async () => {
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 15 * DAY),
      instrumentIds: [1],
    });
    const recent = new Date(NOW.getTime() - 3 * DAY);
    mockFake.seedScanJob({ status: "SUCCESS", completedAt: recent, instrumentIds: [1] });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    const summary = summaryOf(result.summaries, 1);

    expect(summary.coverage).toBe("AVAILABLE");
    expect(summary.zoneFreshness.latestCoveringScanAt).toBe(recent.toISOString());
  });

  it("reports no history when no successful scan mentions the instrument", async () => {
    mockFake.zones = mockFake.zones.filter((zone) => zone.instrument_id !== 1);
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(NOW.getTime() - 1 * DAY),
      instrumentIds: [2],
    });

    const result = await getZoneOverviewsAt(NOW, OWNER_A, options({ instrumentIds: [1] }));
    const summary = summaryOf(result.summaries, 1);

    expect(summary.coverage).toBe("NO_SCAN_HISTORY");
    expect(summary.zoneFreshness.latestCoveringScanAt).toBeNull();
  });
});

describe("board zone summaries", () => {
  it("adds batched nearest summaries without a quote or Kite call", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100, score: 44 });
    mockFake.seedScanJob({
      status: "SUCCESS",
      completedAt: new Date(),
      instrumentIds: [1],
    });

    const board = await getBoard(OWNER_A);

    expect(board.zones.available).toBe(true);
    expect(board.zones.status).toBe("available");
    expect(board.zones.freshnessThresholdDays).toBe(7);
    const summary = summaryOf(board.zones.summaries, 1);
    expect(summary.nearestDemand).toMatchObject({
      proximal: 100,
      formationScore: 44,
      distancePercent: null,
    });
    expect(summary.coverage).toBe("AVAILABLE");
    expect(
      mockFake.standaloneMarkers.filter((marker) => marker === "zones:nearest")
    ).toHaveLength(1);
    expect(
      mockFake.standaloneMarkers.filter((marker) => marker === "zones:coverage")
    ).toHaveLength(1);
  });

  it("loads no zone data for an empty board", async () => {
    mockFake.reset();
    const board = await getBoard(OWNER_A);

    expect(board.zones.summaries).toEqual([]);
    expect([...mockFake.standaloneMarkers].sort()).toEqual([
      "instrument-master-info",
      "list-groups",
      "list-items",
    ]);
  });

  it("reports zones as not requested when includeZones is false", async () => {
    const board = await getBoard(OWNER_A, { includeZones: false });

    expect(board.zones).toEqual({
      available: false,
      status: "not_requested",
      freshnessThresholdDays: 7,
      summaries: [],
    });
    expect(mockFake.standaloneMarkers).not.toContain("zones:nearest");
    expect(mockFake.standaloneMarkers).not.toContain("zones:coverage");
  });

  it("defaults to including zone summaries", async () => {
    const board = await getBoard(OWNER_A);

    expect(board.zones.status).toBe("available");
    expect(board.zones.available).toBe(true);
  });
});

// ─── Expanded zones and pagination ─────────────────────────────────────────

describe("expanded zones", () => {
  it("requires exactly one selected instrument", async () => {
    await expectLiveTradeError(
      getZoneOverviewsAt(NOW, OWNER_A, options({ includeExpanded: true })),
      "INVALID_QUERY"
    );
    expect(mockFake.standaloneMarkers).toEqual(["list-quote-instruments"]);
  });

  it("returns a deterministic page with pagination metadata and no distance", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      formationTs: new Date("2026-11-05T00:00:00Z"),
      score: 80,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "SUPPLY",
      proximal: 120,
      formationTs: new Date("2026-11-04T00:00:00Z"),
      score: 90,
    });

    const result = await getZoneOverviewsAt(
      NOW,
      OWNER_A,
      options({ instrumentIds: [1], includeExpanded: true, limit: 1, offset: 1 })
    );

    expect(result.expanded).not.toBeNull();
    const expanded = result.expanded!;
    expect(expanded.instrumentId).toBe(1);
    expect(expanded.symbol).toBe("INFY");
    expect(expanded.pagination).toEqual({
      limit: 1,
      offset: 1,
      page: 2,
      returned: 1,
      hasMore: false,
      batchLimit: 5000,
    });
    expect(expanded.zones).toHaveLength(1);
    expect(expanded.zones[0].zoneId).not.toBeUndefined();
    expect(expanded.zones[0].distancePercent).toBeNull();
    expect(expanded.zones[0].distanceBasis).toBe("PROXIMAL");
  });

  it("reports hasMore when another page exists", async () => {
    for (let index = 0; index < 3; index += 1) {
      mockFake.seedZone({
        instrumentId: 1,
        side: "DEMAND",
        proximal: 100 + index,
        formationTs: new Date(`2026-11-0${index + 1}T00:00:00Z`),
      });
    }

    const result = await getZoneOverviewsAt(
      NOW,
      OWNER_A,
      options({ instrumentIds: [1], includeExpanded: true, limit: 2 })
    );

    expect(result.expanded?.zones).toHaveLength(2);
    expect(result.expanded?.pagination.hasMore).toBe(true);
    expect(result.expanded?.pagination.returned).toBe(2);
  });

  it("returns an empty final page without claiming more", async () => {
    mockFake.seedZone({ instrumentId: 1, side: "DEMAND", proximal: 100 });
    const result = await getZoneOverviewsAt(
      NOW,
      OWNER_A,
      options({ instrumentIds: [1], includeExpanded: true, limit: 10, offset: 10 })
    );

    expect(result.expanded?.zones).toEqual([]);
    expect(result.expanded?.pagination).toMatchObject({
      returned: 0,
      hasMore: false,
      page: 2,
    });
  });

  it("retains BROKEN zones and low scores in the expanded list", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      lifecycle: "BROKEN",
      score: 10,
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 90,
      lifecycle: "CONFIRMED_FRESH",
      score: 47,
    });

    const result = await getZoneOverviewsAt(
      NOW,
      OWNER_A,
      options({ instrumentIds: [1], includeExpanded: true })
    );
    const zones = result.expanded!.zones;

    expect(zones.map((zone) => zone.lifecycleState)).toEqual([
      "CONFIRMED_FRESH",
      "BROKEN",
    ]);
    expect(zones.map((zone) => zone.formationScore)).toEqual([47, 10]);
  });

  it("orders by formation time, then score, then zone id", async () => {
    const formation = new Date("2026-11-05T00:00:00Z");
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      formationTs: formation,
      score: 50,
      zoneId: "00000000-0000-4000-8000-000000000002",
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "SUPPLY",
      proximal: 120,
      formationTs: formation,
      score: 80,
      zoneId: "00000000-0000-4000-8000-000000000001",
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "SUPPLY",
      proximal: 130,
      formationTs: formation,
      score: 80,
      zoneId: "00000000-0000-4000-8000-000000000003",
    });

    const result = await getZoneOverviewsAt(
      NOW,
      OWNER_A,
      options({ instrumentIds: [1], includeExpanded: true })
    );

    expect(result.expanded!.zones.map((zone) => zone.zoneId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  it("deduplicates repeated zone ids application-side", async () => {
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      zoneId: "00000000-0000-4000-8000-0000000000aa",
      formationTs: new Date("2026-11-05T00:00:00Z"),
    });
    mockFake.seedZone({
      instrumentId: 1,
      side: "DEMAND",
      proximal: 100,
      zoneId: "00000000-0000-4000-8000-0000000000aa",
      formationTs: new Date("2026-11-04T00:00:00Z"),
    });

    const result = await getZoneOverviewsAt(
      NOW,
      OWNER_A,
      options({ instrumentIds: [1], includeExpanded: true, limit: 10 })
    );

    expect(result.expanded?.zones).toHaveLength(1);
    expect(result.expanded?.pagination.returned).toBe(1);
  });
});

// ─── Query parsing ──────────────────────────────────────────────────────────

describe("query parsing", () => {
  function params(query: string): URLSearchParams {
    return new URLSearchParams(query);
  }

  it("parses an absent instrument list as all selected instruments", () => {
    expect(parseInstrumentIdList(null)).toBeUndefined();
    expect(parseQuoteQuery(params(""))).toEqual({});
  });

  it("parses and trims a comma-separated instrument list", () => {
    expect(parseInstrumentIdList(" 1, 2 ,3 ")).toEqual([1, 2, 3]);
    expect(parseQuoteQuery(params("instrumentIds=2,1"))).toEqual({
      instrumentIds: [2, 1],
    });
  });

  it("rejects blank, non-positive, duplicate and oversized id lists", () => {
    expect(() => parseInstrumentIdList("")).toThrow(LiveTradeError);
    expect(() => parseInstrumentIdList("1,0")).toThrow(LiveTradeError);
    expect(() => parseInstrumentIdList("1,1")).toThrow(LiveTradeError);
    expect(() => parseInstrumentIdList("-1")).toThrow(LiveTradeError);
    expect(() => parseInstrumentIdList("1.5")).toThrow(LiveTradeError);
    expect(() =>
      parseInstrumentIdList(Array.from({ length: 201 }, (_, i) => i + 1).join(","))
    ).toThrow(LiveTradeError);
  });

  it("uses the documented pagination defaults", () => {
    expect(parseZoneListQuery(params(""))).toEqual({
      hasTimeframeOverride: false,
      timeframeOverride: null,
      includeExpanded: false,
      includeSummaries: true,
      limit: 100,
      offset: 0,
    });
  });

  it("parses includeSummaries=false without changing anything else", () => {
    expect(parseZoneListQuery(params("includeSummaries=false"))).toMatchObject({
      includeSummaries: false,
      includeExpanded: false,
      limit: 100,
      offset: 0,
    });
    expect(() => parseZoneListQuery(params("includeSummaries=yes"))).toThrow(
      LiveTradeError
    );
  });

  it("defaults board zone summaries on and accepts an explicit opt-out", () => {
    expect(parseBoardQuery(params(""))).toEqual({ includeZones: true });
    expect(parseBoardQuery(params("includeZones=false"))).toEqual({
      includeZones: false,
    });
    expect(() => parseBoardQuery(params("includeZones=no"))).toThrow(
      LiveTradeError
    );
  });

  it("accepts the maximum page size but rejects one above it", () => {
    expect(parseZoneListQuery(params("limit=500")).limit).toBe(500);
    expect(() => parseZoneListQuery(params("limit=501"))).toThrow(LiveTradeError);
    expect(() => parseZoneListQuery(params("limit=0"))).toThrow(LiveTradeError);
    expect(() => parseZoneListQuery(params("limit=abc"))).toThrow(LiveTradeError);
  });

  it("bounds the paging window at 5000 zones", () => {
    expect(() => parseZoneListQuery(params("offset=4500&limit=500"))).not.toThrow();
    expect(() => parseZoneListQuery(params("offset=4500&limit=501"))).toThrow(
      LiveTradeError
    );
    expect(() => parseZoneListQuery(params("offset=5000&limit=1"))).toThrow(
      LiveTradeError
    );
    expect(() => parseZoneListQuery(params("offset=-1"))).toThrow(LiveTradeError);
  });

  it("parses timeframe overrides and `any`", () => {
    expect(parseZoneListQuery(params("timeframe=1W"))).toMatchObject({
      hasTimeframeOverride: true,
      timeframeOverride: "1W",
    });
    expect(parseZoneListQuery(params("timeframe=any"))).toMatchObject({
      hasTimeframeOverride: true,
      timeframeOverride: null,
    });
    expect(parseZoneListQuery(params("timeframe=1w"))).toMatchObject({
      timeframeOverride: "1W",
    });
    expect(() => parseZoneListQuery(params("timeframe=2D"))).toThrow(
      LiveTradeError
    );
    expect(() => parseZoneListQuery(params("timeframe="))).toThrow(
      LiveTradeError
    );
  });

  it("accepts only true/false for includeExpanded", () => {
    expect(parseZoneListQuery(params("includeExpanded=true")).includeExpanded).toBe(
      true
    );
    expect(
      parseZoneListQuery(params("includeExpanded=false")).includeExpanded
    ).toBe(false);
    expect(() =>
      parseZoneListQuery(params("includeExpanded=yes"))
    ).toThrow(LiveTradeError);
  });

  it("validates instrument ids inside the zone query", () => {
    expect(parseZoneListQuery(params("instrumentIds=1,2")).instrumentIds).toEqual([
      1, 2,
    ]);
    expect(() => parseZoneListQuery(params("instrumentIds=1,1"))).toThrow(
      LiveTradeError
    );
  });
});
