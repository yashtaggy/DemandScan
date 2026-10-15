"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { AuthStatus } from "@/lib/types";

export interface UseAuthReturn {
  status: AuthStatus & { envConfigured?: boolean; market?: { isOpen: boolean; nextEvent: string; exchange: string } } | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useAuth(): UseAuthReturn {
  const [status, setStatus] = useState<UseAuthReturn["status"]>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch("/api/kite/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check auth status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  return { status, loading, error, refetch: fetchStatus };
}
