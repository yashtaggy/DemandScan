/**
 * Live Trade service layer.
 *
 * Converts untrusted route input into validated domain values and delegates to
 * the owner-scoped repository. No SQL lives here.
 *
 * Ordering contract:
 *  1. Runtime owner check (the branded type is only a compile-time aid).
 *  2. Path identifier shape check — a malformed UUID is a client error
 *     (INVALID_QUERY), distinct from a missing or foreign record (NOT_FOUND).
 *  3. Payload parsing through the Phase 2 parsers.
 *  4. Repository call.
 *
 * Parser failures become `LiveTradeError` with the shared codes so routes can
 * map every failure through a single error handler.
 */

import type {
  LifecycleState,
  Pattern,
  Timeframe,
  ZoneSide,
} from "@/lib/scanner/types";
import type { KiteSession, QuoteData } from "@/lib/types";
import {
  LIVE_TRADE_INSTRUMENT_QUERY_MAX_LENGTH,
  LIVE_TRADE_ITEM_LIMIT,
  LIVE_TRADE_QUOTE_COOLDOWN_SECONDS,
  LIVE_TRADE_ZONE_BATCH_MAX,
  LIVE_TRADE_ZONE_FRESHNESS_DAYS,
  type LiveTradeQuoteErrorCode,
  type LiveTradeQuoteFreshness,
  type LiveTradeTimeframe,
  type LiveTradeZoneCoverage,
  type LiveTradeZoneTimeframeMatch,
} from "./constants";
import { LiveTradeError } from "./errors";
import {
  classifyQuoteFreshness,
  classifyQuoteProviderError,
  computeDistancePercent,
  computeQuoteChange,
  isApproxNseMarketOpen,
  isValidQuotePrice,
  kiteQuoteProvider,
  parseQuoteTimestamp,
  type QuoteProvider,
} from "./quotes";
import * as repository from "./repository";
import type {
  ExpandedZoneDto,
  InstrumentMasterInfoDto,
  InstrumentSearchResultDto,
  LiveTradeGroupDto,
  LiveTradeItemDto,
  NearestZoneDto,
  QuoteCooldownClaimDto,
  ZoneCoverageRowDto,
} from "./repository";
import type { LiveTradeOwnerId } from "./types";
import {
  classifyZoneCoverage,
  describeTimeframeMatch,
} from "./zone-selection";
import {
  isUuid,
  isValidOwnerId,
  parseCreateGroupInput,
  parseCreateItemInput,
  parseGroupReorderInput,
  parseReorderInput,
  parseUpdateGroupInput,
  parseUpdateItemInput,
  parseVersion,
  toLiveTradeError,
  type Parsed,
} from "./validation";

// ─── Guards ──────────────────────────────────────────────────────────────────

function assertOwner(ownerId: LiveTradeOwnerId): void {
  if (!isValidOwnerId(ownerId)) throw new LiveTradeError("UNAUTHENTICATED");
}

/**
 * A malformed id never reaches a lookup. Only an id of the expected shape is
 * looked up, and a missing or foreign record is always NOT_FOUND, so the
 * response cannot reveal whether someone else owns the record.
 */
function requirePathId(value: unknown): string {
  if (!isUuid(value)) {
    throw new LiveTradeError(
      "INVALID_QUERY",
      "Resource id must be a valid UUID."
    );
  }
  return value;
}

function unwrap<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw toLiveTradeError(parsed);
  return parsed.value;
}

/**
 * Query parameters arrive as strings. Only a plain decimal representation is
 * accepted; everything else is rejected by `parseVersion`.
 */
function normalizeQueryVersion(value: unknown): unknown {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return Number(value);
  }
  return value;
}

// ─── Groups ──────────────────────────────────────────────────────────────────

export async function listGroups(
  ownerId: LiveTradeOwnerId
): Promise<LiveTradeGroupDto[]> {
  assertOwner(ownerId);
  return repository.listGroups(ownerId);
}

export async function createGroup(
  ownerId: LiveTradeOwnerId,
  rawBody: unknown
): Promise<LiveTradeGroupDto> {
  assertOwner(ownerId);
  const input = unwrap(parseCreateGroupInput(rawBody));
  return repository.createGroup(ownerId, input.name);
}

