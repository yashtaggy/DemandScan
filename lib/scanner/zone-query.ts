/**
 * lib/scanner/zone-query.ts
 *
 * Strict parsing/validation for GET /api/scanner/zones.
 *
 * All user input is validated against closed sets and numeric bounds before it
 * reaches SQL. Values are always bound as parameters; sort/dir are mapped to a
 * hard-coded whitelist. Invalid input returns a 400 instead of silently
 * producing NaN limits (the previous code forwarded Number('abc') as NaN).
 */

import type { LifecycleState, Pattern, Timeframe, ZoneSide } from './types';

export const ZONE_TIMEFRAMES: readonly Timeframe[] = [
  '1H',
  '4H',
  '1D',
  '1W',
  '1M',
  '3M',
  '6M',
  '1Y',
];

export const ZONE_SIDES: readonly ZoneSide[] = ['DEMAND', 'SUPPLY'];
export const ZONE_PATTERNS: readonly Pattern[] = ['DBR', 'RBR', 'RBD', 'DBD'];
export const ZONE_LIFECYCLES: readonly LifecycleState[] = [
  'CONFIRMED_FRESH',
  'TOUCHED_ONCE',
  'RETESTED',
  'BROKEN',
];

export const ZONE_SORT_COLUMNS = {
  score: 'z.score',
  composite_score: 'z.composite_score',
  formation_ts: 'z.formation_ts',
  distance_pct: 'z.distance_pct',
} as const;

export type ZoneSortKey = keyof typeof ZONE_SORT_COLUMNS;

export const DEFAULT_ZONE_LIMIT = 100;
export const MAX_ZONE_LIMIT = 500;

export interface ZoneQuery {
  instrumentId: number | null;
  symbol: string | null;
  timeframe: Timeframe | null;
  side: ZoneSide | null;
  pattern: Pattern | null;
  lifecycle: LifecycleState | null;
  minScore: number | null;
  minCompositeScore: number | null;
  maxDistancePct: number | null;
  minConfluence: number | null;
  maxOppositionRisk: number | null;
  formationFrom: string | null;
  formationTo: string | null;
  limit: number;
  offset: number;
  sort: ZoneSortKey;
  dir: 'ASC' | 'DESC';
  sortColumn: string;
}

export type ZoneQueryResult =
  | { ok: true; query: ZoneQuery }
  | { ok: false; error: string };

export interface ZoneWhere {
  /** Either an empty string or "WHERE ... AND ..." with $n placeholders. */
  clause: string;
  params: unknown[];
}

const SYMBOL_PATTERN = /^[A-Z0-9&.\-]{1,32}$/;

function invalid(message: string): ZoneQueryResult {
  return { ok: false, error: message };
}

function parseIntParam(
  raw: string | null,
  name: string,
  min: number,
  max: number
): { value: number | null } | { error: string } {
  if (raw == null || raw.trim() === '') return { value: null };
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return { error: `${name} must be an integer` };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { error: `${name} must be between ${min} and ${max}` };
  }
  return { value };
}

function parseNumberParam(
  raw: string | null,
  name: string,
  min: number,
  max: number
): { value: number | null } | { error: string } {
  if (raw == null || raw.trim() === '') return { value: null };
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    return { error: `${name} must be a number between ${min} and ${max}` };
  }
  return { value };
}

