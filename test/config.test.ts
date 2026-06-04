import { parseConfig } from '../src/config';
import type { PlatformConfig } from 'homebridge';

function asConfig(input: Record<string, unknown>): PlatformConfig {
  return { platform: 'SmartIrrigation', ...input } as PlatformConfig;
}

const BASE_LOCATION = { latitude: 52.37, longitude: 4.89 };

describe('parseConfig — basics', () => {
  it('rejects a config missing latitude or longitude', () => {
    const result = parseConfig(asConfig({}));
    expect(result.ok).toBe(false);
  });

  it('parses a minimal valid config and applies defaults', () => {
    const result = parseConfig(asConfig({ location: BASE_LOCATION }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.name).toBe('Smart Irrigation');
    expect(result.config.zones).toEqual([]);
    expect(result.config.schedule).toEqual([]);
    expect(result.config.weather.cacheMinutes).toBe(10);
    expect(result.config.weather.consensusStrategy).toBe('majority');
    expect(result.config.windUnit).toBe('m/s');
    expect(result.config.pump).toBeUndefined();
  });
});

describe('parseConfig — zones', () => {
  it('drops zones missing required fields', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [
          { id: '', name: 'No id', hueLightId: '1' },
          { id: 'z1', name: '', hueLightId: '1' },
          { id: 'z1', name: 'No outlet', hueLightId: '' },
          { id: 'z2', name: 'Good', hueLightId: '7' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.zones.map((z) => z.id)).toEqual(['z2']);
  });

  it('deduplicates zone ids and keeps the first occurrence', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [
          { id: 'z1', name: 'First', hueLightId: '1' },
          { id: 'z1', name: 'Dupe', hueLightId: '2' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.zones).toHaveLength(1);
    expect(result.config.zones[0]?.name).toBe('First');
  });

  it('parses wind and run-with relationships, never writes rainBlocking onto a zone', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [
          {
            id: 'z1',
            name: 'A',
            hueLightId: '1',
            type: 'sprinkler',
            runWith: ['z2', 'unknown', 'z1'],
            windBlocking: {
              enabled: true,
              blockedOctants: ['N', 'NE', 'invalid'],
              minimumWindSpeedMs: 6,
            },
            // Legacy v0.1 rain config — should NOT survive onto the zone in v0.2+.
            rainBlocking: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
          },
          { id: 'z2', name: 'B', hueLightId: '2' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const z = result.config.zones[0] as unknown as Record<string, unknown>;
    expect((z as { runWith?: string[] }).runWith).toEqual(['z2']);
    expect(
      (z as { windBlocking?: { blockedOctants: string[] } }).windBlocking?.blockedOctants,
    ).toEqual(['N', 'NE']);
    expect('rainBlocking' in z).toBe(false);
  });

  it('drops empty runWith arrays so the field is undefined on simple zones', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [{ id: 'z1', name: 'A', hueLightId: '1', runWith: [] }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.zones[0]?.runWith).toBeUndefined();
  });
});

describe('parseConfig — schedule (new shape)', () => {
  it('parses an entry with explicit steps + repeat', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [
          { id: 'z1', name: 'A', hueLightId: '1' },
          { id: 'z2', name: 'B', hueLightId: '2' },
        ],
        schedule: [
          {
            id: 'e1',
            name: 'Morning',
            days: ['Mon', 'Wed'],
            startTime: '08:00',
            steps: [
              { zoneId: 'z1', durationMin: 15 },
              { zoneId: 'z2', durationMin: 20 },
            ],
            repeat: 2,
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const e = result.config.schedule[0];
    expect(e?.steps).toEqual([
      { zoneId: 'z1', durationMin: 15 },
      { zoneId: 'z2', durationMin: 20 },
    ]);
    expect(e?.repeat).toBe(2);
  });

  it('migrates legacy zoneIds + durationMin into one step per zone', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [
          { id: 'z1', name: 'A', hueLightId: '1' },
          { id: 'z2', name: 'B', hueLightId: '2' },
        ],
        schedule: [
          {
            id: 'legacy',
            name: 'Legacy entry',
            days: ['Mon'],
            startTime: '08:00',
            durationMin: 12,
            zoneIds: ['z1', 'z2'],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.schedule[0]?.steps).toEqual([
      { zoneId: 'z1', durationMin: 12 },
      { zoneId: 'z2', durationMin: 12 },
    ]);
    expect(result.config.schedule[0]?.repeat).toBe(1);
  });

  it('drops steps whose zoneId is unknown or whose duration is zero', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [{ id: 'z1', name: 'A', hueLightId: '1' }],
        schedule: [
          {
            id: 'e1',
            name: 'Mixed',
            days: ['Mon'],
            startTime: '08:00',
            steps: [
              { zoneId: 'z1', durationMin: 10 },
              { zoneId: 'gone', durationMin: 5 },
              { zoneId: 'z1', durationMin: 0 },
            ],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.schedule[0]?.steps).toEqual([{ zoneId: 'z1', durationMin: 10 }]);
  });

  it('clamps repeat to minimum 1 (truncating fractional values)', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [{ id: 'z1', name: 'A', hueLightId: '1' }],
        schedule: [
          {
            id: 'e1',
            name: 'r',
            days: ['Mon'],
            startTime: '08:00',
            steps: [{ zoneId: 'z1', durationMin: 5 }],
            repeat: 2.7,
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.schedule[0]?.repeat).toBe(2);
  });
});

describe('parseConfig — schedule (validation)', () => {
  it('drops entries with invalid time, no days, or unknown zones', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [{ id: 'z1', name: 'A', hueLightId: '1' }],
        schedule: [
          {
            id: 'e1',
            name: 'Bad time',
            days: ['Mon'],
            startTime: '08:99',
            durationMin: 10,
            zoneIds: ['z1'],
          },
          {
            id: 'e2',
            name: 'No days',
            days: [],
            startTime: '08:00',
            durationMin: 10,
            zoneIds: ['z1'],
          },
          {
            id: 'e3',
            name: 'Unknown zone',
            days: ['Mon'],
            startTime: '08:00',
            durationMin: 10,
            zoneIds: ['gone'],
          },
          {
            id: 'e4',
            name: 'Zero dur',
            days: ['Mon'],
            startTime: '08:00',
            durationMin: 0,
            zoneIds: ['z1'],
          },
          {
            id: 'e5',
            name: 'Good',
            days: ['Mon', 'Wed'],
            startTime: '08:00',
            durationMin: 15,
            zoneIds: ['z1'],
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.schedule.map((e) => e.id)).toEqual(['e5']);
  });
});

describe('parseConfig — pump', () => {
  it('returns undefined when pump.enabled is false', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        pump: { enabled: false, hueLightId: '9' },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.pump).toBeUndefined();
  });

  it('returns a typed pump with defaults and filters unknown zone ids', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [{ id: 'z1', name: 'A', hueLightId: '1' }],
        pump: { enabled: true, hueLightId: '9', zoneIds: ['z1', 'unknown'] },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.pump).toEqual({
      enabled: true,
      hueLightId: '9',
      preRunSec: 3,
      postRunSec: 5,
      zoneIds: ['z1'],
    });
  });
});