export async function updateGroup(
  ownerId: LiveTradeOwnerId,
  groupId: unknown,
  rawBody: unknown
): Promise<LiveTradeGroupDto> {
  assertOwner(ownerId);
  const id = requirePathId(groupId);
  const input = unwrap(parseUpdateGroupInput(rawBody));
  return repository.updateGroup(ownerId, id, input.name, input.version);
}

export async function reorderGroups(
  ownerId: LiveTradeOwnerId,
  rawBody: unknown
): Promise<LiveTradeGroupDto[]> {
  assertOwner(ownerId);
  const input = unwrap(parseGroupReorderInput(rawBody));
  return repository.reorderGroups(ownerId, input.orderedGroupIds);
}

export async function deleteGroup(
  ownerId: LiveTradeOwnerId,
  groupId: unknown,
  versionParam: unknown
): Promise<void> {
  assertOwner(ownerId);
  const id = requirePathId(groupId);
  const version = unwrap(parseVersion(normalizeQueryVersion(versionParam), "query"));
  return repository.deleteGroup(ownerId, id, version);
}

// ─── Items ───────────────────────────────────────────────────────────────────

export async function listItems(
  ownerId: LiveTradeOwnerId
): Promise<LiveTradeItemDto[]> {
  assertOwner(ownerId);
  return repository.listItems(ownerId);
}

export async function createItem(
  ownerId: LiveTradeOwnerId,
  rawBody: unknown
): Promise<LiveTradeItemDto> {
  assertOwner(ownerId);
  const input = unwrap(parseCreateItemInput(rawBody));
  return repository.createItem(ownerId, input);
}

export async function updateItem(
  ownerId: LiveTradeOwnerId,
  itemId: unknown,
  rawBody: unknown
): Promise<LiveTradeItemDto> {
  assertOwner(ownerId);
  const id = requirePathId(itemId);
  const input = unwrap(parseUpdateItemInput(rawBody));
  return repository.updateItem(ownerId, id, input);
}

export async function deleteItem(
  ownerId: LiveTradeOwnerId,
  itemId: unknown,
  versionParam: unknown
): Promise<void> {
  assertOwner(ownerId);
  const id = requirePathId(itemId);
  const version = unwrap(parseVersion(normalizeQueryVersion(versionParam), "query"));
  return repository.deleteItem(ownerId, id, version);
}

export async function reorderItems(
  ownerId: LiveTradeOwnerId,
  rawBody: unknown
): Promise<LiveTradeItemDto[]> {
  assertOwner(ownerId);
  const input = unwrap(parseReorderInput(rawBody));
  return repository.reorderItems(ownerId, input.orderedItemIds);
}

// ─── Board, quotes and zones ─────────────────────────────────────────────────

export interface InstrumentMasterFreshnessDto {
  /**
   * Newest `updated_at` among Kite-sourced NSE rows. This is the latest
   * individual row update and is not evidence that a full sync completed.
   */
  latestInstrumentUpdateAt: string | null;
  activeInstrumentCount: number;
  /** Always `unknown`: no reliable completed-sync timestamp exists. */
  freshness: "unknown";
  /** `null` rather than `false`, because freshness cannot be determined. */
  stale: null;
}

/** A nearest-zone summary shared by the board, zones and quotes responses. */
export interface LiveTradeNearestZoneDto {
  zoneId: string;
  instrumentId: number;
  symbol: string;
  side: ZoneSide;
  timeframe: Timeframe;
  pattern: Pattern;
  zoneLow: number;
  zoneHigh: number;
  proximal: number;
  distal: number;
  /** `zones.score` — the Formation Score. Never `composite_score`. */
  formationScore: number;
  lifecycleState: LifecycleState;
  formationTs: string;
  createdAt: string;
  touchCount: number;
  lastTouchTs: string | null;
  /** PREFERRED, FALLBACK, or ANY when the item has no timeframe preference. */
  timeframeMatch: LiveTradeZoneTimeframeMatch;
  /**
   * Signed distance to the proximal boundary:
   * `((currentPrice - proximal) / proximal) * 100`.
   * Null without a valid quote (board/zones) and for BROKEN zones (quotes).
   */
  distancePercent: number | null;
  /** Boundary used for `distancePercent`; always the proximal level. */
  distanceBasis: "PROXIMAL";
}

