/**
 * @jest-environment jsdom
 *
 * Expanded-zone coverage states. The summary arrives from the independent
 * `/zones` request, so a missing summary while that request is loading or has
 * failed must be reported as such — never as a confirmed "Coverage unknown".
 */

import { fireEvent, render, screen } from "@testing-library/react";
import type {
  LiveTradeItemDto,
  LiveTradeZoneSummaryDto,
} from "@/lib/live-trade/client";

jest.mock("@/hooks/use-expanded-zones", () => ({
  useExpandedZones: () => ({
    zones: [],
    pagination: null,
    loading: false,
    loadingMore: false,
    error: null,
    loadMore: jest.fn(),
    retry: jest.fn(),
  }),
}));

import { ExpandedZones } from "@/components/live-trade/expanded-zones";

const item: LiveTradeItemDto = {
  itemId: "i1",
  instrumentId: 7,
  symbol: "INFY",
  companyName: "Infosys Limited",
  groupId: null,
  priority: "MEDIUM",
  direction: null,
  timeframe: "1D",
  entryPrice: null,
  targetPrice: null,
  stopLoss: null,
  notes: "",
  tradeStatus: "WATCHING",
  sortOrder: 0,
  version: 1,
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
};

function summary(
  coverage: LiveTradeZoneSummaryDto["coverage"]
): LiveTradeZoneSummaryDto {
  return {
    instrumentId: 7,
    symbol: "INFY",
    preferredTimeframe: "1D",
    coverage,
    zoneFreshness: {
      freshnessThresholdDays: 7,
      latestCoveringScanAt: null,
      latestZoneFormationAt: null,
      latestZoneCreatedAt: null,
      zoneCount: 0,
      activeZoneCount: 0,
    },
    nearestDemand: null,
    nearestSupply: null,
  };
}

const onRetryZones = jest.fn();

function renderDialog(props: {
  summary: LiveTradeZoneSummaryDto | undefined;
  zonesLoading: boolean;
  zonesError: boolean;
}) {
  return render(
    <ExpandedZones
      item={item}
      summary={props.summary}
      zonesLoading={props.zonesLoading}
      zonesError={props.zonesError}
      onRetryZones={onRetryZones}
      onClose={() => {}}
    />
  );
}

beforeEach(() => {
  onRetryZones.mockClear();
});

test("shows a loading state instead of UNKNOWN coverage while the summary loads", () => {
  renderDialog({ summary: undefined, zonesLoading: true, zonesError: false });

  expect(screen.getByText("Loading zone coverage…")).toBeTruthy();
  expect(screen.queryByText("Coverage unknown")).toBeNull();
});

test("shows an unavailable state with a retry action when the summary fails", () => {
  renderDialog({ summary: undefined, zonesLoading: false, zonesError: true });

  expect(screen.getByText("Coverage unavailable")).toBeTruthy();
  expect(screen.queryByText("Coverage unknown")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Retry coverage" }));
  expect(onRetryZones).toHaveBeenCalledTimes(1);
});

test("disables the coverage retry while the retry is running", () => {
  renderDialog({ summary: undefined, zonesLoading: true, zonesError: true });

  const retry = screen.getByRole("button", { name: "Retry coverage" });
  expect((retry as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(retry);
  expect(onRetryZones).not.toHaveBeenCalled();
});

test("still shows a genuinely unknown coverage value", () => {
  renderDialog({
    summary: summary("UNKNOWN"),
    zonesLoading: false,
    zonesError: false,
  });

  expect(screen.getByText("Coverage unknown")).toBeTruthy();
  expect(screen.queryByText("Coverage unavailable")).toBeNull();
});