describe('parseConfig — global rain', () => {
  it('returns undefined when no top-level rain and no legacy per-zone rain', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [{ id: 'z1', name: 'A', hueLightId: '1' }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.rain).toBeUndefined();
  });

  it('reads a top-level rain block as-is', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        rain: { enabled: true, past24hThresholdMm: 3, next12hThresholdMm: 1 },
        zones: [{ id: 'z1', name: 'A', hueLightId: '1' }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.rain).toEqual({
      enabled: true,
      past24hThresholdMm: 3,
      next12hThresholdMm: 1,
    });
  });

  it('migrates legacy per-zone rainBlocking to the strictest non-zero thresholds', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        zones: [
          {
            id: 'z1',
            name: 'A',
            hueLightId: '1',
            rainBlocking: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
          },
          {
            id: 'z2',
            name: 'B',
            hueLightId: '2',
            rainBlocking: { enabled: true, past24hThresholdMm: 1, next12hThresholdMm: 3 },
          },
          {
            id: 'z3',
            name: 'Disabled',
            hueLightId: '3',
            // Disabled legacy entries don't contribute.
            rainBlocking: { enabled: false, past24hThresholdMm: 999, next12hThresholdMm: 999 },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.rain).toEqual({
      enabled: true,
      past24hThresholdMm: 1,
      next12hThresholdMm: 2,
    });
  });

  it('top-level rain wins over any legacy per-zone settings', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        rain: { enabled: false, past24hThresholdMm: 0, next12hThresholdMm: 0 },
        zones: [
          {
            id: 'z1',
            name: 'A',
            hueLightId: '1',
            rainBlocking: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.rain).toEqual({
      enabled: false,
      past24hThresholdMm: 0,
      next12hThresholdMm: 0,
    });
  });
});

describe('parseConfig — weather', () => {
  it('drops openweathermap from sources when no API key provided', () => {
    const result = parseConfig(
      asConfig({
        location: BASE_LOCATION,
        weather: { sources: ['open-meteo', 'openweathermap'] },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.weather.sources).toEqual(['open-meteo']);
  });

  it('defaults to open-meteo + buienradar when no sources listed', () => {
    const result = parseConfig(asConfig({ location: BASE_LOCATION }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config.weather.sources).toEqual(['open-meteo', 'buienradar']);
  });
});
