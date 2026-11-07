/**
 * Live Trade input validation.
 *
 * Pure functions: no database, no session, no I/O. Every parser returns a
 * discriminated union so routes can turn failures into a 400 without throwing
 * from deep call sites.
 *
 * Invariants enforced here mirror the database constraints:
 *  - `timeframe` absent on create  → "1D"; explicit `null` → Any (NULL).
 *  - `timeframe` absent on update  → unchanged; explicit `null` → Any.
 *  - prices are > 0, <= 1e9 and fit NUMERIC(18,4).
 *  - notes are <= 2000 characters, counted as code points to match
 *    PostgreSQL `char_length`.
 *  - group names are trimmed, 1–60 characters, no control characters.
 *  - `version` is a positive PostgreSQL INTEGER.
 */

import {
  DEFAULT_LIVE_TRADE_PRIORITY,
  DEFAULT_LIVE_TRADE_STATUS,
  DEFAULT_LIVE_TRADE_TIMEFRAME,
  LIVE_TRADE_DIRECTIONS,
  LIVE_TRADE_GROUP_NAME_MAX_LENGTH,
  LIVE_TRADE_GROUP_NAME_MIN_LENGTH,
  LIVE_TRADE_GROUP_LIMIT,
  LIVE_TRADE_ITEM_LIMIT,
  LIVE_TRADE_NOTES_MAX_LENGTH,
  LIVE_TRADE_OWNER_ID_MAX_LENGTH,
  LIVE_TRADE_PRICE_DECIMALS,
  LIVE_TRADE_PRICE_MAX,
  LIVE_TRADE_PRIORITIES,
  LIVE_TRADE_STATUSES,
  LIVE_TRADE_TIMEFRAMES,
  LIVE_TRADE_VERSION_MAX,
  LIVE_TRADE_VERSION_MIN,
  type LiveTradeDirection,
  type LiveTradePriority,
  type LiveTradeStatus,
  type LiveTradeTimeframe,
} from "./constants";
import { LiveTradeError } from "./errors";
import type {
  CreateLiveTradeGroupInput,
  CreateLiveTradeItemInput,
  LiveTradeGroupReorderInput,
  LiveTradeReorderInput,
  UpdateLiveTradeGroupInput,
  UpdateLiveTradeItemInput,
} from "./types";

// ─── Result types ─────────────────────────────────────────────────────────────

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationFailure {
  ok: false;
  code: "INVALID_BODY" | "INVALID_QUERY";
  issues: ValidationIssue[];
}

export type Parsed<T> = { ok: true; value: T } | ValidationFailure;

type Source = "body" | "query";

function failure(source: Source, issues: ValidationIssue[]): ValidationFailure {
  return {
    ok: false,
    code: source === "query" ? "INVALID_QUERY" : "INVALID_BODY",
    issues:
      issues.length > 0
        ? issues
        : [{ field: source, message: "Invalid request." }],
  };
}

/** Converts a validation failure into the shared API error type. */
export function toLiveTradeError(failureResult: ValidationFailure): LiveTradeError {
  return new LiveTradeError(
    failureResult.code,
    failureResult.issues[0]?.message,
    { issues: failureResult.issues }
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Code-point length, matching PostgreSQL `char_length` for text columns. */
function characterLength(value: string): number {
  return Array.from(value).length;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Mirrors `live_trade_*_owner_not_blank`:
 * `btrim(owner_user_id) <> '' AND char_length(owner_user_id) <= 64`.
 */
export function isValidOwnerId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    characterLength(value) <= LIVE_TRADE_OWNER_ID_MAX_LENGTH
  );
}

// ─── Enum guards ──────────────────────────────────────────────────────────────

function isOneOf<T extends string>(
  allowed: readonly T[],
  value: unknown
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function isLiveTradePriority(value: unknown): value is LiveTradePriority {
  return isOneOf(LIVE_TRADE_PRIORITIES, value);
}

export function isLiveTradeDirection(value: unknown): value is LiveTradeDirection {
  return isOneOf(LIVE_TRADE_DIRECTIONS, value);
}

export function isLiveTradeTimeframe(value: unknown): value is LiveTradeTimeframe {
  return isOneOf(LIVE_TRADE_TIMEFRAMES, value);
}

export function isLiveTradeStatus(value: unknown): value is LiveTradeStatus {
  return isOneOf(LIVE_TRADE_STATUSES, value);
}

// ─── Field readers ────────────────────────────────────────────────────────────

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  issues: ValidationIssue[],
  messages: Record<string, string> = {}
): void {
  for (const key of Object.keys(input)) {
    if (allowed.has(key)) continue;
    issues.push({
      field: key,
      message: messages[key] ?? "Unknown field.",
    });
  }
}

function readEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  issues: ValidationIssue[]
): T | undefined {
  if (!isOneOf(allowed, value)) {
    issues.push({
      field,
      message: `Expected one of: ${allowed.join(", ")}.`,
    });
    return undefined;
  }
  return value;
}

