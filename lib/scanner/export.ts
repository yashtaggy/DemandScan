// lib/scanner/export.ts

import type { Zone } from '@/lib/scanner/types';

/**
 * Convert an array of Zone objects to a CSV string.
 * The first row is a header with all exported columns.
 */
export function zonesToCsv(zones: Zone[]): string {
  const headers = [
    'zoneId',
    'instrumentId',
    'symbol',
    'timeframe',
    'pattern',
    'side',
    'baseStart',
    'baseEnd',
    'legInTs',
    'legOutTs',
    'zoneLow',
    'zoneHigh',
    'proximal',
    'distal',
    'formationTs',
    'configVersion',
    'score',
    'lifecycleState',
    'lastTouchTs',
    'touchCount',
    'createdAt',
  ];

  const escape = (value: any) => {
    if (value === undefined || value === null) return '';
    const str = String(value);
    // Escape double quotes by doubling them, wrap in quotes if needed
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = zones.map((z) => {
    return [
      z.zoneId,
      z.instrumentId,
      z.symbol ?? '',
      z.timeframe,
      z.pattern,
      z.side,
      z.baseStart.toISOString(),
      z.baseEnd.toISOString(),
      z.legInTs.toISOString(),
      z.legOutTs.toISOString(),
      z.zoneLow,
      z.zoneHigh,
      z.proximal,
      z.distal,
      z.formationTs.toISOString(),
      z.configVersion,
      z.score,
      z.lifecycleState,
      z.lastTouchTs ? z.lastTouchTs.toISOString() : '',
      z.touchCount,
      z.createdAt.toISOString(),
    ].map(escape).join(',');
  });

  return `${headers.join(',')}\n${rows.join('\n')}`;
}
