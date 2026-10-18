"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Zone, Timeframe, ZoneSide } from "@/lib/scanner/types";

export interface ZoneFilters {
  timeframe?: Timeframe;
  side?: ZoneSide;
  lifecycle?: string;
  minScore?: number;
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
    // Cancel any in-flight request.
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (filters.timeframe) params.set("timeframe", filters.timeframe);
    if (filters.side) params.set("side", filters.side);
    if (filters.lifecycle) params.set("lifecycle", filters.lifecycle);
    if (filters.minScore !== undefined) params.set("minScore", String(filters.minScore));
    if (filters.limit !== undefined) params.set("limit", String(filters.limit));
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
    filters.timeframe,
    filters.side,
    filters.lifecycle,
    filters.minScore,
    filters.limit,
    filters.offset,
  ]);

  useEffect(() => {
    fetchZones();
    return () => abortRef.current?.abort();
  }, [fetchZones]);

  return { zones, count, loading, error, refetch: fetchZones };
}