/** `null` is a valid explicit value; `undefined` means "not supplied" or invalid. */
function readNullableEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  issues: ValidationIssue[]
): T | null | undefined {
  if (value === null) return null;
  return readEnum(value, field, allowed, issues);
}

function readInstrumentId(
  value: unknown,
  issues: ValidationIssue[]
): number | undefined {
  if (value === undefined) {
    issues.push({ field: "instrumentId", message: "instrumentId is required." });
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    issues.push({
      field: "instrumentId",
      message: "instrumentId must be a positive integer.",
    });
    return undefined;
  }
  return value;
}

/** `null` clears the field; a string must be a UUID. */
function readNullableUuid(
  value: unknown,
  field: string,
  issues: ValidationIssue[]
): string | null | undefined {
  if (value === null) return null;
  if (!isUuid(value)) {
    issues.push({ field, message: `${field} must be a UUID or null.` });
    return undefined;
  }
  return value;
}

function readNullablePrice(
  value: unknown,
  field: string,
  issues: ValidationIssue[]
): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push({ field, message: `${field} must be a number or null.` });
    return undefined;
  }
  if (value <= 0 || value > LIVE_TRADE_PRICE_MAX) {
    issues.push({
      field,
      message: `${field} must be greater than 0 and at most ${LIVE_TRADE_PRICE_MAX}.`,
    });
    return undefined;
  }
  // NUMERIC(18,4): reject values that would be silently rounded.
  const scaled = value * 10 ** LIVE_TRADE_PRICE_DECIMALS;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    issues.push({
      field,
      message: `${field} supports at most ${LIVE_TRADE_PRICE_DECIMALS} decimal places.`,
    });
    return undefined;
  }
  return value;
}

/** Normalizes CRLF/CR to LF; notes are otherwise preserved verbatim. */
export function normalizeNotes(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function readNotes(value: unknown, issues: ValidationIssue[]): string | undefined {
  if (typeof value !== "string") {
    issues.push({ field: "notes", message: "notes must be a string." });
    return undefined;
  }
  const normalized = normalizeNotes(value);
  if (characterLength(normalized) > LIVE_TRADE_NOTES_MAX_LENGTH) {
    issues.push({
      field: "notes",
      message: `notes must be at most ${LIVE_TRADE_NOTES_MAX_LENGTH} characters.`,
    });
    return undefined;
  }
  return normalized;
}

function readGroupName(
  value: unknown,
  issues: ValidationIssue[]
): string | undefined {
  if (typeof value !== "string") {
    issues.push({ field: "name", message: "name must be a string." });
    return undefined;
  }
  const trimmed = value.trim();
  const length = characterLength(trimmed);
  if (length < LIVE_TRADE_GROUP_NAME_MIN_LENGTH || length > LIVE_TRADE_GROUP_NAME_MAX_LENGTH) {
    issues.push({
      field: "name",
      message: `name must be between ${LIVE_TRADE_GROUP_NAME_MIN_LENGTH} and ${LIVE_TRADE_GROUP_NAME_MAX_LENGTH} characters.`,
    });
    return undefined;
  }
  // Tabs/newlines break list rendering; reject all C0 controls and DEL.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    issues.push({
      field: "name",
      message: "name must not contain control characters.",
    });
    return undefined;
  }
  return trimmed;
}

