/**
 * @jest-environment jsdom
 *
 * Navigation and zone presentation:
 *  - the third top-level tab exists alongside Dashboard and Scanner;
 *  - every coverage state is explained;
 *  - structural zones keep low formation scores visible;
 *  - price distances appear only for a current valid quote;
 *  - a partial zone-enrichment failure is stated without hiding quotes.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { Header } from "@/components/header";
import { CoverageGuide } from "@/components/live-trade/coverage-guide";
import { ZoneSummary } from "@/components/live-trade/zone-summary";
import type {
  LiveTradeNearestZoneDto,
  LiveTradeQuoteDto,
  LiveTradeZoneSummaryDto,
} from "@/lib/live-trade/client";

const mockPathname = jest.fn(() => "/live-trade");

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: jest.fn(),
    push: jest.fn(),
    replace: jest.fn(),
  }),
  usePathname: () => mockPathname(),
}));

jest.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    status: {
      authenticated: true,
      userName: "Test User",
      market: { isOpen: true, exchange: "NSE" },
    },
    loading: false,
    error: null,
    refetch: jest.fn(),
  }),
}));

function nearestZone(
  overrides: Partial<LiveTradeNearestZoneDto> = {}
): LiveTradeNearestZoneDto {
  return {
    zoneId: "z1",
    instrumentId: 1,
    symbol: "INFY",
    side: "DEMAND",
    timeframe: "1D",
    pattern: "DBR",
    zoneLow: 1480.5,
    zoneHigh: 1502,
    proximal: 1502,
    distal: 1480.5,
    formationScore: 35,
    lifecycleState: "CONFIRMED_FRESH",
    formationTs: "2026-11-04T00:00:00.000Z",
    createdAt: "2026-11-04T00:00:00.000Z",
    touchCount: 2,
    lastTouchTs: "2026-11-05T00:00:00.000Z",
    timeframeMatch: "PREFERRED",
    distancePercent: 1.2,
    distanceBasis: "PROXIMAL",
    ...overrides,
  };
}

function summary(
  overrides: Partial<LiveTradeZoneSummaryDto> = {}
): LiveTradeZoneSummaryDto {
  return {
    instrumentId: 1,
    symbol: "INFY",
    preferredTimeframe: "1D",
    coverage: "AVAILABLE",
    zoneFreshness: {
      freshnessThresholdDays: 7,
      latestCoveringScanAt: "2026-11-05T00:00:00.000Z",
      latestZoneFormationAt: "2026-11-04T00:00:00.000Z",
      latestZoneCreatedAt: "2026-11-04T00:00:00.000Z",
      zoneCount: 4,
      activeZoneCount: 3,
    },
    nearestDemand: nearestZone(),
    nearestSupply: null,
    ...overrides,
  };
}

function quote(overrides: Partial<LiveTradeQuoteDto> = {}): LiveTradeQuoteDto {
  return {
    instrumentId: 1,
    symbol: "INFY",
    lastPrice: 1505.25,
    change: 12.5,
    changePercent: 0.8375,
    lastTradedAt: "2026-11-06T09:28:41.000Z",
    fetchedAt: "2026-11-06T09:29:00.000Z",
    freshness: "LIVE",
    errorCode: null,
    nearestDemand: nearestZone(),
    nearestSupply: null,
    ...overrides,
  };
}

describe("Header navigation", () => {
  test("exposes Dashboard, Scanner and Live Trade across both nav layouts", () => {
    render(<Header lastRefreshed={null} />);

    const liveTradeLinks = screen.getAllByRole("link", { name: "Live Trade" });
    expect(liveTradeLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of liveTradeLinks) {
      expect(link.getAttribute("href")).toBe("/live-trade");
      expect(link.className).toContain("text-indigo-300");
    }

    expect(screen.getAllByRole("link", { name: "Dashboard" })[0]).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Scanner" })[0]).toBeTruthy();
  });
});

describe("Coverage and zone presentation", () => {
  test("the coverage guide explains all states, including stale scan data", () => {
    render(<CoverageGuide />);
    fireEvent.click(screen.getByText(/Coverage & freshness guide/));

    expect(screen.getByText("Zones available")).toBeTruthy();
    expect(screen.getByText("No zones detected")).toBeTruthy();
    expect(screen.getByText("Outside scanner universe")).toBeTruthy();
    expect(screen.getByText("No scan history")).toBeTruthy();
    expect(screen.getByText("Scanner data stale")).toBeTruthy();
    expect(screen.getByText("Coverage unknown")).toBeTruthy();
    expect(
      screen.getByText(/does not prove that every displayed zone was re-detected/)
    ).toBeTruthy();
  });

  test("keeps a below-50 formation score visible and shows price distance for a current quote", () => {
    const { container } = render(
      <ZoneSummary
        summary={summary()}
        quote={quote()}
        zonesAvailable
        displayState="current"
      />
    );

    expect(screen.getByText(/Formation 35/)).toBeTruthy();
    expect(container.textContent).toContain("Demand: +1.20% from LTP");
    expect(container.textContent).toContain("₹1,480.50 – ₹1,502.00");
  });

  test("marks stale scan coverage and suppresses price distance for a retained quote", () => {
    render(
      <ZoneSummary
        summary={summary({ coverage: "STALE" })}
        quote={quote()}
        zonesAvailable
        displayState="stale"
      />
    );

    expect(
      screen.getByText(/Scan data is older than the 7-day freshness window/)
    ).toBeTruthy();
    expect(
      screen.getByText(/Distance hidden: the retained quote is not current/)
    ).toBeTruthy();
  });

  test("states a partial enrichment failure without discarding the structural zones", () => {
    render(
      <ZoneSummary
        summary={summary()}
        quote={quote({ nearestDemand: null, nearestSupply: null })}
        zonesAvailable={false}
        displayState="current"
      />
    );

    expect(
      screen.getByText(/Nearest zones for the latest quote were unavailable/)
    ).toBeTruthy();
    expect(screen.getByText(/Formation 35/)).toBeTruthy();
  });

  test("requires a valid quote before showing any price distance", () => {
    render(
      <ZoneSummary
        summary={summary()}
        quote={quote({
          lastPrice: null,
          freshness: "UNAVAILABLE",
          errorCode: "QUOTE_NOT_RETURNED",
          nearestDemand: null,
          nearestSupply: null,
        })}
        zonesAvailable
        displayState="current"
      />
    );

    expect(
      screen.getByText(/A valid quote is required to calculate distance/)
    ).toBeTruthy();
    expect(screen.queryByText(/from LTP/)).toBeNull();
  });
});
