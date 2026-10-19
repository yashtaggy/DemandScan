// lib/scanner/__tests__/export.test.ts

import { zonesToCsv } from '@/lib/scanner/export';
import type { Zone } from '@/lib/scanner/types';

describe('zonesToCsv', () => {
  it('generates correct CSV output', () => {
    const zone: Zone = {
      zoneId: 'uuid-123',
      instrumentId: 12345,
      symbol: 'RELIANCE',
      timeframe: '1D',
      pattern: 'DBR',
      side: 'DEMAND',
      baseStart: new Date('2023-01-01T00:00:00Z'),
      baseEnd: new Date('2023-01-02T00:00:00Z'),
      legInTs: new Date('2023-01-03T00:00:00Z'),
      legOutTs: new Date('2023-01-04T00:00:00Z'),
      zoneLow: 1500,
      zoneHigh: 1600,
      proximal: 1550,
      distal: 1600,
      formationTs: new Date('2023-01-05T00:00:00Z'),
      configVersion: 1,
      score: 85,
      lifecycleState: 'CONFIRMED_FRESH',
      lastTouchTs: undefined,
      touchCount: 0,
      createdAt: new Date('2023-01-06T00:00:00Z'),
    };

    const csv = zonesToCsv([zone]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'zoneId,instrumentId,symbol,timeframe,pattern,side,baseStart,baseEnd,legInTs,legOutTs,zoneLow,zoneHigh,proximal,distal,formationTs,configVersion,score,lifecycleState,lastTouchTs,touchCount,createdAt'
    );
    expect(lines).toHaveLength(2);
    const cols = lines[1].split(',');
    expect(cols[0]).toBe('uuid-123');
    expect(cols[1]).toBe('12345');
    expect(cols[2]).toBe('RELIANCE');
    expect(cols[3]).toBe('1D');
    expect(cols[4]).toBe('DBR');
    expect(cols[5]).toBe('DEMAND');
    expect(cols[6]).toBe('2023-01-01T00:00:00.000Z');
    expect(cols[20]).toBe('2023-01-06T00:00:00.000Z');
  });
});