function readVersion(
  value: unknown,
  field: string,
  issues: ValidationIssue[]
): number | undefined {
  if (value === undefined) {
    issues.push({ field, message: `${field} is required.` });
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < LIVE_TRADE_VERSION_MIN ||
    value > LIVE_TRADE_VERSION_MAX
  ) {
    issues.push({
      field,
      message: `${field} must be an integer between ${LIVE_TRADE_VERSION_MIN} and ${LIVE_TRADE_VERSION_MAX}.`,
    });
    return undefined;
  }
  return value;
}

// ─── Item create ──────────────────────────────────────────────────────────────

const CREATE_ITEM_KEYS: ReadonlySet<string> = new Set([
  "instrumentId",
  "groupId",
  "priority",
  "direction",
  "timeframe",
  "entryPrice",
  "targetPrice",
  "stopLoss",
  "notes",
  "tradeStatus",
]);

const OWNER_FIELD_MESSAGE =
  "The owner is resolved from the session and must not be supplied.";

export function parseCreateItemInput(raw: unknown): Parsed<CreateLiveTradeItemInput> {
  if (!isPlainObject(raw)) {
    return failure("body", [
      { field: "body", message: "Request body must be a JSON object." },
    ]);
  }

  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(raw, CREATE_ITEM_KEYS, issues, {
    ownerUserId: OWNER_FIELD_MESSAGE,
  });

  const instrumentId = readInstrumentId(raw.instrumentId, issues);

  const priority: LiveTradePriority = hasOwn(raw, "priority")
    ? (readEnum(raw.priority, "priority", LIVE_TRADE_PRIORITIES, issues) ??
      DEFAULT_LIVE_TRADE_PRIORITY)
    : DEFAULT_LIVE_TRADE_PRIORITY;

  const tradeStatus: LiveTradeStatus = hasOwn(raw, "tradeStatus")
    ? (readEnum(raw.tradeStatus, "tradeStatus", LIVE_TRADE_STATUSES, issues) ??
      DEFAULT_LIVE_TRADE_STATUS)
    : DEFAULT_LIVE_TRADE_STATUS;

  // Omitted timeframe means the 1D preference; explicit null means Any.
  const timeframe: LiveTradeTimeframe | null = hasOwn(raw, "timeframe")
    ? (readNullableEnum(raw.timeframe, "timeframe", LIVE_TRADE_TIMEFRAMES, issues) ??
      null)
    : DEFAULT_LIVE_TRADE_TIMEFRAME;

  const direction: LiveTradeDirection | null = hasOwn(raw, "direction")
    ? (readNullableEnum(raw.direction, "direction", LIVE_TRADE_DIRECTIONS, issues) ??
      null)
    : null;

  const groupId: string | null = hasOwn(raw, "groupId")
    ? (readNullableUuid(raw.groupId, "groupId", issues) ?? null)
    : null;

  const entryPrice: number | null = hasOwn(raw, "entryPrice")
    ? (readNullablePrice(raw.entryPrice, "entryPrice", issues) ?? null)
    : null;

  const targetPrice: number | null = hasOwn(raw, "targetPrice")
    ? (readNullablePrice(raw.targetPrice, "targetPrice", issues) ?? null)
    : null;

  const stopLoss: number | null = hasOwn(raw, "stopLoss")
    ? (readNullablePrice(raw.stopLoss, "stopLoss", issues) ?? null)
    : null;

  const notes: string = hasOwn(raw, "notes")
    ? (readNotes(raw.notes, issues) ?? "")
    : "";

  if (issues.length > 0 || instrumentId === undefined) {
    return failure("body", issues);
  }

  return {
    ok: true,
    value: {
      instrumentId,
      groupId,
      priority,
      direction,
      timeframe,
      entryPrice,
      targetPrice,
      stopLoss,
      notes,
      tradeStatus,
    },
  };
}

