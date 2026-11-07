/**
 * Live Trade domain validation tests — pure functions, no database.
 */

import { ZONE_TIMEFRAMES } from "@/lib/scanner/zone-query";
import {
  DEFAULT_LIVE_TRADE_PRIORITY,
  DEFAULT_LIVE_TRADE_STATUS,
  DEFAULT_LIVE_TRADE_TIMEFRAME,
  LIVE_TRADE_DIRECTIONS,
  LIVE_TRADE_ITEM_LIMIT,
  LIVE_TRADE_PRIORITIES,
  LIVE_TRADE_STATUSES,
  LIVE_TRADE_TIMEFRAMES,
} from "@/lib/live-trade/constants";
import {
  isLiveTradeDirection,
  isLiveTradePriority,
  isLiveTradeStatus,
  isLiveTradeTimeframe,
  isValidOwnerId,
  isUuid,
  normalizeNotes,
  parseCreateGroupInput,
  parseCreateItemInput,
  parseReorderInput,
  parseUpdateGroupInput,
  parseUpdateItemInput,
  parseVersion,
  toLiveTradeError,
  type ValidationFailure,
} from "@/lib/live-trade/validation";

const VALID_UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const ANOTHER_UUID = "9b2f4c1a-1d2e-4f3a-8b7c-6d5e4f3a2b1c";

function expectFailure(result: unknown): ValidationFailure {
  const parsed = result as { ok: boolean };
  expect(parsed.ok).toBe(false);
  return result as ValidationFailure;
}

function expectIssue(result: ValidationFailure, field: string): void {
  expect(result.issues.some((issue) => issue.field === field)).toBe(true);
}

// ─── Enums ────────────────────────────────────────────────────────────────────

describe("Live Trade enums", () => {
  it("defines the approved priority set", () => {
    expect([...LIVE_TRADE_PRIORITIES]).toEqual(["HIGH", "MEDIUM", "LOW"]);
  });

  it("defines the approved direction set", () => {
    expect([...LIVE_TRADE_DIRECTIONS]).toEqual(["BUY", "SELL"]);
  });

  it("defines the approved trade status set", () => {
    expect([...LIVE_TRADE_STATUSES]).toEqual([
      "WATCHING",
      "WAITING_FOR_ENTRY",
      "ACTIVE_TRADE",
      "TARGET_HIT",
      "STOP_LOSS_HIT",
      "CLOSED",
    ]);
  });

  it("defines the same eight timeframes as the scanner", () => {
    expect([...LIVE_TRADE_TIMEFRAMES]).toEqual([...ZONE_TIMEFRAMES]);
  });

  it("accepts every valid enum value", () => {
    for (const value of LIVE_TRADE_PRIORITIES) {
      expect(isLiveTradePriority(value)).toBe(true);
    }
    for (const value of LIVE_TRADE_DIRECTIONS) {
      expect(isLiveTradeDirection(value)).toBe(true);
    }
    for (const value of LIVE_TRADE_STATUSES) {
      expect(isLiveTradeStatus(value)).toBe(true);
    }
    for (const value of LIVE_TRADE_TIMEFRAMES) {
      expect(isLiveTradeTimeframe(value)).toBe(true);
    }
  });

  it("rejects invalid enum values", () => {
    expect(isLiveTradePriority("URGENT")).toBe(false);
    expect(isLiveTradePriority("high")).toBe(false);
    expect(isLiveTradeDirection("HOLD")).toBe(false);
    expect(isLiveTradeDirection("buy")).toBe(false);
    expect(isLiveTradeStatus("OPEN")).toBe(false);
    expect(isLiveTradeStatus("active_trade")).toBe(false);
    expect(isLiveTradeTimeframe("5m")).toBe(false);
    expect(isLiveTradeTimeframe("1h")).toBe(false);
    expect(isLiveTradeTimeframe("")).toBe(false);
    expect(isLiveTradePriority(null)).toBe(false);
    expect(isLiveTradeStatus(3)).toBe(false);
  });
});

// ─── Owner identity ───────────────────────────────────────────────────────────

describe("isValidOwnerId", () => {
  it("accepts a valid Kite user id", () => {
    expect(isValidOwnerId("ZP0001")).toBe(true);
  });

  it("accepts an id at the 64-character boundary", () => {
    expect(isValidOwnerId("A".repeat(64))).toBe(true);
  });

  it("rejects an id longer than 64 characters", () => {
    expect(isValidOwnerId("A".repeat(65))).toBe(false);
  });

  it("rejects missing and non-string values", () => {
    expect(isValidOwnerId(undefined)).toBe(false);
    expect(isValidOwnerId(null)).toBe(false);
    expect(isValidOwnerId(1234)).toBe(false);
  });

  it("rejects empty and whitespace-only ids", () => {
    expect(isValidOwnerId("")).toBe(false);
    expect(isValidOwnerId("   ")).toBe(false);
    expect(isValidOwnerId("\t\n")).toBe(false);
  });
});

