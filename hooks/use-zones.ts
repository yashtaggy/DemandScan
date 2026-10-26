"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Zone, Timeframe, ZoneSide, Pattern } from "@/lib/scanner/types";
import {
  DEFAULT_MIN_FORMATION_SCORE,
  DEFAULT_ZONE_DIR,
  DEFAULT_ZONE_SORT,
} from "@/lib/scanner/filter-defaults";

export interface ZoneFilters {
  // Primary filters
  timeframe?: Timeframe;
  side?: ZoneSide;
  lifecycle?: string;
  symbol?: string;
  pattern?: Pattern;
  // Score filters
  minScore?: number;
  minCompositeScore?: number;
  // Distance / confluence
  maxDistancePct?: number;
  minConfluence?: number;
  maxOppositionRisk?: number;
  // Date range
  formationFrom?: string;
  formationTo?: string;
  // Sort
  sort?: "score" | "composite_score" | "formation_ts" | "distance_pct";
  dir?: "asc" | "desc";
  // Pagination
  limit?: number;
  offset?: number;
}

/** Initial filter state and the target state for Reset Filters. */
export const DEFAULT_SCANNER_FILTERS: ZoneFilters = {
  minScore: DEFAULT_MIN_FORMATION_SCORE,
  sort: DEFAULT_ZONE_SORT,
  dir: DEFAULT_ZONE_DIR,
};

export interface UseZonesReturn {
  zones: Zone[];
  count: number;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Text filters are debounced so typing a symbol does not fire a request per key. */
const FILTER_DEBOUNCE_MS = 250;

function buildQueryString(filters: ZoneFilters): string {
  const params = new URLSearchParams();
  if (filters.timeframe)         params.set("timeframe",         filters.timeframe);
  if (filters.side)              params.set("side",              filters.side);
  if (filters.lifecycle)         params.set("lifecycle",         filters.lifecycle);
  if (filters.symbol)            params.set("symbol",            filters.symbol.trim().toUpperCase());
  if (filters.pattern)           params.set("pattern",           filters.pattern);
  if (filters.minScore !== undefined)          params.set("minScore",          String(filters.minScore));
  if (filters.minCompositeScore !== undefined) params.set("minCompositeScore", String(filters.minCompositeScore));
  if (filters.maxDistancePct !== undefined)    params.set("maxDistancePct",    String(filters.maxDistancePct));
  if (filters.minConfluence !== undefined)     params.set("minConfluence",     String(filters.minConfluence));
  if (filters.maxOppositionRisk !== undefined) params.set("maxOppositionRisk", String(filters.maxOppositionRisk));
  if (filters.formationFrom)     params.set("formationFrom",     filters.formationFrom);
  if (filters.formationTo)       params.set("formationTo",       filters.formationTo);
  if (filters.sort)              params.set("sort",              filters.sort);
  if (filters.dir)               params.set("dir",               filters.dir);
  if (filters.limit !== undefined)  params.set("limit",  String(filters.limit));
  if (filters.offset !== undefined) params.set("offset", String(filters.offset));
  return params.toString();
}

export function useZones(filters: ZoneFilters = {}): UseZonesReturn {
  const [zones, setZones] = useState<Zone[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Monotonic id so a slow response from an older filter set can never
  // overwrite the results of a newer request (e.g. immediately after Reset).
  const requestIdRef = useRef(0);

  // Memoized so the effect key is stable regardless of object identity.
  const queryString = useMemo(() => buildQueryString(filters), [filters]);
  const latestQuery = useRef(queryString);
  latestQuery.current = queryString;

  const fetchZones = useCallback(async (qs: string) => {
    const requestId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/scanner/zones?${qs}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (requestId !== requestIdRef.current) return;
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`
        );
      }
      setZones(data.zones ?? []);
      setCount(data.count ?? 0);
    } catch (err: any) {
      if (requestId !== requestIdRef.current) return;
      if (err?.name !== "AbortError") {
        setError(err?.message ?? "Failed to load zones");
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Invalidate in-flight work as soon as the filters change, not after the
    // debounce fires, so Reset cannot be overwritten by a stale response.
    requestIdRef.current++;
    abortRef.current?.abort();

    const timer = setTimeout(() => {
      void fetchZones(queryString);
    }, FILTER_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [queryString, fetchZones]);

  const refetch = useCallback(() => {
    void fetchZones(latestQuery.current);
  }, [fetchZones]);

  return { zones, count, loading, error, refetch };
}
