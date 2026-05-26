import { computeSwitches, computeValves } from '../src/accessoryPlan';
import type { SmartIrrigationConfig } from '../src/config';

function makeConfig(overrides: Partial<SmartIrrigationConfig> = {}): SmartIrrigationConfig {
  return {
    name: 'Smart Irrigation',
    hue: { bridgeIp: '1.2.3.4', apiKey: 'k', healthCheckSec: 60 },
    location: { latitude: 52, longitude: 5 },
    zones: [],
    schedule: [],
    weather: { sources: [], consensusStrategy: 'majority', cacheMinutes: 10 },
    override: { autoResetMinutes: 60, granularity: 'per-zone' },
    windUnit: 'm/s',
    logLevel: 'info',
    ...overrides,
  };
}

describe('computeValves', () => {
  it('returns one valve plan per zone with stable subtypes', () => {
    const config = makeConfig({
      zones: [
        { id: 'z1', name: 'Front', type: 'sprinkler', hueLightId: '1' },
        { id: 'z2', name: 'Back', type: 'dripLine', hueLightId: '2' },
      ],
    });
    const valves = computeValves(config);
    expect(valves).toEqual([
      { subtype: 'valve-z1', displayName: 'Front', zoneId: 'z1' },
      { subtype: 'valve-z2', displayName: 'Back', zoneId: 'z2' },
    ]);
  });
});

describe('computeSwitches', () => {
  it('returns no schedule switch when the schedule is empty', () => {
    const result = computeSwitches(makeConfig());
    expect(result.filter((s) => s.kind === 'schedule')).toEqual([]);
  });

  it('adds the schedule switch when at least one entry exists', () => {
    const config = makeConfig({
      schedule: [
        {
          id: 'e1',
          name: 'Morning',
          days: ['Mon'],
          startTime: '08:00',
          steps: [{ zoneId: 'z1', durationMin: 10 }],
          repeat: 1,
        },
      ],
    });
    const result = computeSwitches(config);
    expect(result[0]).toEqual({
      subtype: 'switch-schedule',
      displayName: 'Activate Schedule',
      kind: 'schedule',
    });
  });

  it('adds one wind-override switch per zone with wind blocking enabled', () => {
    const config = makeConfig({
      zones: [
        {
          id: 'z1',
          name: 'Lawn',
          type: 'sprinkler',
          hueLightId: '1',
          windBlocking: { enabled: true, blockedOctants: ['N'], minimumWindSpeedMs: 6 },
        },
        {
          id: 'z2',
          name: 'Beds',
          type: 'dripLine',
          hueLightId: '2',
          windBlocking: { enabled: false, blockedOctants: [], minimumWindSpeedMs: 0 },
        },
      ],
    });
    const result = computeSwitches(config);
    const winds = result.filter((s) => s.kind === 'wind-override');
    expect(winds).toHaveLength(1);
    expect(winds[0]).toEqual({
      subtype: 'wind-override-z1',
      displayName: 'Wind override: Lawn',
      kind: 'wind-override',
      zoneId: 'z1',
    });
  });

  it('adds one rain-override switch per zone with rain blocking enabled', () => {
    const config = makeConfig({
      zones: [
        {
          id: 'z1',
          name: 'Veggies',
          type: 'dripLine',
          hueLightId: '1',
          rainBlocking: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
        },
      ],
    });
    const result = computeSwitches(config);
    expect(result).toContainEqual({
      subtype: 'rain-override-z1',
      displayName: 'Rain override: Veggies',
      kind: 'rain-override',
      zoneId: 'z1',
    });
  });

  it('combines schedule + wind + rain switches in a single call', () => {
    const config = makeConfig({
      schedule: [
        {
          id: 'e1',
          name: 'm',
          days: ['Mon'],
          startTime: '08:00',
          steps: [{ zoneId: 'z1', durationMin: 10 }],
          repeat: 1,
        },
      ],
      zones: [
        {
          id: 'z1',
          name: 'Lawn',
          type: 'sprinkler',
          hueLightId: '1',
          windBlocking: { enabled: true, blockedOctants: ['N'], minimumWindSpeedMs: 6 },
          rainBlocking: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
        },
      ],
    });
    const result = computeSwitches(config);
    expect(result.map((s) => s.kind)).toEqual(['schedule', 'wind-override', 'rain-override']);
  });
});

describe('computeSwitches — override granularity', () => {
  function configWithTwoBlockingZones(
    granularity: 'per-zone' | 'global' | 'none',
  ): SmartIrrigationConfig {
    return makeConfig({
      override: { autoResetMinutes: 60, granularity },
      zones: [
        {
          id: 'z1',
          name: 'Front',
          type: 'sprinkler',
          hueLightId: '1',
          windBlocking: { enabled: true, blockedOctants: ['N'], minimumWindSpeedMs: 6 },
          rainBlocking: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
        },
        {
          id: 'z2',
          name: 'Back',
          type: 'sprinkler',
          hueLightId: '2',
          windBlocking: { enabled: true, blockedOctants: ['N'], minimumWindSpeedMs: 6 },
          rainBlocking: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
        },
      ],
    });
  }

  it('per-zone: one wind + one rain switch per blocking-enabled zone (current behaviour)', () => {
    const result = computeSwitches(configWithTwoBlockingZones('per-zone'));
    const kinds = result.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'wind-override')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'rain-override')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'wind-override-global')).toHaveLength(0);
  });

  it('global: collapses to one wind + one rain switch total', () => {
    const result = computeSwitches(configWithTwoBlockingZones('global'));
    expect(result).toContainEqual({
      subtype: 'wind-override-global',
      displayName: 'Wind override (all zones)',
      kind: 'wind-override-global',
    });
    expect(result).toContainEqual({
      subtype: 'rain-override-global',
      displayName: 'Rain override (all zones)',
      kind: 'rain-override-global',
    });
    expect(result.filter((s) => s.kind === 'wind-override')).toHaveLength(0);
    expect(result.filter((s) => s.kind === 'rain-override')).toHaveLength(0);
  });

  it('global: omits a kind when no zone has that blocking enabled', () => {
    const config = makeConfig({
      override: { autoResetMinutes: 60, granularity: 'global' },
      zones: [
        {
          id: 'z1',
          name: 'Wind-only',
          type: 'sprinkler',
          hueLightId: '1',
          windBlocking: { enabled: true, blockedOctants: ['N'], minimumWindSpeedMs: 6 },
        },
      ],
    });
    const result = computeSwitches(config);
    expect(result.map((s) => s.kind)).toEqual(['wind-override-global']);
  });

  it('none: emits no override switches at all', () => {
    const result = computeSwitches(configWithTwoBlockingZones('none'));
    expect(result.filter((s) => s.kind !== 'schedule')).toEqual([]);
  });
});
