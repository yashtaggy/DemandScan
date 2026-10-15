"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { StockRow } from "@/lib/types";

interface StockMeta {
  total: number;
  totalPages: number;
  page: number;
  pageSize: number;
  instrumentsLoaded: number;
  symbolsMatched: number;
  symbolsWithQuotes: number;
  nifty500LastUpdated: string;
  fetchedAt: string;
}

interface UseStocksOptions {
  search?: string;
  sort?: string;
  order?: string;
  filter?: string;
  minChange?: number;
  page?: number;
  pageSize?: number;
  refreshInterval?: number; // ms, 0 = no auto-refresh
  enabled?: boolean;        // only fetch when true (i.e. authenticated)
}

interface UseStocksReturn {
  stocks: StockRow[];
  meta: StockMeta | null;
  loading: boolean;
  error: string | null;
  errorCode: string | null;
  lastFetchedAt: string | null;
  refetch: () => void;
}

export function useStocks(options: UseStocksOptions = {}): UseStocksReturn {
  const {
    search = "",
    sort = "symbol",
    order = "asc",
    filter = "all",
    minChange = 0,
    page = 1,
    pageSize = 50,
    refreshInterval = 0,
    enabled = true,
  } = options;

  const [stocks, setStocks] = useState<StockRow[]>([]);
  const [meta, setMeta] = useState<StockMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);

  // Track in-flight request to prevent overlap
  const fetchingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const fetchStocks = useCallback(async () => {
    if (!enabled) return;
    if (fetchingRef.current) return; // Prevent overlapping requests

    fetchingRef.current = true;

    // Abort previous request if still in-flight
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setErrorCode(null);

    try {
      const params = new URLSearchParams({
        sort,
        order,
        filter,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (search) params.set("search", search);
      if (minChange > 0) params.set("minChange", String(minChange));

      const res = await fetch(`/api/stocks?${params}`, {
        signal: controller.signal,
        cache: "no-store",
      });

      const json = await res.json();

      if (!res.ok || !json.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        setErrorCode(json.code ?? null);
        return;
      }

      setStocks(json.data);
      setMeta(json.meta);
      setLastFetchedAt(json.meta?.fetchedAt ?? new Date().toISOString());
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to fetch stocks");
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [enabled, search, sort, order, filter, minChange, page, pageSize]);

  // Fetch on mount and when deps change
  useEffect(() => {
    fetchStocks();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchStocks]);

  // Auto-refresh interval
  useEffect(() => {
    if (!refreshInterval || refreshInterval <= 0 || !enabled) return;

    const id = setInterval(() => {
      fetchStocks();
    }, refreshInterval);

    return () => clearInterval(id);
  }, [fetchStocks, refreshInterval, enabled]);

  return { stocks, meta, loading, error, errorCode, lastFetchedAt, refetch: fetchStocks };
}
