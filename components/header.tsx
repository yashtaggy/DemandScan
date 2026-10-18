"use client";

import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { formatDateTime } from "@/lib/utils";

export function Header({ lastRefreshed }: { lastRefreshed: string | null }) {
  const { status, loading, refetch } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  const handleConnect = () => {
    window.location.href = "/api/kite/login";
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await fetch("/api/kite/logout", { method: "POST" });
      // Refresh Next.js router cache and re-poll auth status
      router.refresh();
      refetch();
    } finally {
      setLoggingOut(false);
    }
  };

  const isAuthenticated = status?.authenticated ?? false;
  const market = status?.market;

  return (
    <header className="sticky top-0 z-30 border-b border-slate-700/50 bg-slate-900/80 backdrop-blur-md">
      <div className="mx-auto max-w-screen-2xl px-4 sm:px-6">
        <div className="flex h-14 items-center justify-between gap-4">
          {/* Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-900/40">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-white" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" />
              </svg>
            </div>
            <div>
              <span className="text-base font-bold tracking-tight text-white">
                Demand<span className="text-indigo-400">Scan</span>
              </span>
              <span className="ml-2 text-[10px] text-slate-500 font-medium uppercase tracking-wider hidden sm:inline">NSE Scanner</span>
            </div>
          </div>

          {/* Nav links */}
          <nav className="hidden md:flex items-center gap-1">
            <NavLink href="/" active={pathname === "/"}>Dashboard</NavLink>
            <NavLink href="/scanner" active={pathname === "/scanner"}>Scanner</NavLink>
          </nav>

          {/* Center status row */}
          <div className="flex items-center gap-3 text-sm">
            {/* Market status */}
            {market && (
              <Badge
                variant={market.isOpen ? "success" : "neutral"}
                dot={market.isOpen}
              >
                <span className="hidden sm:inline">{market.exchange} </span>
                {market.isOpen ? "Open" : "Closed"}
              </Badge>
            )}

            {/* Last refreshed */}
            {lastRefreshed && (
              <span className="hidden md:inline text-slate-500 text-xs">
                Updated {formatDateTime(lastRefreshed)}
              </span>
            )}
          </div>

          {/* Right: Connection status + actions */}
          <div className="flex items-center gap-3 shrink-0">
            {loading ? (
              <div className="h-4 w-28 animate-pulse rounded bg-slate-700" />
            ) : isAuthenticated ? (
              <>
                <Badge variant="success" dot>
                  <span className="hidden sm:inline">Connected</span>
                  <span className="sm:hidden">●</span>
                </Badge>
                {status?.userName && (
                  <span className="hidden md:inline text-xs text-slate-400">
                    {status.userName}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleLogout}
                  loading={loggingOut}
                  id="logout-button"
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <>
                <Badge variant="warning">Not connected</Badge>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleConnect}
                  id="connect-button"
                >
                  Connect Zerodha
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

function NavLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
        active
          ? "bg-indigo-500/15 text-indigo-300 border border-indigo-500/30"
          : "text-slate-400 hover:text-slate-200 hover:bg-slate-700/50"
      }`}
    >
      {children}
    </Link>
  );
}