// ─── UUIDs ────────────────────────────────────────────────────────────────────

describe("isUuid", () => {
  it("accepts a canonical UUID", () => {
    expect(isUuid(VALID_UUID)).toBe(true);
    expect(isUuid(VALID_UUID.toUpperCase())).toBe(true);
  });

  it("rejects malformed UUIDs and non-strings", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("3f2504e0-4f89-41d3-9a0c-0305e82c330")).toBe(false);
    expect(isUuid(`${VALID_UUID}-extra`)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

// ─── Notes ────────────────────────────────────────────────────────────────────

describe("notes", () => {
  it("normalizes CRLF and CR to LF", () => {
    expect(normalizeNotes("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("accepts exactly 2,000 characters", () => {
    const result = parseCreateItemInput({ instrumentId: 1, notes: "a".repeat(2000) });
    expect(result.ok).toBe(true);
  });

  it("rejects 2,001 characters", () => {
    const result = parseCreateItemInput({ instrumentId: 1, notes: "a".repeat(2001) });
    expectIssue(expectFailure(result), "notes");
  });

  it("counts code points, not UTF-16 units", () => {
    const emoji = "😀"; // 2 UTF-16 units, 1 code point
    expect(parseCreateItemInput({ instrumentId: 1, notes: emoji.repeat(2000) }).ok).toBe(true);
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, notes: emoji.repeat(2001) })),
      "notes"
    );
  });

  it("allows empty notes by default", () => {
    const result = parseCreateItemInput({ instrumentId: 1 });
    expect(result.ok && result.value.notes).toBe("");
  });

  it("rejects non-string notes", () => {
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, notes: null })),
      "notes"
    );
  });
});

// ─── Prices ──────────────────────────────────────────────────────────────────

describe("prices", () => {
  const valid = [0.0001, 1, 2450.5, 100.1234, 1_000_000_000];

  it.each(valid)("accepts %p", (price) => {
    const result = parseCreateItemInput({ instrumentId: 1, entryPrice: price });
    expect(result.ok && result.value.entryPrice).toBe(price);
  });

  it("accepts null to clear a price", () => {
    const result = parseCreateItemInput({ instrumentId: 1, targetPrice: null });
    expect(result.ok && result.value.targetPrice).toBeNull();
  });

  it.each([0, -1, -0.0001, 1_000_000_000.01])("rejects %p", (price) => {
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, stopLoss: price })),
      "stopLoss"
    );
  });

  it("rejects more than four decimal places", () => {
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, entryPrice: 100.12345 })),
      "entryPrice"
    );
  });

  it("rejects NaN, Infinity and numeric strings", () => {
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, entryPrice: NaN })),
      "entryPrice"
    );
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, entryPrice: Infinity })),
      "entryPrice"
    );
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, entryPrice: "100" })),
      "entryPrice"
    );
  });

  it("validates all three price fields independently", () => {
    const result = expectFailure(
      parseCreateItemInput({
        instrumentId: 1,
        entryPrice: 100,
        targetPrice: 0,
        stopLoss: -5,
      })
    );
    expectIssue(result, "targetPrice");
    expectIssue(result, "stopLoss");
    expect(result.issues.some((issue) => issue.field === "entryPrice")).toBe(false);
  });
});

// ─── Create item ─────────────────────────────────────────────────────────────