export interface LiveTradeZoneFreshnessDto {
  freshnessThresholdDays: number;
  latestCoveringScanAt: string | null;
  latestZoneFormationAt: string | null;
  latestZoneCreatedAt: string | null;
  zoneCount: number;
  activeZoneCount: number;
}

export interface LiveTradeZoneSummaryDto {
  instrumentId: number;
  symbol: string;
  /** Effective preference (request override, else the item's saved value). */
  preferredTimeframe: LiveTradeTimeframe | null;
  coverage: LiveTradeZoneCoverage;
  zoneFreshness: LiveTradeZoneFreshnessDto;
  nearestDemand: LiveTradeNearestZoneDto | null;
  nearestSupply: LiveTradeNearestZoneDto | null;
}

export interface LiveTradeExpandedZoneDto extends ExpandedZoneDto {
  /** Expanded retrieval has no quote, so no distance is fabricated. */
  distancePercent: null;
  distanceBasis: "PROXIMAL";
}

export interface LiveTradeZonePaginationDto {
  limit: number;
  offset: number;
  page: number;
  returned: number;
  hasMore: boolean;
  /** Upper bound on zones one client interaction may page through. */
  batchLimit: number;
}

export interface LiveTradeZonesResponseDto {
  summaries: LiveTradeZoneSummaryDto[];
  expanded: {
    instrumentId: number;
    symbol: string;
    zones: LiveTradeExpandedZoneDto[];
    pagination: LiveTradeZonePaginationDto;
  } | null;
  timeframeContext: {
    hasOverride: boolean;
    /** Null means "all timeframes" when `hasOverride` is true. */
    value: LiveTradeTimeframe | null;
  };
  freshnessThresholdDays: number;
  generatedAt: string;
}

export interface LiveTradeBoardZonesDto {
  /** True only when this response actually included zone summaries. */
  available: boolean;
  status: "available" | "not_requested";
  freshnessThresholdDays: number;
  summaries: LiveTradeZoneSummaryDto[];
}

export interface LiveTradeBoardDto {
  groups: LiveTradeGroupDto[];
  items: LiveTradeItemDto[];
  instrumentMaster: InstrumentMasterFreshnessDto;
  zones: LiveTradeBoardZonesDto;
  generatedAt: string;
}

export interface InstrumentSearchResponseDto {
  query: string;
  instruments: InstrumentSearchResultDto[];
  instrumentMaster: InstrumentMasterFreshnessDto;
}

/**
 * The instrument master is updated row by row in independent chunks, so the
 * newest row timestamp cannot prove a full sync finished. Reporting a
 * derived fresh/stale verdict would overstate what the data supports, so the
 * timestamp is exposed for display and freshness is explicitly unknown.
 */
export function describeInstrumentMaster(
  info: InstrumentMasterInfoDto
): InstrumentMasterFreshnessDto {
  return {
    latestInstrumentUpdateAt: info.latestInstrumentUpdateAt,
    activeInstrumentCount: info.activeInstrumentCount,
    freshness: "unknown",
    stale: null,
  };
}

function toNearestSummary(
  zone: NearestZoneDto,
  currentPrice: number | null
): LiveTradeNearestZoneDto {
  return {
    zoneId: zone.zoneId,
    instrumentId: zone.instrumentId,
    symbol: zone.symbol,
    side: zone.side,
    timeframe: zone.timeframe,
    pattern: zone.pattern,
    zoneLow: zone.zoneLow,
    zoneHigh: zone.zoneHigh,
    proximal: zone.proximal,
    distal: zone.distal,
    formationScore: zone.formationScore,
    lifecycleState: zone.lifecycleState,
    formationTs: zone.formationTs,
    createdAt: zone.createdAt,
    touchCount: zone.touchCount,
    lastTouchTs: zone.lastTouchTs,
    timeframeMatch: describeTimeframeMatch(
      zone.preferredTimeframe,
      zone.timeframe
    ),
    distancePercent:
      zone.lifecycleState === "BROKEN"
        ? null
        : computeDistancePercent(currentPrice, zone.proximal),
    distanceBasis: "PROXIMAL",
  };
}

