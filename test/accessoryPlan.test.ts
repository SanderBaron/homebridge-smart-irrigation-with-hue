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

  it('adds the schedule switch and a "Run Schedule Now" switch when at least one entry exists', () => {
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
    expect(result.find((s) => s.kind === 'schedule')).toEqual({
      subtype: 'switch-schedule',
      displayName: 'Activate Schedule',
      kind: 'schedule',
    });
    expect(result.find((s) => s.kind === 'run-now')).toEqual({
      subtype: 'switch-run-now',
      displayName: 'Run Schedule Now',
      kind: 'run-now',
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

  it('emits a single global rain-override switch when global rain blocking is enabled', () => {
    const config = makeConfig({
      rain: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
      zones: [
        { id: 'z1', name: 'Veggies', type: 'dripLine', hueLightId: '1' },
        { id: 'z2', name: 'Lawn', type: 'sprinkler', hueLightId: '2' },
      ],
    });
    const result = computeSwitches(config);
    const rains = result.filter((s) => s.kind === 'rain-override-global');
    expect(rains).toHaveLength(1);
    expect(rains[0]).toEqual({
      subtype: 'rain-override-global',
      displayName: 'Rain override',
      kind: 'rain-override-global',
    });
  });

  it('emits no rain-override switch when global rain blocking is disabled', () => {
    const config = makeConfig({
      rain: { enabled: false, past24hThresholdMm: 0, next12hThresholdMm: 0 },
      zones: [{ id: 'z1', name: 'Lawn', type: 'sprinkler', hueLightId: '1' }],
    });
    const result = computeSwitches(config);
    expect(result.filter((s) => s.kind === 'rain-override-global')).toHaveLength(0);
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
      rain: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
      zones: [
        {
          id: 'z1',
          name: 'Lawn',
          type: 'sprinkler',
          hueLightId: '1',
          windBlocking: { enabled: true, blockedOctants: ['N'], minimumWindSpeedMs: 6 },
        },
      ],
    });
    const result = computeSwitches(config);
    expect(result.map((s) => s.kind)).toEqual([
      'schedule',
      'run-now',
      'wind-override',
      'rain-override-global',
    ]);
  });
});

describe('computeSwitches — override granularity', () => {
  function configWithTwoWindZones(
    granularity: 'per-zone' | 'global' | 'none',
  ): SmartIrrigationConfig {
    return makeConfig({
      override: { autoResetMinutes: 60, granularity },
      rain: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
      zones: [
        {
          id: 'z1',
          name: 'Front',
          type: 'sprinkler',
          hueLightId: '1',
          windBlocking: { enabled: true, blockedOctants: ['N'], minimumWindSpeedMs: 6 },
        },
        {
          id: 'z2',
          name: 'Back',
          type: 'sprinkler',
          hueLightId: '2',
          windBlocking: { enabled: true, blockedOctants: ['N'], minimumWindSpeedMs: 6 },
        },
      ],
    });
  }

  it('per-zone: one wind switch per blocking-enabled zone + one global rain switch', () => {
    const result = computeSwitches(configWithTwoWindZones('per-zone'));
    const kinds = result.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'wind-override')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'wind-override-global')).toHaveLength(0);
    expect(kinds.filter((k) => k === 'rain-override-global')).toHaveLength(1);
  });

  it('global: collapses wind to one switch total + one global rain switch', () => {
    const result = computeSwitches(configWithTwoWindZones('global'));
    expect(result).toContainEqual({
      subtype: 'wind-override-global',
      displayName: 'Wind override (all zones)',
      kind: 'wind-override-global',
    });
    expect(result).toContainEqual({
      subtype: 'rain-override-global',
      displayName: 'Rain override',
      kind: 'rain-override-global',
    });
    expect(result.filter((s) => s.kind === 'wind-override')).toHaveLength(0);
  });

  it('global: omits wind when no zone has wind blocking enabled', () => {
    const config = makeConfig({
      override: { autoResetMinutes: 60, granularity: 'global' },
      rain: { enabled: true, past24hThresholdMm: 5, next12hThresholdMm: 2 },
      zones: [{ id: 'z1', name: 'Drip', type: 'dripLine', hueLightId: '1' }],
    });
    const result = computeSwitches(config);
    expect(result.map((s) => s.kind)).toEqual(['rain-override-global']);
  });

  it('none: emits no override switches at all (rain or wind)', () => {
    const result = computeSwitches(configWithTwoWindZones('none'));
    expect(result.filter((s) => s.kind !== 'schedule' && s.kind !== 'run-now')).toEqual([]);
  });
});