// ─── Item update ─────────────────────────────────────────────────────────────

const UPDATE_ITEM_KEYS: ReadonlySet<string> = new Set([
  "version",
  "groupId",
  "priority",
  "direction",
  "timeframe",
  "entryPrice",
  "targetPrice",
  "stopLoss",
  "notes",
  "tradeStatus",
]);

const UPDATE_ITEM_FIELD_MESSAGES: Record<string, string> = {
  ownerUserId: OWNER_FIELD_MESSAGE,
  instrumentId: "instrumentId is immutable.",
};

export function parseUpdateItemInput(raw: unknown): Parsed<UpdateLiveTradeItemInput> {
  if (!isPlainObject(raw)) {
    return failure("body", [
      { field: "body", message: "Request body must be a JSON object." },
    ]);
  }

  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(raw, UPDATE_ITEM_KEYS, issues, UPDATE_ITEM_FIELD_MESSAGES);

  const version = readVersion(raw.version, "version", issues);
  const value: UpdateLiveTradeItemInput = {
    version: version ?? LIVE_TRADE_VERSION_MIN,
  };

  let mutableFields = 0;

  if (hasOwn(raw, "groupId")) {
    mutableFields += 1;
    const parsed = readNullableUuid(raw.groupId, "groupId", issues);
    if (parsed !== undefined) value.groupId = parsed;
  }

  if (hasOwn(raw, "priority")) {
    mutableFields += 1;
    const parsed = readEnum(raw.priority, "priority", LIVE_TRADE_PRIORITIES, issues);
    if (parsed !== undefined) value.priority = parsed;
  }

  if (hasOwn(raw, "tradeStatus")) {
    mutableFields += 1;
    const parsed = readEnum(raw.tradeStatus, "tradeStatus", LIVE_TRADE_STATUSES, issues);
    if (parsed !== undefined) value.tradeStatus = parsed;
  }

  if (hasOwn(raw, "timeframe")) {
    mutableFields += 1;
    const parsed = readNullableEnum(raw.timeframe, "timeframe", LIVE_TRADE_TIMEFRAMES, issues);
    if (parsed !== undefined) value.timeframe = parsed;
  }

  if (hasOwn(raw, "direction")) {
    mutableFields += 1;
    const parsed = readNullableEnum(raw.direction, "direction", LIVE_TRADE_DIRECTIONS, issues);
    if (parsed !== undefined) value.direction = parsed;
  }

  for (const field of ["entryPrice", "targetPrice", "stopLoss"] as const) {
    if (!hasOwn(raw, field)) continue;
    mutableFields += 1;
    const parsed = readNullablePrice(raw[field], field, issues);
    if (parsed !== undefined) value[field] = parsed;
  }

  if (hasOwn(raw, "notes")) {
    mutableFields += 1;
    const parsed = readNotes(raw.notes, issues);
    if (parsed !== undefined) value.notes = parsed;
  }

  if (mutableFields === 0) {
    issues.push({
      field: "body",
      message: "Provide at least one field to update.",
    });
  }

  if (issues.length > 0 || version === undefined) {
    return failure("body", issues);
  }

  return { ok: true, value };
}

// ─── Version (delete / query parameters) ─────────────────────────────────────

export function parseVersion(
  value: unknown,
  source: Source = "body"
): Parsed<number> {
  const issues: ValidationIssue[] = [];
  const version = readVersion(value, "version", issues);
  if (version === undefined) return failure(source, issues);
  return { ok: true, value: version };
}

// ─── Groups ──────────────────────────────────────────────────────────────────

const CREATE_GROUP_KEYS: ReadonlySet<string> = new Set(["name"]);
const UPDATE_GROUP_KEYS: ReadonlySet<string> = new Set(["name", "version"]);