interface NearestPair {
  demand: NearestZoneDto | null;
  supply: NearestZoneDto | null;
}

function indexNearest(rows: NearestZoneDto[]): Map<number, NearestPair> {
  const byInstrument = new Map<number, NearestPair>();
  for (const row of rows) {
    const entry = byInstrument.get(row.instrumentId) ?? {
      demand: null,
      supply: null,
    };
    if (row.side === "DEMAND") entry.demand = row;
    else entry.supply = row;
    byInstrument.set(row.instrumentId, entry);
  }
  return byInstrument;
}

interface ZoneSummaryInput {
  now: Date;
  selection: Array<{ instrumentId: number; symbol: string }>;
  coverageRows: ZoneCoverageRowDto[];
  nearestRows: NearestZoneDto[];
  hasTimeframeOverride: boolean;
  timeframeOverride: LiveTradeTimeframe | null;
}

function buildZoneSummaries(input: ZoneSummaryInput): LiveTradeZoneSummaryDto[] {
  const coverageById = new Map(
    input.coverageRows.map((row) => [row.instrumentId, row])
  );
  const nearest = indexNearest(input.nearestRows);

  return input.selection.map(({ instrumentId, symbol }) => {
    const coverageRow = coverageById.get(instrumentId);
    const pair = nearest.get(instrumentId);
    const preferredTimeframe = input.hasTimeframeOverride
      ? input.timeframeOverride
      : coverageRow?.preferredTimeframe ?? null;

    const coverage = coverageRow
      ? classifyZoneCoverage({
          inUniverse: coverageRow.inUniverse,
          zoneCount: coverageRow.zoneCount,
          latestCoveringScanAt: coverageRow.latestCoveringScanAt
            ? new Date(coverageRow.latestCoveringScanAt)
            : null,
          hasAnySuccessScan: coverageRow.hasAnySuccessScan,
          hasUnattributableScan: coverageRow.hasUnattributableScan,
          now: input.now,
        })
      : "UNKNOWN";

    return {
      instrumentId,
      symbol,
      preferredTimeframe,
      coverage,
      zoneFreshness: {
        freshnessThresholdDays: LIVE_TRADE_ZONE_FRESHNESS_DAYS,
        latestCoveringScanAt: coverageRow?.latestCoveringScanAt ?? null,
        latestZoneFormationAt: coverageRow?.latestZoneFormationAt ?? null,
        latestZoneCreatedAt: coverageRow?.latestZoneCreatedAt ?? null,
        zoneCount: coverageRow?.zoneCount ?? 0,
        activeZoneCount: coverageRow?.activeZoneCount ?? 0,
      },
      nearestDemand: pair?.demand ? toNearestSummary(pair.demand, null) : null,
      nearestSupply: pair?.supply ? toNearestSummary(pair.supply, null) : null,
    };
  });
}

export interface BoardOptions {
  /**
   * `false` returns groups, items and instrument-master freshness without
   * structural-zone summaries, and reports `zones.status: "not_requested"`
   * with `zones.available: false`. Clients that load zone evidence as a
   * separate request use this to keep the board shell fast.
   */
  includeZones?: boolean;
}

/**
 * Board workspace. By default zone summaries are two bounded batched reads
 * (nearest and coverage) after the three workspace reads; there is no per-item
 * query and no Kite call. The board therefore renders identically while the
 * market data provider is unavailable.
 *
 * `includeZones: false` skips both zone reads and reports
 * `status: "not_requested"` with `available: false`, so a caller that omitted
 * the summaries cannot mistake the empty array for confirmed coverage.
 */