function parseEnum<T extends string>(
  raw: string | null,
  name: string,
  allowed: readonly T[]
): { value: T | null } | { error: string } {
  if (raw == null || raw.trim() === '') return { value: null };
  const value = raw.trim() as T;
  if (!allowed.includes(value)) {
    return { error: `${name} must be one of: ${allowed.join(', ')}` };
  }
  return { value };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Parse and validate zone-list query parameters. Returns a 400-worthy error
 * message for any malformed value.
 */
export function parseZoneQuery(searchParams: URLSearchParams): ZoneQueryResult {
  const instrumentId = parseIntParam(searchParams.get('instrumentId'), 'instrumentId', 1, Number.MAX_SAFE_INTEGER);
  if ('error' in instrumentId) return invalid(instrumentId.error);

  const rawSymbol = searchParams.get('symbol');
  let symbol: string | null = null;
  if (rawSymbol != null && rawSymbol.trim() !== '') {
    symbol = rawSymbol.trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(symbol)) {
      return invalid('symbol must contain only letters, digits, &, . or - (max 32)');
    }
  }

  const timeframe = parseEnum(searchParams.get('timeframe'), 'timeframe', ZONE_TIMEFRAMES);
  if ('error' in timeframe) return invalid(timeframe.error);

  const side = parseEnum(searchParams.get('side'), 'side', ZONE_SIDES);
  if ('error' in side) return invalid(side.error);

  const pattern = parseEnum(searchParams.get('pattern'), 'pattern', ZONE_PATTERNS);
  if ('error' in pattern) return invalid(pattern.error);

  const lifecycle = parseEnum(searchParams.get('lifecycle'), 'lifecycle', ZONE_LIFECYCLES);
  if ('error' in lifecycle) return invalid(lifecycle.error);

  const minScore = parseIntParam(searchParams.get('minScore'), 'minScore', 0, 100);
  if ('error' in minScore) return invalid(minScore.error);

  const minCompositeScore = parseIntParam(
    searchParams.get('minCompositeScore'),
    'minCompositeScore',
    0,
    100
  );
  if ('error' in minCompositeScore) return invalid(minCompositeScore.error);

  const minConfluence = parseIntParam(searchParams.get('minConfluence'), 'minConfluence', 0, 100);
  if ('error' in minConfluence) return invalid(minConfluence.error);

  const maxOppositionRisk = parseIntParam(
    searchParams.get('maxOppositionRisk'),
    'maxOppositionRisk',
    0,
    100
  );
  if ('error' in maxOppositionRisk) return invalid(maxOppositionRisk.error);

  const maxDistancePct = parseNumberParam(
    searchParams.get('maxDistancePct'),
    'maxDistancePct',
    0,
    100
  );
  if ('error' in maxDistancePct) return invalid(maxDistancePct.error);

  const rawFrom = searchParams.get('formationFrom');
  const rawTo = searchParams.get('formationTo');
  const formationFrom = rawFrom && rawFrom.trim() !== '' ? rawFrom.trim() : null;
  const formationTo = rawTo && rawTo.trim() !== '' ? rawTo.trim() : null;
  if (formationFrom && !isIsoDate(formationFrom)) {
    return invalid('formationFrom must be a valid YYYY-MM-DD date');
  }
  if (formationTo && !isIsoDate(formationTo)) {
    return invalid('formationTo must be a valid YYYY-MM-DD date');
  }
  if (formationFrom && formationTo && formationFrom > formationTo) {
    return invalid('formationFrom must be before or equal to formationTo');
  }

  const rawLimit = searchParams.get('limit');
  let limit = DEFAULT_ZONE_LIMIT;
  if (rawLimit != null && rawLimit.trim() !== '') {
    const parsed = parseIntParam(rawLimit, 'limit', 1, MAX_ZONE_LIMIT);
    if ('error' in parsed) return invalid(parsed.error);
    limit = parsed.value as number;
  }

  const rawOffset = searchParams.get('offset');
  let offset = 0;
  if (rawOffset != null && rawOffset.trim() !== '') {
    const parsed = parseIntParam(rawOffset, 'offset', 0, 1_000_000);
    if ('error' in parsed) return invalid(parsed.error);
    offset = parsed.value as number;
  }

  const rawSort = searchParams.get('sort');
  let sort: ZoneSortKey = 'composite_score';
  if (rawSort != null && rawSort.trim() !== '') {
    const key = rawSort.trim();
    if (!(key in ZONE_SORT_COLUMNS)) {
      return invalid(
        `sort must be one of: ${Object.keys(ZONE_SORT_COLUMNS).join(', ')}`
      );
    }
    sort = key as ZoneSortKey;
  }

  const rawDir = searchParams.get('dir');
  let dir: 'ASC' | 'DESC' = 'DESC';
  if (rawDir != null && rawDir.trim() !== '') {
    const value = rawDir.trim().toLowerCase();
    if (value !== 'asc' && value !== 'desc') {
      return invalid('dir must be one of: asc, desc');
    }
    dir = value === 'asc' ? 'ASC' : 'DESC';
  }

  return {
    ok: true,
    query: {
      instrumentId: instrumentId.value,
      symbol,
      timeframe: timeframe.value,
      side: side.value,
      pattern: pattern.value,
      lifecycle: lifecycle.value,
      minScore: minScore.value,
      minCompositeScore: minCompositeScore.value,
      maxDistancePct: maxDistancePct.value,
      minConfluence: minConfluence.value,
      maxOppositionRisk: maxOppositionRisk.value,
      formationFrom,
      formationTo,
      limit,
      offset,
      sort,
      dir,
      sortColumn: ZONE_SORT_COLUMNS[sort],
    },
  };
}

/**
 * Build the WHERE clause for a validated zone query.
 *
 * Only filters actually present are emitted, so Postgres can use the existing
 * indexes (e.g. idx_zones_instrument_timeframe) instead of evaluating
 * `($n IS NULL OR column = $n)` for every row. All values are bound in order;
 * the string only ever contains code-owned SQL fragments.
 */
export function buildZoneWhere(q: ZoneQuery): ZoneWhere {
  const conditions: string[] = [];
  const params: unknown[] = [];

  function bind(build: (placeholder: string) => string, value: unknown) {
    params.push(value);
    conditions.push(build(`$${params.length}`));
  }

  if (q.instrumentId !== null) {
    bind((p) => `z.instrument_id = ${p}`, q.instrumentId);
  }
  if (q.symbol !== null) {
    bind((p) => `UPPER(i.symbol) = ${p}`, q.symbol);
  }
  if (q.timeframe !== null) {
    bind((p) => `z.timeframe = ${p}`, q.timeframe);
  }
  if (q.side !== null) {
    bind((p) => `z.side = ${p}`, q.side);
  }
  if (q.pattern !== null) {
    bind((p) => `z.pattern = ${p}`, q.pattern);
  }
  if (q.lifecycle !== null) {
    bind((p) => `z.lifecycle_state = ${p}`, q.lifecycle);
  }
  if (q.minScore !== null) {
    bind((p) => `z.score >= ${p}`, q.minScore);
  }
  if (q.minCompositeScore !== null) {
    bind((p) => `z.composite_score >= ${p}`, q.minCompositeScore);
  }
  if (q.maxDistancePct !== null) {
    bind((p) => `z.distance_pct <= ${p}`, q.maxDistancePct);
  }
  if (q.minConfluence !== null) {
    bind((p) => `z.confluence_score >= ${p}`, q.minConfluence);
  }
  if (q.maxOppositionRisk !== null) {
    bind((p) => `z.opposition_risk <= ${p}`, q.maxOppositionRisk);
  }
  if (q.formationFrom !== null) {
    bind((p) => `z.formation_ts::date >= ${p}::date`, q.formationFrom);
  }
  if (q.formationTo !== null) {
    bind((p) => `z.formation_ts::date <= ${p}::date`, q.formationTo);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

