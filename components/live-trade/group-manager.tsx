"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { LiveTradeGroupDto } from "@/lib/live-trade/client";
import { liveTradeErrorMessage } from "@/lib/live-trade/client";
import {
  LIVE_TRADE_GROUP_LIMIT,
  LIVE_TRADE_GROUP_NAME_MAX_LENGTH,
} from "@/lib/live-trade/constants";
import { Modal } from "./modal";

interface GroupManagerProps {
  groups: LiveTradeGroupDto[];
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (group: LiveTradeGroupDto, name: string) => Promise<void>;
  onDelete: (group: LiveTradeGroupDto) => Promise<void>;
  onReorder: (orderedGroupIds: string[]) => Promise<void>;
}

const inputClass =
  "w-full rounded-md border border-slate-700/60 bg-slate-900/70 px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500/60";

export function GroupManager({
  groups,
  onClose,
  onCreate,
  onRename,
  onDelete,
  onReorder,
}: GroupManagerProps) {
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = creating || pendingId !== null || reordering;
  const atLimit = groups.length >= LIVE_TRADE_GROUP_LIMIT;

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = newName.trim();
    if (trimmed === "") {
      setError("Enter a group name.");
      return;
    }
    if (Array.from(trimmed).length > LIVE_TRADE_GROUP_NAME_MAX_LENGTH) {
      setError(
        `Group names must be at most ${LIVE_TRADE_GROUP_NAME_MAX_LENGTH} characters.`
      );
      return;
    }
    if (atLimit) {
      setError(`You already have ${LIVE_TRADE_GROUP_LIMIT} groups.`);
      return;
    }

    setCreating(true);
    setError(null);
    try {
      await onCreate(trimmed);
      setNewName("");
    } catch (cause) {
      setError(liveTradeErrorMessage(cause));
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(group: LiveTradeGroupDto) {
    const trimmed = editingName.trim();
    if (trimmed === "") {
      setError("Enter a group name.");
      return;
    }
    if (Array.from(trimmed).length > LIVE_TRADE_GROUP_NAME_MAX_LENGTH) {
      setError(
        `Group names must be at most ${LIVE_TRADE_GROUP_NAME_MAX_LENGTH} characters.`
      );
      return;
    }
    if (trimmed === group.name) {
      setEditingId(null);
      return;
    }

    setPendingId(group.groupId);
    setError(null);
    try {
      await onRename(group, trimmed);
      setEditingId(null);
    } catch (cause) {
      setError(liveTradeErrorMessage(cause));
    } finally {
      setPendingId(null);
    }
  }

  async function handleDelete(group: LiveTradeGroupDto) {
    setPendingId(group.groupId);
    setError(null);
    try {
      await onDelete(group);
      setConfirmDeleteId(null);
    } catch (cause) {
      setError(liveTradeErrorMessage(cause));
    } finally {
      setPendingId(null);
    }
  }

  async function moveGroup(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= groups.length) return;
    const ordered = groups.map((group) => group.groupId);
    const [moved] = ordered.splice(index, 1);
    ordered.splice(target, 0, moved);

    setReordering(true);
    setError(null);
    try {
      await onReorder(ordered);
    } catch (cause) {
      setError(liveTradeErrorMessage(cause));
    } finally {
      setReordering(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Manage groups"
      description={`${groups.length} of ${LIVE_TRADE_GROUP_LIMIT} groups. Deleting a group never deletes its instruments.`}
      closeDisabled={busy}
      footer={
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={busy}
          >
            Done
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs text-rose-300"
          >
            {error}
          </p>
        )}

        <form
          onSubmit={(event) => void handleCreate(event)}
          className="flex items-end gap-2"
        >
          <div className="flex-1 space-y-1">
            <label
              htmlFor="new-group-name"
              className="text-[11px] font-medium text-slate-400"
            >
              New group
            </label>
            <input
              id="new-group-name"
              type="text"
              value={newName}
              maxLength={LIVE_TRADE_GROUP_NAME_MAX_LENGTH}
              onChange={(event) => {
                setNewName(event.target.value);
                setError(null);
              }}
              placeholder="e.g. Momentum"
              className={inputClass}
              disabled={atLimit || creating}
              data-autofocus
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            loading={creating}
            disabled={atLimit || creating || newName.trim() === ""}
          >
            Create
          </Button>
        </form>

        {atLimit && (
          <p className="text-[11px] text-amber-400">
            The {LIVE_TRADE_GROUP_LIMIT}-group limit is reached. Delete a group
            to create another.
          </p>
        )}

        {groups.length === 0 ? (
          <p className="rounded-lg border border-slate-700/40 bg-slate-800/30 px-3 py-4 text-center text-xs text-slate-500">
            No groups yet. Create one to organise the watchlist.
          </p>
        ) : (
          <ul className="divide-y divide-slate-700/40 rounded-lg border border-slate-700/40">
            {groups.map((group, index) => {
              const editing = editingId === group.groupId;
              const deleting = confirmDeleteId === group.groupId;
              const pending = pendingId === group.groupId;

              return (
                <li key={group.groupId} className="px-3 py-2">
                  {deleting ? (
                    <div className="space-y-2">
                      <p className="text-xs text-slate-300">
                        Delete “{group.name}”? Instruments in this group will
                        become ungrouped. They will not be deleted.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          loading={pending}
                          onClick={() => void handleDelete(group)}
                        >
                          Delete group
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : editing ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={editingName}
                        maxLength={LIVE_TRADE_GROUP_NAME_MAX_LENGTH}
                        aria-label={`Rename ${group.name}`}
                        onChange={(event) => setEditingName(event.target.value)}
                        className={inputClass}
                        data-autofocus
                      />
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        loading={pending}
                        onClick={() => void handleRename(group)}
                      >
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-slate-200">{group.name}</span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Move ${group.name} up`}
                          title="Move up"
                          disabled={busy || index === 0}
                          onClick={() => void moveGroup(index, -1)}
                          className="rounded border border-slate-700/50 bg-slate-800/40 px-1.5 py-1 text-[11px] text-slate-400 hover:text-slate-200 disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${group.name} down`}
                          title="Move down"
                          disabled={busy || index === groups.length - 1}
                          onClick={() => void moveGroup(index, 1)}
                          className="rounded border border-slate-700/50 bg-slate-800/40 px-1.5 py-1 text-[11px] text-slate-400 hover:text-slate-200 disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(group.groupId);
                            setEditingName(group.name);
                            setConfirmDeleteId(null);
                            setError(null);
                          }}
                          disabled={busy}
                          className="rounded border border-slate-700/50 bg-slate-800/40 px-1.5 py-1 text-[11px] text-slate-300 hover:bg-slate-700/50 disabled:opacity-30"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteId(group.groupId);
                            setEditingId(null);
                            setError(null);
                          }}
                          disabled={busy}
                          className="rounded border border-rose-500/20 bg-rose-500/5 px-1.5 py-1 text-[11px] text-rose-400 hover:bg-rose-500/10 disabled:opacity-30"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