describe("parseCreateItemInput", () => {
  it("applies documented defaults", () => {
    const result = parseCreateItemInput({ instrumentId: 42 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      instrumentId: 42,
      groupId: null,
      priority: DEFAULT_LIVE_TRADE_PRIORITY,
      direction: null,
      timeframe: DEFAULT_LIVE_TRADE_TIMEFRAME,
      entryPrice: null,
      targetPrice: null,
      stopLoss: null,
      notes: "",
      tradeStatus: DEFAULT_LIVE_TRADE_STATUS,
    });
  });

  it("defaults an omitted timeframe to 1D", () => {
    const result = parseCreateItemInput({ instrumentId: 1 });
    expect(result.ok && result.value.timeframe).toBe("1D");
  });

  it("treats an explicit null timeframe as Any", () => {
    const result = parseCreateItemInput({ instrumentId: 1, timeframe: null });
    expect(result.ok && result.value.timeframe).toBeNull();
  });

  it("keeps an explicit timeframe", () => {
    const result = parseCreateItemInput({ instrumentId: 1, timeframe: "4H" });
    expect(result.ok && result.value.timeframe).toBe("4H");
  });

  it("rejects an invalid timeframe", () => {
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, timeframe: "5m" })),
      "timeframe"
    );
  });

  it("rejects invalid priority, direction and tradeStatus values", () => {
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, priority: "URGENT" })),
      "priority"
    );
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, direction: "HOLD" })),
      "direction"
    );
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, tradeStatus: "OPEN" })),
      "tradeStatus"
    );
  });

  it("accepts every valid enum value on create", () => {
    for (const priority of LIVE_TRADE_PRIORITIES) {
      expect(parseCreateItemInput({ instrumentId: 1, priority }).ok).toBe(true);
    }
    for (const direction of LIVE_TRADE_DIRECTIONS) {
      expect(parseCreateItemInput({ instrumentId: 1, direction }).ok).toBe(true);
    }
    for (const tradeStatus of LIVE_TRADE_STATUSES) {
      expect(parseCreateItemInput({ instrumentId: 1, tradeStatus }).ok).toBe(true);
    }
    for (const timeframe of LIVE_TRADE_TIMEFRAMES) {
      expect(parseCreateItemInput({ instrumentId: 1, timeframe }).ok).toBe(true);
    }
  });

  it("requires a positive integer instrumentId", () => {
    for (const instrumentId of [undefined, 0, -1, 1.5, "42"]) {
      expectIssue(expectFailure(parseCreateItemInput({ instrumentId })), "instrumentId");
    }
  });

  it("accepts a nullable groupId", () => {
    expect(parseCreateItemInput({ instrumentId: 1, groupId: VALID_UUID }).ok).toBe(true);
    expect(parseCreateItemInput({ instrumentId: 1, groupId: null }).ok).toBe(true);
    expectIssue(
      expectFailure(parseCreateItemInput({ instrumentId: 1, groupId: "" })),
      "groupId"
    );
  });

  it("rejects a client-supplied owner", () => {
    const failure = expectFailure(
      parseCreateItemInput({ instrumentId: 1, ownerUserId: "SOMEONE_ELSE" })
    );
    expectIssue(failure, "ownerUserId");
    expect(failure.issues[0]?.message).toMatch(/resolved from the session/i);
  });

  it("rejects unknown and server-controlled fields", () => {
    const failure = expectFailure(
      parseCreateItemInput({
        instrumentId: 1,
        sortOrder: 0,
        itemId: VALID_UUID,
        version: 1,
      })
    );
    expectIssue(failure, "sortOrder");
    expectIssue(failure, "itemId");
    expectIssue(failure, "version");
  });

  it("rejects a non-object body", () => {
    expect(parseCreateItemInput(null).ok).toBe(false);
    expect(parseCreateItemInput([]).ok).toBe(false);
    expect(parseCreateItemInput("{}").ok).toBe(false);
  });
});

// ─── Update item ─────────────────────────────────────────────────────────────

