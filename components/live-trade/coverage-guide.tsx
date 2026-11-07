"use client";

import { CoverageBadge } from "./coverage-badge";
import {
  COVERAGE_META,
  COVERAGE_ORDER,
} from "@/lib/live-trade/ui";

export function CoverageGuide() {
  return (
    <details className="rounded-xl border border-slate-700/50 bg-slate-800/20 px-4 py-3">
      <summary className="cursor-pointer select-none text-xs font-medium text-slate-300 hover:text-slate-100">
        Coverage &amp; freshness guide
      </summary>

      <div className="mt-3 space-y-3">
        <p className="text-[11px] leading-relaxed text-slate-500">
          Quote freshness, scanner coverage freshness and each zone&apos;s
          formation date measure different things. A live quote does not make an
          old zone new, and scanner coverage does not make a quote current.
        </p>

        <ul className="space-y-2">
          {COVERAGE_ORDER.map((coverage) => (
            <li key={coverage} className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <span className="shrink-0">
                <CoverageBadge coverage={coverage} />
              </span>
              <p className="text-[11px] leading-relaxed text-slate-500">
                {COVERAGE_META[coverage].description}
              </p>
            </li>
          ))}
        </ul>

        <p className="rounded-lg border border-slate-700/40 bg-slate-900/40 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          <span className="font-medium text-slate-400">AVAILABLE</span> means a
          completed scanner run covers the instrument. It does not prove that
          every displayed zone was re-detected in the latest scan: zones are not
          rewritten on re-detection and keep their original formation date.
          Freshness uses the latest completed scan covering the instrument, not
          the zone&apos;s creation date.
        </p>
      </div>
    </details>
  );
}