export async function getBoard(
  ownerId: LiveTradeOwnerId,
  options: BoardOptions = {}
): Promise<LiveTradeBoardDto> {
  assertOwner(ownerId);
  const includeZones = options.includeZones !== false;
  const now = new Date();
  const [groups, items, master] = await Promise.all([
    repository.listGroups(ownerId),
    repository.listItems(ownerId),
    repository.getInstrumentMasterInfo(),
  ]);

  let summaries: LiveTradeZoneSummaryDto[] = [];
  if (includeZones && items.length > 0) {
    const selection = dedupeByInstrument(
      items.map((item) => ({
        instrumentId: item.instrumentId,
        symbol: item.symbol,
      }))
    );
    const instrumentIds = selection.map((row) => row.instrumentId);
    const [nearestRows, coverageRows] = await Promise.all([
      repository.getNearestZones(ownerId, instrumentIds, null, false),
      repository.getZoneCoverage(ownerId, instrumentIds),
    ]);
    summaries = buildZoneSummaries({
      now,
      selection,
      coverageRows,
      nearestRows,
      hasTimeframeOverride: false,
      timeframeOverride: null,
    });
  }

  return {
    groups,
    items,
    instrumentMaster: describeInstrumentMaster(master),
    zones: {
      available: includeZones,
      status: includeZones ? "available" : "not_requested",
      freshnessThresholdDays: LIVE_TRADE_ZONE_FRESHNESS_DAYS,
      summaries,
    },
    generatedAt: now.toISOString(),
  };
}

// ─── Market snapshot: quotes ─────────────────────────────────────────────────

export interface LiveTradeQuoteDto {
  instrumentId: number;
  symbol: string;
  lastPrice: number | null;
  change: number | null;
  changePercent: number | null;
  lastTradedAt: string | null;
  /** Server time when the provider response was received. */
  fetchedAt: string;
  /**
   * LIVE / DELAYED / LAST_CLOSE / UNAVAILABLE are produced by this endpoint.
   * SIGN_IN_REQUIRED is the client's label for a retained quote after a 401;
   * STALE is the client's label for a retained quote after a failed refresh.
   */
  freshness: LiveTradeQuoteFreshness;
  errorCode: LiveTradeQuoteErrorCode | null;
  nearestDemand: LiveTradeNearestZoneDto | null;
  nearestSupply: LiveTradeNearestZoneDto | null;
}

export interface LiveTradeQuotesResponseDto {
  quotes: LiveTradeQuoteDto[];
  /**
   * False when the batched nearest-zone read failed. Quote prices are still
   * valid; every `nearestDemand`/`nearestSupply` is then null. A provider
   * failure is never reported this way — it remains an API error.
   */
  zonesAvailable: boolean;
  market: {
    isOpen: boolean;
    exchange: "NSE";
    approximation: string;
  };
  cooldownSeconds: number;
  requestedInstruments: number;
  /** Server time when the provider response was received. */
  fetchedAt: string;
}

const MARKET_APPROXIMATION =
  "NSE regular session Monday-Friday 09:15-15:30 IST; exchange holidays and special sessions are not modelled.";

function validateRequestedInstrumentIds(
  value: number[] | undefined
): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new LiveTradeError("INVALID_QUERY", "instrumentIds must be an array.");
  }
  if (value.length > LIVE_TRADE_ITEM_LIMIT) {
    throw new LiveTradeError(
      "INVALID_QUERY",
      `instrumentIds must contain at most ${LIVE_TRADE_ITEM_LIMIT} instruments.`
    );
  }
  const seen = new Set<number>();
  for (const id of value) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new LiveTradeError(
        "INVALID_QUERY",
        "instrumentIds must contain positive integers."
      );
    }
    if (seen.has(id)) {
      throw new LiveTradeError(
        "INVALID_QUERY",
        "instrumentIds must not contain duplicates."
      );
    }
    seen.add(id);
  }
  return value;
}

/** Filters the owner's selection to the requested ids, in request order. */
function selectRequestedInstruments(
  selection: Array<{ instrumentId: number; symbol: string }>,
  requested: number[] | undefined
): Array<{ instrumentId: number; symbol: string }> {
  if (requested === undefined) return selection;

  const owned = new Set(selection.map((row) => row.instrumentId));
  if (requested.some((id) => !owned.has(id))) {
    // Valid but foreign or absent ids are indistinguishable from missing ones.
    throw new LiveTradeError("NOT_FOUND");
  }

  const order = new Map(requested.map((id, index) => [id, index]));
  return selection
    .filter((row) => order.has(row.instrumentId))
    .sort(
      (a, b) =>
        (order.get(a.instrumentId) as number) -
        (order.get(b.instrumentId) as number)
    );
}

