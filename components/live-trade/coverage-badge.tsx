"use client";

import { Badge } from "@/components/ui/badge";
import type { LiveTradeZoneCoverage } from "@/lib/live-trade/constants";
import { COVERAGE_META } from "@/lib/live-trade/ui";

export function CoverageBadge({ coverage }: { coverage: LiveTradeZoneCoverage }) {
  const meta = COVERAGE_META[coverage];
  return (
    <span title={meta.description}>
      <Badge variant={meta.tone}>{meta.label}</Badge>
    </span>
  );
}
