/**
 * Live Trade error model tests.
 */

import {
  LIVE_TRADE_ERROR_STATUS,
  LiveTradeError,
  isLiveTradeError,
} from "@/lib/live-trade/errors";

describe("LIVE_TRADE_ERROR_STATUS", () => {
  it("maps the approved codes to HTTP statuses", () => {
    expect(LIVE_TRADE_ERROR_STATUS.UNAUTHENTICATED).toBe(401);
    expect(LIVE_TRADE_ERROR_STATUS.TOKEN_EXPIRED).toBe(401);
    expect(LIVE_TRADE_ERROR_STATUS.INVALID_BODY).toBe(400);
    expect(LIVE_TRADE_ERROR_STATUS.INVALID_QUERY).toBe(400);
    expect(LIVE_TRADE_ERROR_STATUS.NOT_FOUND).toBe(404);
    expect(LIVE_TRADE_ERROR_STATUS.DUPLICATE_GROUP).toBe(409);
    expect(LIVE_TRADE_ERROR_STATUS.ITEM_LIMIT).toBe(409);
    expect(LIVE_TRADE_ERROR_STATUS.GROUP_LIMIT).toBe(409);
    expect(LIVE_TRADE_ERROR_STATUS.EDIT_CONFLICT).toBe(409);
    expect(LIVE_TRADE_ERROR_STATUS.REORDER_STALE).toBe(409);
    expect(LIVE_TRADE_ERROR_STATUS.WRITE_BUSY).toBe(409);
    expect(LIVE_TRADE_ERROR_STATUS.INVALID_GROUP).toBe(422);
    expect(LIVE_TRADE_ERROR_STATUS.INSTRUMENT_NOT_SYNCED).toBe(422);
    expect(LIVE_TRADE_ERROR_STATUS.INSTRUMENT_INACTIVE).toBe(422);
    expect(LIVE_TRADE_ERROR_STATUS.QUOTE_COOLDOWN).toBe(429);
    expect(LIVE_TRADE_ERROR_STATUS.QUOTE_FETCH_FAILED).toBe(502);
    expect(LIVE_TRADE_ERROR_STATUS.INTERNAL).toBe(500);
  });
});

describe("LiveTradeError", () => {
  it("derives the status from the code", () => {
    const error = new LiveTradeError("ITEM_LIMIT");
    expect(error.status).toBe(409);
    expect(error.code).toBe("ITEM_LIMIT");
    expect(error.name).toBe("LiveTradeError");
  });

  it("uses the default message for the code", () => {
    const error = new LiveTradeError("UNAUTHENTICATED");
    expect(error.message).toBe("Authentication required.");
  });

  it("allows an explicit message", () => {
    const error = new LiveTradeError("INVALID_BODY", "priority is invalid.");
    expect(error.message).toBe("priority is invalid.");
  });

  it("serializes without a details key when none are supplied", () => {
    const body = new LiveTradeError("NOT_FOUND").toBody();
    expect(body).toEqual({ error: "The requested record was not found.", code: "NOT_FOUND" });
    expect("details" in body).toBe(false);
  });

  it("serializes details when supplied", () => {
    const body = new LiveTradeError("EDIT_CONFLICT", undefined, {
      currentVersion: 4,
    }).toBody();
    expect(body.details).toEqual({ currentVersion: 4 });
    expect(body.code).toBe("EDIT_CONFLICT");
  });

  it("is recognized by the type guard", () => {
    expect(isLiveTradeError(new LiveTradeError("INTERNAL"))).toBe(true);
    expect(isLiveTradeError(new Error("boom"))).toBe(false);
    expect(isLiveTradeError({ code: "INTERNAL" })).toBe(false);
    expect(isLiveTradeError(null)).toBe(false);
  });
});