/**
 * Collapses repeated trade entries for one instrument into a single row.
 * Quote and zone reads are per instrument, so every entry on the same symbol
 * shares one quote and one zone summary instead of issuing duplicate work.
 */
function dedupeByInstrument<T extends { instrumentId: number }>(
  rows: T[]
): T[] {
  const seen = new Set<number>();
  const unique: T[] = [];
  for (const row of rows) {
    if (seen.has(row.instrumentId)) continue;
    seen.add(row.instrumentId);
    unique.push(row);
  }
  return unique;
}

export async function getLiveQuotes(
  ownerId: LiveTradeOwnerId,
  session: KiteSession,
  requestedInstrumentIds?: number[]
): Promise<LiveTradeQuotesResponseDto> {
  return getLiveQuotesAt(
    new Date(),
    ownerId,
    session,
    requestedInstrumentIds,
    kiteQuoteProvider,
    () => new Date()
  );
}

type QuoteEvaluation =
  | { status: "VALID"; quote: QuoteData; quoteTimestamp: Date }
  | { status: "UNAVAILABLE"; errorCode: LiveTradeQuoteErrorCode };

function safeErrorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "unknown";
}

/**
 * Quote orchestration with an explicit clock for deterministic tests.
 *
 * Order matters: selection → cooldown claim → provider request → validation →
 * one batched zone read. An empty selection returns before the claim and
 * before Kite, so it costs nothing and cannot burn the owner's cooldown. A
 * rejected claim never reaches the provider.
 *
 * `now` is the request-start instant. `clock` supplies the response instant,
 * so `fetchedAt`, market-session state and freshness all describe the moment
 * the provider response was received rather than when the request began.
 */
