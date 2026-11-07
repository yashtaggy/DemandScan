/**
 * @jest-environment jsdom
 *
 * Live Trade page gate:
 *  - a disconnected user gets a connect prompt, not the workspace;
 *  - a connected user gets the Live Trade workspace.
 */

const mockAuthHook = jest.fn();

jest.mock("@/hooks/use-auth", () => ({
  useAuth: () => mockAuthHook(),
}));

jest.mock("@/components/header", () => ({ Header: () => null }));
jest.mock("@/components/live-trade/workspace", () => ({
  LiveTradeWorkspace: () => <div>Live Trade workspace loaded</div>,
}));

import { render, screen } from "@testing-library/react";
import LiveTradePage from "@/app/live-trade/page";

function authState(authenticated: boolean) {
  return {
    status: authenticated
      ? {
          authenticated: true,
          market: { isOpen: true, exchange: "NSE", nextEvent: "" },
        }
      : { authenticated: false },
    loading: false,
    error: null,
    refetch: jest.fn(),
  };
}

describe("LiveTradePage", () => {
  test("asks a disconnected user to connect", () => {
    mockAuthHook.mockReturnValue(authState(false));
    render(<LiveTradePage />);

    expect(screen.getByText("Connect to use Live Trade")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Connect with Zerodha" })
    ).toBeTruthy();
    expect(screen.queryByText("Live Trade workspace loaded")).toBeNull();
  });

  test("renders the workspace for an authenticated user", () => {
    mockAuthHook.mockReturnValue(authState(true));
    render(<LiveTradePage />);

    expect(screen.getByText("Live Trade workspace loaded")).toBeTruthy();
    expect(screen.queryByText("Connect to use Live Trade")).toBeNull();
  });
});
