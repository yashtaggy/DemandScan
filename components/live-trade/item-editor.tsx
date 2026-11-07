"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  LiveTradeGroupDto,
  LiveTradeItemDto,
} from "@/lib/live-trade/client";
import {
  isLiveTradeClientError,
  liveTradeErrorMessage,
  type UpdateItemPayload,
} from "@/lib/live-trade/client";
import {
  LIVE_TRADE_DIRECTIONS,
  LIVE_TRADE_NOTES_MAX_LENGTH,
  LIVE_TRADE_PRIORITIES,
  LIVE_TRADE_PRICE_DECIMALS,
  LIVE_TRADE_PRICE_MAX,
  LIVE_TRADE_TIMEFRAMES,
  type LiveTradeDirection,
  type LiveTradePriority,
  type LiveTradeTimeframe,
} from "@/lib/live-trade/constants";
import {
  PRIORITY_META,
  STATUS_LABEL,
  directionLabel,
} from "@/lib/live-trade/ui";
import { Modal } from "./modal";

interface ItemEditorProps {
  item: LiveTradeItemDto;
  groups: LiveTradeGroupDto[];
  onClose: () => void;
  onSave: (item: LiveTradeItemDto, payload: UpdateItemPayload) => Promise<void>;
  onConflictReload: () => Promise<void>;
}

interface FormState {
  priority: LiveTradePriority;
  groupId: string;
  direction: "" | LiveTradeDirection;
  timeframe: "ANY" | LiveTradeTimeframe;
  entryPrice: string;
  targetPrice: string;
  stopLoss: string;
  notes: string;
}

type FieldErrors = Partial<
  Record<"groupId" | "entryPrice" | "targetPrice" | "stopLoss" | "notes", string>
>;

function toForm(item: LiveTradeItemDto): FormState {
  return {
    priority: item.priority,
    groupId: item.groupId ?? "",
    direction: item.direction ?? "",
    timeframe: item.timeframe ?? "ANY",
    entryPrice: item.entryPrice === null ? "" : String(item.entryPrice),
    targetPrice: item.targetPrice === null ? "" : String(item.targetPrice),
    stopLoss: item.stopLoss === null ? "" : String(item.stopLoss),
    notes: item.notes,
  };
}

function sameForm(a: FormState, b: FormState): boolean {
  return (
    a.priority === b.priority &&
    a.groupId === b.groupId &&
    a.direction === b.direction &&
    a.timeframe === b.timeframe &&
    a.entryPrice === b.entryPrice &&
    a.targetPrice === b.targetPrice &&
    a.stopLoss === b.stopLoss &&
    a.notes === b.notes
  );
}

type ParsedPrice =
  | { ok: true; value: number | null }
  | { ok: false; message: string };

function parsePriceField(raw: string, label: string): ParsedPrice {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^[0-9]+(\.[0-9]{1,4})?$/.test(trimmed)) {
    return {
      ok: false,
      message: `${label} must be a positive number with at most ${LIVE_TRADE_PRICE_DECIMALS} decimal places.`,
    };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, message: `${label} must be greater than zero.` };
  }
  if (value > LIVE_TRADE_PRICE_MAX) {
    return { ok: false, message: `${label} is too large.` };
  }
  return { ok: true, value };
}

const inputClass =
  "w-full rounded-lg border border-slate-700/60 bg-slate-900/70 px-2.5 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/60";
const labelClass = "text-[11px] font-medium text-slate-400";
const errorClass = "text-[11px] text-rose-400";