export async function getLiveQuotesAt(
  now: Date,
  ownerId: LiveTradeOwnerId,
  session: KiteSession,
  requestedInstrumentIds?: number[],
  provider: QuoteProvider = kiteQuoteProvider,
  clock: () => Date = () => now
): Promise<LiveTradeQuotesResponseDto> {
  assertOwner(ownerId);

  const accessToken =
    typeof session?.accessToken === "string" ? session.accessToken.trim() : "";
  if (accessToken === "") throw new LiveTradeError("TOKEN_EXPIRED");

  const requested = validateRequestedInstrumentIds(requestedInstrumentIds);
  const selection = dedupeByInstrument(
    selectRequestedInstruments(
      await repository.listOwnerQuoteInstruments(ownerId),
      requested
    )
  );

  if (selection.length === 0) {
    const responseAt = clock();
    return {
      quotes: [],
      zonesAvailable: true,
      market: {
        isOpen: isApproxNseMarketOpen(responseAt),
        exchange: "NSE",
        approximation: MARKET_APPROXIMATION,
      },
      cooldownSeconds: LIVE_TRADE_QUOTE_COOLDOWN_SECONDS,
      requestedInstruments: 0,
      fetchedAt: responseAt.toISOString(),
    };
  }

  const claim: QuoteCooldownClaimDto = await repository.claimQuoteCooldown(
    ownerId
  );
  if (!claim.allowed) {
    throw new LiveTradeError("QUOTE_COOLDOWN", undefined, {
      retryAfterSeconds: claim.retryAfterSeconds,
    });
  }

  let quoteMap: Map<string, QuoteData>;
  try {
    quoteMap = await provider.fetchQuotes(
      accessToken,
      selection.map((row) => `NSE:${row.symbol}`)
    );
  } catch (error) {
    throw classifyQuoteProviderError(error);
  }

  const responseAt = clock();
  const marketOpen = isApproxNseMarketOpen(responseAt);
  const fetchedAt = responseAt.toISOString();
  const market = {
    isOpen: marketOpen,
    exchange: "NSE" as const,
    approximation: MARKET_APPROXIMATION,
  };

  const evaluations = new Map<number, QuoteEvaluation>();
  const currentPrices = new Map<number, number>();

  for (const { instrumentId, symbol } of selection) {
    const quote = quoteMap.get(`NSE:${symbol}`);
    if (!quote) {
      evaluations.set(instrumentId, {
        status: "UNAVAILABLE",
        errorCode: "QUOTE_NOT_RETURNED",
      });
      continue;
    }
    if (!isValidQuotePrice(quote.lastPrice)) {
      evaluations.set(instrumentId, {
        status: "UNAVAILABLE",
        errorCode: "QUOTE_INVALID",
      });
      continue;
    }

    const quoteTimestamp = parseQuoteTimestamp(quote.timestamp, responseAt);
    if (!quoteTimestamp) {
      evaluations.set(instrumentId, {
        status: "UNAVAILABLE",
        errorCode: "QUOTE_TIMESTAMP_INVALID",
      });
      continue;
    }

    evaluations.set(instrumentId, {
      status: "VALID",
      quote,
      quoteTimestamp,
    });
    currentPrices.set(instrumentId, quote.lastPrice);
  }

  let nearestRows: NearestZoneDto[] = [];
  let zonesAvailable = true;
  try {
    nearestRows = await repository.getNearestZones(
      ownerId,
      selection.map((row) => row.instrumentId),
      null,
      false,
      currentPrices
    );
  } catch (error) {
    // Zone enrichment is independent of quote validity: keep the valid quotes
    // and report the missing zone summaries explicitly.
    zonesAvailable = false;
    console.error("[live-trade] zone enrichment failed", {
      name: safeErrorName(error),
    });
  }
  const nearest = indexNearest(nearestRows);

  const quotes = selection.map(({ instrumentId, symbol }): LiveTradeQuoteDto => {
    const pair = nearest.get(instrumentId);
    const evaluation = evaluations.get(instrumentId);
    const price =
      evaluation?.status === "VALID" ? evaluation.quote.lastPrice : null;
    const nearestDemand =
      zonesAvailable && pair?.demand
        ? toNearestSummary(pair.demand, price)
        : null;
    const nearestSupply =
      zonesAvailable && pair?.supply
        ? toNearestSummary(pair.supply, price)
        : null;

    if (!evaluation || evaluation.status === "UNAVAILABLE") {
      return {
        instrumentId,
        symbol,
        lastPrice: null,
        change: null,
        changePercent: null,
        lastTradedAt: null,
        fetchedAt,
        freshness: "UNAVAILABLE",
        errorCode: evaluation?.errorCode ?? "QUOTE_NOT_RETURNED",
        nearestDemand,
        nearestSupply,
      };
    }

    const { quote, quoteTimestamp } = evaluation;
    const { change, changePercent } = computeQuoteChange(
      quote.lastPrice,
      quote.ohlc?.close
    );

    return {
      instrumentId,
      symbol,
      lastPrice: quote.lastPrice,
      change,
      changePercent,
      lastTradedAt:
        parseQuoteTimestamp(quote.lastTradeTime, responseAt)?.toISOString() ??
        null,
      fetchedAt,
      freshness: classifyQuoteFreshness({
        quoteTimestamp,
        now: responseAt,
        marketOpen,
      }),
      errorCode: null,
      nearestDemand,
      nearestSupply,
    };
  });

  return {
    quotes,
    zonesAvailable,
    market,
    cooldownSeconds: LIVE_TRADE_QUOTE_COOLDOWN_SECONDS,
    requestedInstruments: selection.length,
    fetchedAt,
  };
}

// ─── Demand/supply zones ─────────────────────────────────────────────────────

export interface LiveTradeZoneQueryOptions {
  instrumentIds?: number[];
  hasTimeframeOverride: boolean;
  timeframeOverride: LiveTradeTimeframe | null;
  includeExpanded: boolean;
  /** Defaults to true; false skips nearest and coverage reads. */
  includeSummaries?: boolean;
  limit: number;
  offset: number;
}

export async function getZoneOverviews(
  ownerId: LiveTradeOwnerId,
  options: LiveTradeZoneQueryOptions
): Promise<LiveTradeZonesResponseDto> {
  return getZoneOverviewsAt(new Date(), ownerId, options);
}

/**
 * Batched zone overviews for the owner's selected instruments plus an optional
 * paginated expanded list for exactly one of them.
 *
 * Ownership is enforced by the repository statements; requested ids that are
 * not on the owner's board return NOT_FOUND before any zone query runs.
 */