describe("parseUpdateItemInput", () => {
  it("treats an omitted timeframe as unchanged", () => {
    const result = parseUpdateItemInput({ version: 3, notes: "updated" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("timeframe" in result.value).toBe(false);
    expect(result.value.notes).toBe("updated");
  });

  it("treats an explicit null timeframe as Any", () => {
    const result = parseUpdateItemInput({ version: 3, timeframe: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("timeframe" in result.value).toBe(true);
    expect(result.value.timeframe).toBeNull();
  });

  it("keeps an explicit timeframe", () => {
    const result = parseUpdateItemInput({ version: 3, timeframe: "1W" });
    expect(result.ok && result.value.timeframe).toBe("1W");
  });

  it("distinguishes null from omitted for nullable fields", () => {
    const result = parseUpdateItemInput({
      version: 1,
      groupId: null,
      direction: null,
      entryPrice: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.groupId).toBeNull();
    expect(result.value.direction).toBeNull();
    expect(result.value.entryPrice).toBeNull();
  });

  it("rejects a missing version", () => {
    expectIssue(expectFailure(parseUpdateItemInput({ notes: "x" })), "version");
  });

  it("rejects an empty patch", () => {
    expectIssue(expectFailure(parseUpdateItemInput({ version: 1 })), "body");
  });

  it("rejects instrumentId as immutable", () => {
    const failure = expectFailure(parseUpdateItemInput({ version: 1, instrumentId: 42 }));
    expectIssue(failure, "instrumentId");
    expect(failure.issues.find((i) => i.field === "instrumentId")?.message).toMatch(
      /immutable/i
    );
  });

  it("rejects a client-supplied owner", () => {
    expectIssue(
      expectFailure(parseUpdateItemInput({ version: 1, ownerUserId: "X" })),
      "ownerUserId"
    );
  });
});

// ─── Versions ────────────────────────────────────────────────────────────────

describe("parseVersion", () => {
  it.each([1, 2, 2_147_483_647])("accepts %p", (version) => {
    expect(parseVersion(version)).toEqual({ ok: true, value: version });
  });

  it.each([undefined, null, 0, -1, 1.5, "1", 2_147_483_648, NaN])(
    "rejects %p",
    (version) => {
      expectIssue(expectFailure(parseVersion(version)), "version");
    }
  );

  it("reports query-sourced failures as INVALID_QUERY", () => {
    expect(expectFailure(parseVersion(undefined, "query")).code).toBe("INVALID_QUERY");
  });

  it("reports body-sourced failures as INVALID_BODY", () => {
    expect(expectFailure(parseVersion(undefined, "body")).code).toBe("INVALID_BODY");
  });
});

// ─── Group names ─────────────────────────────────────────────────────────────

describe("group names", () => {
  it("trims surrounding whitespace", () => {
    const result = parseCreateGroupInput({ name: "  Core Holdings  " });
    expect(result.ok && result.value.name).toBe("Core Holdings");
  });

  it("accepts 1 and 60 characters", () => {
    expect(parseCreateGroupInput({ name: "A" }).ok).toBe(true);
    expect(parseCreateGroupInput({ name: "A".repeat(60) }).ok).toBe(true);
  });

  it("rejects empty, whitespace-only and over-length names", () => {
    expectIssue(expectFailure(parseCreateGroupInput({ name: "" })), "name");
    expectIssue(expectFailure(parseCreateGroupInput({ name: "   " })), "name");
    expectIssue(expectFailure(parseCreateGroupInput({ name: "A".repeat(61) })), "name");
  });

  it("rejects control characters", () => {
    expectIssue(
      expectFailure(parseCreateGroupInput({ name: "Core\nHoldings" })),
      "name"
    );
  });

  it("rejects a missing name", () => {
    expectIssue(expectFailure(parseCreateGroupInput({})), "name");
  });

  it("rejects unknown fields", () => {
    expectIssue(
      expectFailure(parseCreateGroupInput({ name: "Core", sortOrder: 1 })),
      "sortOrder"
    );
  });

  it("requires name and version on update", () => {
    expect(parseUpdateGroupInput({ name: "Core", version: 2 })).toEqual({
      ok: true,
      value: { name: "Core", version: 2 },
    });
    expectIssue(expectFailure(parseUpdateGroupInput({ name: "Core" })), "version");
    expectIssue(expectFailure(parseUpdateGroupInput({ version: 2 })), "name");
  });
});

// ─── Reorder ─────────────────────────────────────────────────────────────────

describe("parseReorderInput", () => {
  it("accepts unique UUIDs", () => {
    expect(parseReorderInput({ orderedItemIds: [VALID_UUID, ANOTHER_UUID] })).toEqual({
      ok: true,
      value: { orderedItemIds: [VALID_UUID, ANOTHER_UUID] },
    });
  });

  it("accepts an empty list (owner has no items)", () => {
    expect(parseReorderInput({ orderedItemIds: [] }).ok).toBe(true);
  });

  it("rejects duplicates, including case-only differences", () => {
    expectIssue(
      expectFailure(parseReorderInput({ orderedItemIds: [VALID_UUID, VALID_UUID] })),
      "orderedItemIds[1]"
    );
    expectIssue(
      expectFailure(
        parseReorderInput({ orderedItemIds: [VALID_UUID, VALID_UUID.toUpperCase()] })
      ),
      "orderedItemIds[1]"
    );
  });

  it("rejects malformed IDs", () => {
    expectIssue(
      expectFailure(parseReorderInput({ orderedItemIds: ["nope"] })),
      "orderedItemIds[0]"
    );
  });

  it("rejects a non-array payload", () => {
    expectIssue(
      expectFailure(parseReorderInput({ orderedItemIds: VALID_UUID })),
      "orderedItemIds"
    );
  });

  it("rejects more IDs than the item limit", () => {
    const ids = Array.from({ length: LIVE_TRADE_ITEM_LIMIT + 1 }, (_, i) =>
      `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`
    );
    expectIssue(
      expectFailure(parseReorderInput({ orderedItemIds: ids })),
      "orderedItemIds"
    );
  });
});

// ─── Error conversion ────────────────────────────────────────────────────────

describe("toLiveTradeError", () => {
  it("maps a validation failure to a 400 LiveTradeError with issues", () => {
    const failure = expectFailure(parseCreateItemInput({ instrumentId: 1, priority: "NOPE" }));
    const error = toLiveTradeError(failure);
    expect(error.code).toBe("INVALID_BODY");
    expect(error.status).toBe(400);
    expect(error.details?.issues).toEqual(failure.issues);
    expect(error.message).toBe(failure.issues[0]?.message);
  });

  it("maps a query validation failure to INVALID_QUERY", () => {
    const failure = expectFailure(parseVersion(undefined, "query"));
    expect(toLiveTradeError(failure).code).toBe("INVALID_QUERY");
  });
});