export function ItemEditor({
  item,
  groups,
  onClose,
  onSave,
  onConflictReload,
}: ItemEditorProps) {
  const [form, setForm] = useState<FormState>(() => toForm(item));
  const [initialForm] = useState<FormState>(() => toForm(item));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<{
    kind: "error" | "warning";
    message: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const dirty = !sameForm(form, initialForm);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  function update<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((previous) => ({ ...previous, [field]: value }));
    setFieldErrors((previous) => ({ ...previous, [field]: undefined }));
    setNotice(null);
  }

  function requestClose() {
    if (saving) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !dirty) return;

    const nextErrors: FieldErrors = {};
    const entry = parsePriceField(form.entryPrice, "Entry price");
    const target = parsePriceField(form.targetPrice, "Target price");
    const stop = parsePriceField(form.stopLoss, "Stop-loss");
    if (!entry.ok) nextErrors.entryPrice = entry.message;
    if (!target.ok) nextErrors.targetPrice = target.message;
    if (!stop.ok) nextErrors.stopLoss = stop.message;

    if (
      form.groupId !== "" &&
      !groups.some((group) => group.groupId === form.groupId)
    ) {
      nextErrors.groupId = "Select an available group or Ungrouped.";
    }

    const notesLength = Array.from(form.notes).length;
    if (notesLength > LIVE_TRADE_NOTES_MAX_LENGTH) {
      nextErrors.notes = `Notes must be at most ${LIVE_TRADE_NOTES_MAX_LENGTH} characters.`;
    }

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      setNotice({ kind: "error", message: "Fix the highlighted fields." });
      return;
    }

    const payload: UpdateItemPayload = {
      version: item.version,
      priority: form.priority,
      groupId: form.groupId === "" ? null : form.groupId,
      direction: form.direction === "" ? null : form.direction,
      timeframe: form.timeframe === "ANY" ? null : form.timeframe,
      entryPrice: entry.ok ? entry.value : null,
      targetPrice: target.ok ? target.value : null,
      stopLoss: stop.ok ? stop.value : null,
      notes: form.notes,
    };

    setSaving(true);
    setNotice(null);
    setFieldErrors({});

    try {
      await onSave(item, payload);
    } catch (cause) {
      if (isLiveTradeClientError(cause) && cause.code === "EDIT_CONFLICT") {
        setNotice({
          kind: "warning",
          message:
            "This item changed in another request. The latest version has been loaded; your edits are still here. Review and save again.",
        });
        try {
          await onConflictReload();
        } catch {
          // The notice already tells the user to retry; the form stays intact.
        }
      } else if (
        isLiveTradeClientError(cause) &&
        cause.code === "NOT_FOUND"
      ) {
        setNotice({
          kind: "error",
          message:
            "This item no longer exists. It may have been removed in another session.",
        });
      } else {
        setNotice({ kind: "error", message: liveTradeErrorMessage(cause) });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={requestClose}
      title={`Edit ${item.symbol}`}
      description={`${item.companyName ?? "Company name unavailable"} · ${
        STATUS_LABEL[item.tradeStatus]
      } · version ${item.version}`}
      closeDisabled={saving}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[10px] text-slate-600">
            Planned levels only — no order is placed.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={requestClose}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="live-trade-item-form"
              variant="primary"
              size="sm"
              loading={saving}
              disabled={!dirty || saving}
            >
              Save changes
            </Button>
          </div>
        </div>
      }
    >
      {confirmDiscard && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-xs text-amber-300">
            You have unsaved changes. Discard them and close?
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDiscard(false)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={onClose}
            >
              Discard and close
            </Button>
          </div>
        </div>
      )}

      {notice && (
        <div
          role={notice.kind === "error" ? "alert" : "status"}
          className={
            notice.kind === "error"
              ? "mb-4 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 text-xs text-rose-300"
              : "mb-4 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-300"
          }
        >
          {notice.message}
        </div>
      )}

      <form
        id="live-trade-item-form"
        onSubmit={(event) => void handleSubmit(event)}
        className="space-y-4"
        noValidate
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor="item-priority" className={labelClass}>
              Priority
            </label>
            <select
              id="item-priority"
              value={form.priority}
              onChange={(event) =>
                update("priority", event.target.value as LiveTradePriority)
              }
              className={inputClass}
              data-autofocus
            >
              {LIVE_TRADE_PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {PRIORITY_META[priority].label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="item-group" className={labelClass}>
              Group
            </label>
            <select
              id="item-group"
              value={form.groupId}
              onChange={(event) => update("groupId", event.target.value)}
              aria-invalid={fieldErrors.groupId ? true : undefined}
              aria-describedby={
                fieldErrors.groupId ? "item-group-error" : undefined
              }
              className={inputClass}
            >
              <option value="">Ungrouped</option>
              {groups.map((group) => (
                <option key={group.groupId} value={group.groupId}>
                  {group.name}
                </option>
              ))}
            </select>
            {fieldErrors.groupId && (
              <p id="item-group-error" className={errorClass}>
                {fieldErrors.groupId}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="item-direction" className={labelClass}>
              Direction
            </label>
            <select
              id="item-direction"
              value={form.direction}
              onChange={(event) =>
                update(
                  "direction",
                  event.target.value as "" | LiveTradeDirection
                )
              }
              className={inputClass}
            >
              <option value="">Not set</option>
              {LIVE_TRADE_DIRECTIONS.map((direction) => (
                <option key={direction} value={direction}>
                  {directionLabel(direction)}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label htmlFor="item-timeframe" className={labelClass}>
              Timeframe
            </label>
            <select
              id="item-timeframe"
              value={form.timeframe}
              onChange={(event) =>
                update(
                  "timeframe",
                  event.target.value as "ANY" | LiveTradeTimeframe
                )
              }
              className={inputClass}
            >
              <option value="ANY">Any timeframe</option>
              {LIVE_TRADE_TIMEFRAMES.map((timeframe) => (
                <option key={timeframe} value={timeframe}>
                  {timeframe}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="item-entry" className={labelClass}>
              Entry price (₹)
            </label>
            <input
              id="item-entry"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={form.entryPrice}
              onChange={(event) => update("entryPrice", event.target.value)}
              aria-invalid={fieldErrors.entryPrice ? true : undefined}
              aria-describedby={
                fieldErrors.entryPrice ? "item-entry-error" : undefined
              }
              className={inputClass}
              placeholder="Optional"
            />
            {fieldErrors.entryPrice && (
              <p id="item-entry-error" className={errorClass}>
                {fieldErrors.entryPrice}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="item-target" className={labelClass}>
              Target price (₹)
            </label>
            <input
              id="item-target"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={form.targetPrice}
              onChange={(event) => update("targetPrice", event.target.value)}
              aria-invalid={fieldErrors.targetPrice ? true : undefined}
              aria-describedby={
                fieldErrors.targetPrice ? "item-target-error" : undefined
              }
              className={inputClass}
              placeholder="Optional"
            />
            {fieldErrors.targetPrice && (
              <p id="item-target-error" className={errorClass}>
                {fieldErrors.targetPrice}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="item-stop" className={labelClass}>
              Stop-loss (₹)
            </label>
            <input
              id="item-stop"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={form.stopLoss}
              onChange={(event) => update("stopLoss", event.target.value)}
              aria-invalid={fieldErrors.stopLoss ? true : undefined}
              aria-describedby={
                fieldErrors.stopLoss ? "item-stop-error" : undefined
              }
              className={inputClass}
              placeholder="Optional"
            />
            {fieldErrors.stopLoss && (
              <p id="item-stop-error" className={errorClass}>
                {fieldErrors.stopLoss}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label htmlFor="item-notes" className={labelClass}>
              Notes
            </label>
            <span className="text-[10px] tabular-nums text-slate-600">
              {Array.from(form.notes).length} / {LIVE_TRADE_NOTES_MAX_LENGTH}
            </span>
          </div>
          <textarea
            id="item-notes"
            rows={4}
            value={form.notes}
            maxLength={LIVE_TRADE_NOTES_MAX_LENGTH}
            onChange={(event) => update("notes", event.target.value)}
            aria-invalid={fieldErrors.notes ? true : undefined}
            aria-describedby={fieldErrors.notes ? "item-notes-error" : undefined}
            className={inputClass}
            placeholder="Optional notes about this setup"
          />
          {fieldErrors.notes && (
            <p id="item-notes-error" className={errorClass}>
              {fieldErrors.notes}
            </p>
          )}
        </div>

        <p className="text-[10px] text-slate-600">
          An empty price field clears that level. Prices must be greater than
          zero and support up to {LIVE_TRADE_PRICE_DECIMALS} decimal places.
        </p>
      </form>
    </Modal>
  );
}
