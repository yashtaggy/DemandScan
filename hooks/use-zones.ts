"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Zone, Timeframe, ZoneSide } from "@/lib/scanner/types";

export interface ZoneFilters {
  // Primary filters
  timeframe?: Timeframe;
  side?: ZoneSide;
  lifecycle?: string;
  symbol?: string;
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

export interface UseZonesReturn {
  zones: Zone[];
  count: number;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useZones(filters: ZoneFilters = {}): UseZonesReturn {
  const [zones, setZones] = useState<Zone[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchZones = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (filters.timeframe)         params.set("timeframe",         filters.timeframe);
    if (filters.side)              params.set("side",              filters.side);
    if (filters.lifecycle)         params.set("lifecycle",         filters.lifecycle);
    if (filters.symbol)            params.set("symbol",            filters.symbol);
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

    try {
      const res = await fetch(`/api/scanner/zones?${params.toString()}`, {
        signal: abortRef.current.signal,
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setZones(data.zones ?? []);
      setCount(data.count ?? 0);
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setError(err?.message ?? "Failed to load zones");
      }
    } finally {
      setLoading(false);
    }
  }, [
    filters.timeframe, filters.side, filters.lifecycle, filters.symbol,
    filters.minScore, filters.minCompositeScore,
    filters.maxDistancePct, filters.minConfluence, filters.maxOppositionRisk,
    filters.formationFrom, filters.formationTo,
    filters.sort, filters.dir,
    filters.limit, filters.offset,
  ]);

  useEffect(() => {
    fetchZones();
    return () => abortRef.current?.abort();
  }, [fetchZones]);

  return { zones, count, loading, error, refetch: fetchZones };
}
