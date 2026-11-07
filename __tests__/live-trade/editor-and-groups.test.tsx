/**
 * @jest-environment jsdom
 *
 * Editor and group manager contracts:
 *  - client-side price/notes validation blocks the request;
 *  - "Any timeframe" and empty prices round-trip as null;
 *  - a 409 conflict keeps the user's edits and reloads the latest version;
 *  - unsaved changes require an explicit discard;
 *  - group create/rename/delete/reorder call the matching API payloads;
 *  - deleting a group explains that its instruments become ungrouped.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { LiveTradeGroupDto, LiveTradeItemDto } from "@/lib/live-trade/client";
import { LiveTradeClientError } from "@/lib/live-trade/client";
import { ItemEditor } from "@/components/live-trade/item-editor";
import { GroupManager } from "@/components/live-trade/group-manager";

function makeItem(overrides: Partial<LiveTradeItemDto> = {}): LiveTradeItemDto {
  return {
    itemId: "i1",
    instrumentId: 1,
    symbol: "INFY",
    companyName: "Infosys Limited",
    groupId: null,
    priority: "MEDIUM",
    direction: null,
    timeframe: "1D",
    entryPrice: 1500,
    targetPrice: null,
    stopLoss: null,
    notes: "",
    tradeStatus: "WATCHING",
    sortOrder: 1,
    version: 3,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
    ...overrides,
  };
}

function makeGroup(
  groupId: string,
  name: string,
  sortOrder: number
): LiveTradeGroupDto {
  return {
    groupId,
    name,
    sortOrder,
    version: 1,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

function editorProps(overrides: Record<string, unknown> = {}) {
  return {
    item: makeItem(),
    groups: [],
    onClose: jest.fn(),
    onSave: jest.fn().mockResolvedValue(undefined),
    onConflictReload: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ItemEditor", () => {
  test("blocks a non-positive price before calling the API", () => {
    const props = editorProps();
    render(<ItemEditor {...props} />);

    fireEvent.change(screen.getByLabelText("Entry price (₹)"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      screen.getByText("Entry price must be greater than zero.")
    ).toBeTruthy();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  test("sends null for Any timeframe and an empty price", async () => {
    const props = editorProps({
      item: makeItem({ entryPrice: 1500, timeframe: "1D" }),
    });
    render(<ItemEditor {...props} />);

    fireEvent.change(screen.getByLabelText("Timeframe"), {
      target: { value: "ANY" },
    });
    fireEvent.change(screen.getByLabelText("Entry price (₹)"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "Watch the retest." },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(props.onSave).toHaveBeenCalledWith(
      props.item,
      expect.objectContaining({
        version: 3,
        timeframe: null,
        entryPrice: null,
        notes: "Watch the retest.",
      })
    );
  });

  test("keeps edits after a 409 conflict and reloads the latest version", async () => {
    const props = editorProps();
    props.onSave = jest.fn().mockRejectedValue(
      new LiveTradeClientError("Conflict", {
        status: 409,
        code: "EDIT_CONFLICT",
      })
    );

    render(<ItemEditor {...props} />);
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "My unsaved thesis" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(screen.getByText(/changed in another request/)).toBeTruthy();
    expect(props.onConflictReload).toHaveBeenCalled();
    const notes = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    expect(notes.value).toBe("My unsaved thesis");
  });

  test("asks before discarding unsaved edits", () => {
    const props = editorProps();
    render(<ItemEditor {...props} />);

    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "Draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(
      (screen.getByLabelText("Notes") as HTMLTextAreaElement).value
    ).toBe("Draft");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and close" }));
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe("GroupManager", () => {
  function groupProps(overrides: Record<string, unknown> = {}) {
    return {
      groups: [makeGroup("g1", "Momentum", 1), makeGroup("g2", "Swing", 2)],
      onClose: jest.fn(),
      onCreate: jest.fn().mockResolvedValue(undefined),
      onRename: jest.fn().mockResolvedValue(undefined),
      onDelete: jest.fn().mockResolvedValue(undefined),
      onReorder: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  test("creates a group and sends the trimmed name", async () => {
    const props = groupProps();
    render(<GroupManager {...props} />);

    fireEvent.change(screen.getByLabelText("New group"), {
      target: { value: "  Breakouts  " },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(props.onCreate).toHaveBeenCalledWith("Breakouts");
  });

  test("renames and reorders groups with version-aware payloads", async () => {
    const props = groupProps();
    render(<GroupManager {...props} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]);
    fireEvent.change(screen.getByLabelText("Rename Momentum"), {
      target: { value: "Momentum+" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(props.onRename).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "g1", version: 1 }),
      "Momentum+"
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move Momentum down" }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(props.onReorder).toHaveBeenCalledWith(["g2", "g1"]);
  });

  test("deleting a group explains that instruments become ungrouped", async () => {
    const props = groupProps();
    render(<GroupManager {...props} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    expect(
      screen.getByText(/Instruments in this group will become ungrouped/)
    ).toBeTruthy();
    expect(screen.getByText(/They will not be deleted/)).toBeTruthy();
    expect(props.onDelete).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(props.onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "g1", version: 1 })
    );
  });
});