export async function getZoneOverviewsAt(
  now: Date,
  ownerId: LiveTradeOwnerId,
  options: LiveTradeZoneQueryOptions
): Promise<LiveTradeZonesResponseDto> {
  assertOwner(ownerId);

  const requested = validateRequestedInstrumentIds(options.instrumentIds);
  const selection = dedupeByInstrument(
    selectRequestedInstruments(
      await repository.listOwnerQuoteInstruments(ownerId),
      requested
    )
  );

  const timeframeContext = {
    hasOverride: options.hasTimeframeOverride,
    value: options.hasTimeframeOverride ? options.timeframeOverride : null,
  };

  // Validated before the empty-selection return so an empty board with
  // includeExpanded=true still receives the documented 400, not a 200.
  if (options.includeExpanded && selection.length !== 1) {
    throw new LiveTradeError(
      "INVALID_QUERY",
      "includeExpanded requires exactly one instrument."
    );
  }

  if (selection.length === 0) {
    return {
      summaries: [],
      expanded: null,
      timeframeContext,
      freshnessThresholdDays: LIVE_TRADE_ZONE_FRESHNESS_DAYS,
      generatedAt: now.toISOString(),
    };
  }

  let summaries: LiveTradeZoneSummaryDto[] = [];
  if (options.includeSummaries !== false) {
    const instrumentIds = selection.map((row) => row.instrumentId);
    const [nearestRows, coverageRows] = await Promise.all([
      repository.getNearestZones(
        ownerId,
        instrumentIds,
        options.timeframeOverride,
        options.hasTimeframeOverride
      ),
      repository.getZoneCoverage(ownerId, instrumentIds),
    ]);

    summaries = buildZoneSummaries({
      now,
      selection,
      coverageRows,
      nearestRows,
      hasTimeframeOverride: options.hasTimeframeOverride,
      timeframeOverride: options.timeframeOverride,
    });
  }

  let expanded: LiveTradeZonesResponseDto["expanded"] = null;
  if (options.includeExpanded) {
    const target = selection[0];
    const rows = await repository.listExpandedZones(
      ownerId,
      target.instrumentId,
      options.limit + 1,
      options.offset
    );
    const hasMore = rows.length > options.limit;
    const pageRows = rows.slice(0, options.limit);

    const seen = new Set<string>();
    const zones: LiveTradeExpandedZoneDto[] = [];
    for (const row of pageRows) {
      if (seen.has(row.zoneId)) continue;
      seen.add(row.zoneId);
      zones.push({ ...row, distancePercent: null, distanceBasis: "PROXIMAL" });
    }

    expanded = {
      instrumentId: target.instrumentId,
      symbol: target.symbol,
      zones,
      pagination: {
        limit: options.limit,
        offset: options.offset,
        page: Math.floor(options.offset / options.limit) + 1,
        returned: zones.length,
        hasMore,
        batchLimit: LIVE_TRADE_ZONE_BATCH_MAX,
      },
    };
  }

  return {
    summaries,
    expanded,
    timeframeContext,
    freshnessThresholdDays: LIVE_TRADE_ZONE_FRESHNESS_DAYS,
    generatedAt: now.toISOString(),
  };
}

// ─── Instrument search ───────────────────────────────────────────────────────

function normalizeInstrumentQuery(value: unknown): string {
  if (typeof value !== "string") {
    throw new LiveTradeError("INVALID_QUERY", "q is required.");
  }
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  if (length === 0) {
    throw new LiveTradeError(
      "INVALID_QUERY",
      "q must contain at least one non-whitespace character."
    );
  }
  if (length > LIVE_TRADE_INSTRUMENT_QUERY_MAX_LENGTH) {
    throw new LiveTradeError(
      "INVALID_QUERY",
      `q must be at most ${LIVE_TRADE_INSTRUMENT_QUERY_MAX_LENGTH} characters.`
    );
  }
  return trimmed;
}

export async function searchInstruments(
  ownerId: LiveTradeOwnerId,
  rawQuery: unknown
): Promise<InstrumentSearchResponseDto> {
  assertOwner(ownerId);
  const query = normalizeInstrumentQuery(rawQuery);

  const [instruments, master] = await Promise.all([
    repository.searchNseInstruments(query),
    repository.getInstrumentMasterInfo(),
  ]);

  return {
    query,
    instruments,
    instrumentMaster: describeInstrumentMaster(master),
  };
}
