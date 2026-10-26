/**
 * Lifecycle updates previously issued one UPDATE and one INSERT per touched
 * zone. These tests pin the batched replacement: one multi-row UPDATE and one
 * multi-row event insert, with identical state transitions, touch-count
 * arithmetic, event details, and historical flags.
 */

const mockTagged = jest.fn();
const mockQuery = jest.fn();

jest.mock('@/lib/db', () => ({
  getDb: jest.fn(() => {
    const sql: any = (...args: unknown[]) => mockTagged(...args);
    sql.query = (...args: unknown[]) => mockQuery(...args);
    return sql;
  }),
}));

import { updateZoneLifecycles } from '@/lib/scanner/lifecycle';
import { DEFAULT_SCANNER_CONFIG } from '@/lib/scanner/types';

const ACTIVE_ROWS = [
  {
    zone_id: 'zone-demand',
    instrument_id: 1,
    side: 'DEMAND',
    zone_low: 85,
    zone_high: 95,
    proximal: 95,
    distal: 85,
    lifecycle_state: 'CONFIRMED_FRESH',
    touch_count: 0,
  },
  {
    zone_id: 'zone-supply',
    instrument_id: 2,
    side: 'SUPPLY',
    zone_low: 105,
    zone_high: 115,
    proximal: 105,
    distal: 115,
    lifecycle_state: 'TOUCHED_ONCE',
    touch_count: 1,
  },
  {
    zone_id: 'zone-calm',
    instrument_id: 3,
    side: 'DEMAND',
    zone_low: 50,
    zone_high: 60,
    proximal: 60,
    distal: 50,
    lifecycle_state: 'CONFIRMED_FRESH',
    touch_count: 0,
  },
];

const SNAPSHOTS = [
  { instrumentId: 1, close: 100, high: 101, low: 94, date: new Date('2024-02-01') },
  { instrumentId: 2, close: 116, high: 117, low: 108, date: new Date('2024-02-02') },
  { instrumentId: 3, close: 200, high: 201, low: 150, date: new Date('2024-02-03') },
];

beforeEach(() => {
  mockTagged.mockReset();
  mockQuery.mockReset();
  mockTagged.mockResolvedValue(ACTIVE_ROWS);
  mockQuery.mockResolvedValue([]);
});

function updateCall() {
  return mockQuery.mock.calls.find(([text]) =>
    String(text).includes('UPDATE zones AS z')
  );
}

function eventsCall() {
  return mockQuery.mock.calls.find(([text]) =>
    String(text).includes('INSERT INTO zone_events')
  );
}

describe('updateZoneLifecycles — batched writes', () => {
  test('evaluates only active zones for the batch instruments', async () => {
    await updateZoneLifecycles(SNAPSHOTS, DEFAULT_SCANNER_CONFIG);

    expect(mockTagged).toHaveBeenCalledTimes(1);
    const strings = (mockTagged.mock.calls[0][0] as string[]).join('?');
    expect(strings).toContain("lifecycle_state != 'BROKEN'");
    expect(strings).toContain('instrument_id = ANY(');
    expect(mockTagged.mock.calls[0][1]).toEqual([1, 2, 3]);
  });

  test('writes all state transitions in one multi-row UPDATE with unchanged semantics', async () => {
    await updateZoneLifecycles(SNAPSHOTS, DEFAULT_SCANNER_CONFIG);

    const update = updateCall();
    expect(update).toBeDefined();
    const [text, params] = update!;

    expect(text).toContain('FROM (VALUES');
    expect(text).toContain('WHERE z.zone_id = v.zone_id');
    // Two changed zones, one untouched zone skipped — four params per zone.
    expect(params).toEqual([
      'zone-demand',
      'TOUCHED_ONCE',
      SNAPSHOTS[0].date,
      1,
      'zone-supply',
      'BROKEN',
      SNAPSHOTS[1].date,
      2,
    ]);

    // BREAK wins over a simultaneous touch on the supply zone.
    expect(params).not.toContain('zone-calm');
  });

  test('appends one event per transition with the previous details shape', async () => {
    await updateZoneLifecycles(SNAPSHOTS, DEFAULT_SCANNER_CONFIG);

    const events = eventsCall();
    expect(events).toBeDefined();
    const [text, params] = events!;

    expect(text).toContain(
      'INSERT INTO zone_events (zone_id, event_type, candle_ts, details_json, is_historical, as_of_date)'
    );
    expect(params).toHaveLength(12);

    expect(params.slice(0, 6)).toEqual([
      'zone-demand',
      'TOUCH',
      SNAPSHOTS[0].date,
      JSON.stringify({ close: 100, proximal: 95, touchCount: 1 }),
      false,
      null,
    ]);
    expect(params.slice(6)).toEqual([
      'zone-supply',
      'BREAK',
      SNAPSHOTS[1].date,
      JSON.stringify({ close: 116, distal: 115 }),
      false,
      null,
    ]);
  });

  test('flags historical replay events and stamps the as-of date', async () => {
    mockTagged.mockResolvedValue([ACTIVE_ROWS[0]]);

    await updateZoneLifecycles([SNAPSHOTS[0]], DEFAULT_SCANNER_CONFIG, true);

    const [, params] = eventsCall()!;
    expect(params.slice(0, 6)).toEqual([
      'zone-demand',
      'TOUCH',
      SNAPSHOTS[0].date,
      JSON.stringify({ close: 100, proximal: 95, touchCount: 1 }),
      true,
      SNAPSHOTS[0].date,
    ]);
  });

  test('issues no writes when no zone changed state', async () => {
    mockTagged.mockResolvedValue([ACTIVE_ROWS[2]]);

    await updateZoneLifecycles([SNAPSHOTS[2]], DEFAULT_SCANNER_CONFIG);

    expect(updateCall()).toBeUndefined();
    expect(eventsCall()).toBeUndefined();
  });

  test('returns without querying when the snapshot batch is empty', async () => {
    await updateZoneLifecycles([], DEFAULT_SCANNER_CONFIG);

    expect(mockTagged).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
