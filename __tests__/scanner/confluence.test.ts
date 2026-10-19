// __tests__/scanner/confluence.test.ts

import { computeConfluence } from '@/lib/scanner/confluence';
import type { Zone } from '@/lib/scanner/types';

// Helper to build a minimal Zone fixture
function makeZone(overrides: Partial<Zone> & { zoneId: string }): Zone {
  return {
    instrumentId: 100,
    symbol: 'TEST',
    timeframe: '1D',
    pattern: 'DBR',
    side: 'DEMAND',
    baseStart: new Date('2023-01-01'),
    baseEnd: new Date('2023-01-02'),
    legInTs: new Date('2023-01-03'),
    legOutTs: new Date('2023-01-04'),
    zoneLow: 1000,
    zoneHigh: 1100,
    proximal: 1100,
    distal: 1000,
    formationTs: new Date('2023-01-04'),
    configVersion: 1,
    score: 70,
    lifecycleState: 'CONFIRMED_FRESH',
    touchCount: 0,
    createdAt: new Date('2023-01-05'),
    ...overrides,
  };
}

describe('computeConfluence', () => {
  it('returns zero scores when there are no other zones', () => {
    const zone = makeZone({ zoneId: 'z1' });
    const result = computeConfluence(zone, [zone]);
    expect(result.confluenceScore).toBe(0);
    expect(result.oppositionRisk).toBe(0);
    expect(result.confluenceDetails).toHaveLength(0);
    expect(result.oppositionDetails).toHaveLength(0);
  });

  it('detects a containing 1W same-side zone as confluence', () => {
    const zone = makeZone({ zoneId: 'z1', timeframe: '1D', zoneLow: 1000, zoneHigh: 1100 });
    const higherTfZone = makeZone({
      zoneId: 'z2',
      timeframe: '1W',
      zoneLow: 950,
      zoneHigh: 1150, // wider, containing z1
    });

    const result = computeConfluence(zone, [zone, higherTfZone]);
    expect(result.confluenceDetails).toHaveLength(1);
    expect(result.confluenceDetails[0].timeframe).toBe('1W');
    expect(result.confluenceDetails[0].containingZoneId).toBe('z2');
    expect(result.confluenceScore).toBeGreaterThan(0);
  });

  it('does NOT count a same-timeframe zone as higher-TF confluence', () => {
    const zone = makeZone({ zoneId: 'z1', timeframe: '1D', zoneLow: 1000, zoneHigh: 1100 });
    const sameTfZone = makeZone({
      zoneId: 'z2',
      timeframe: '1D',
      zoneLow: 950,
      zoneHigh: 1150,
    });
    const result = computeConfluence(zone, [zone, sameTfZone]);
    expect(result.confluenceDetails).toHaveLength(0);
  });

  it('does NOT count an opposite-side zone as confluence', () => {
    const zone = makeZone({ zoneId: 'z1', timeframe: '1D', zoneLow: 1000, zoneHigh: 1100 });
    const supplyZone = makeZone({
      zoneId: 'z2',
      timeframe: '1W',
      side: 'SUPPLY',
      zoneLow: 950,
      zoneHigh: 1150,
    });
    const result = computeConfluence(zone, [zone, supplyZone]);
    expect(result.confluenceDetails).toHaveLength(0);
  });

  it('detects a nearby supply zone above a demand zone as opposition risk', () => {
    const demandZone = makeZone({
      zoneId: 'z1',
      side: 'DEMAND',
      proximal: 1100,
      distal: 1000,
      zoneLow: 1000,
      zoneHigh: 1100,
    });
    const supplyZone = makeZone({
      zoneId: 'z2',
      side: 'SUPPLY',
      timeframe: '1W',
      zoneLow: 1150,
      zoneHigh: 1200,
      proximal: 1150, // 4.5 % above demand proximal
      distal: 1200,
    });

    const result = computeConfluence(demandZone, [demandZone, supplyZone]);
    expect(result.oppositionDetails).toHaveLength(1);
    expect(result.oppositionDetails[0].side).toBe('SUPPLY');
    expect(result.oppositionRisk).toBeGreaterThan(0);
  });

  it('ignores a supply zone that is more than 20 % away', () => {
    const demandZone = makeZone({
      zoneId: 'z1',
      side: 'DEMAND',
      proximal: 1000,
      distal: 900,
      zoneLow: 900,
      zoneHigh: 1000,
    });
    const farSupply = makeZone({
      zoneId: 'z2',
      side: 'SUPPLY',
      timeframe: '1W',
      zoneLow: 1250,
      zoneHigh: 1300,
      proximal: 1250, // 25 % away
      distal: 1300,
    });

    const result = computeConfluence(demandZone, [demandZone, farSupply]);
    expect(result.oppositionDetails).toHaveLength(0);
    expect(result.oppositionRisk).toBe(0);
  });

  it('caps confluenceScore at 100', () => {
    const zone = makeZone({ zoneId: 'z1', timeframe: '1D', zoneLow: 1000, zoneHigh: 1100 });
    const higherTfs: Zone[] = ['1W', '1M', '3M', '6M', '1Y'].map((tf, i) =>
      makeZone({
        zoneId: `z${i + 2}`,
        timeframe: tf as Zone['timeframe'],
        zoneLow: 900,
        zoneHigh: 1200,
      })
    );
    const result = computeConfluence(zone, [zone, ...higherTfs]);
    expect(result.confluenceScore).toBeLessThanOrEqual(100);
  });
});