export function parseCreateGroupInput(
  raw: unknown
): Parsed<CreateLiveTradeGroupInput> {
  if (!isPlainObject(raw)) {
    return failure("body", [
      { field: "body", message: "Request body must be a JSON object." },
    ]);
  }

  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(raw, CREATE_GROUP_KEYS, issues, {
    ownerUserId: OWNER_FIELD_MESSAGE,
  });

  const name = readGroupName(raw.name, issues);
  if (issues.length > 0 || name === undefined) return failure("body", issues);
  return { ok: true, value: { name } };
}

export function parseUpdateGroupInput(
  raw: unknown
): Parsed<UpdateLiveTradeGroupInput> {
  if (!isPlainObject(raw)) {
    return failure("body", [
      { field: "body", message: "Request body must be a JSON object." },
    ]);
  }

  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(raw, UPDATE_GROUP_KEYS, issues, {
    ownerUserId: OWNER_FIELD_MESSAGE,
  });

  const name = readGroupName(raw.name, issues);
  const version = readVersion(raw.version, "version", issues);

  if (issues.length > 0 || name === undefined || version === undefined) {
    return failure("body", issues);
  }
  return { ok: true, value: { name, version } };
}

// ─── Reorder ─────────────────────────────────────────────────────────────────

const REORDER_KEYS: ReadonlySet<string> = new Set(["orderedItemIds"]);
const GROUP_REORDER_KEYS: ReadonlySet<string> = new Set(["orderedGroupIds"]);

/**
 * Shared shape validation for reorder payloads: a bounded array of unique UUIDs.
 * The exact-once set comparison against owned rows happens in SQL, not here.
 */
function readOrderedUuidList(
  value: unknown,
  field: string,
  maxLength: number,
  issues: ValidationIssue[]
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ field, message: `${field} must be an array of IDs.` });
    return undefined;
  }

  if (value.length > maxLength) {
    issues.push({
      field,
      message: `${field} must contain at most ${maxLength} IDs.`,
    });
  }

  const seen = new Set<string>();
  let valid = value.length <= maxLength;

  value.forEach((id, index) => {
    if (!isUuid(id)) {
      issues.push({
        field: `${field}[${index}]`,
        message: "Each ID must be a UUID.",
      });
      valid = false;
      return;
    }
    const normalized = id.toLowerCase();
    if (seen.has(normalized)) {
      issues.push({
        field: `${field}[${index}]`,
        message: "Duplicate ID.",
      });
      valid = false;
      return;
    }
    seen.add(normalized);
  });

  return valid ? (value as string[]) : undefined;
}

export function parseReorderInput(raw: unknown): Parsed<LiveTradeReorderInput> {
  if (!isPlainObject(raw)) {
    return failure("body", [
      { field: "body", message: "Request body must be a JSON object." },
    ]);
  }

  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(raw, REORDER_KEYS, issues, {
    ownerUserId: OWNER_FIELD_MESSAGE,
  });

  const ids = readOrderedUuidList(
    raw.orderedItemIds,
    "orderedItemIds",
    LIVE_TRADE_ITEM_LIMIT,
    issues
  );

  if (issues.length > 0 || ids === undefined) return failure("body", issues);
  return { ok: true, value: { orderedItemIds: ids } };
}

export function parseGroupReorderInput(
  raw: unknown
): Parsed<LiveTradeGroupReorderInput> {
  if (!isPlainObject(raw)) {
    return failure("body", [
      { field: "body", message: "Request body must be a JSON object." },
    ]);
  }

  const issues: ValidationIssue[] = [];
  rejectUnknownKeys(raw, GROUP_REORDER_KEYS, issues, {
    ownerUserId: OWNER_FIELD_MESSAGE,
  });

  const ids = readOrderedUuidList(
    raw.orderedGroupIds,
    "orderedGroupIds",
    LIVE_TRADE_GROUP_LIMIT,
    issues
  );

  if (issues.length > 0 || ids === undefined) return failure("body", issues);
  return { ok: true, value: { orderedGroupIds: ids } };
}
