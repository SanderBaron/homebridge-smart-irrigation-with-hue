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
    override: { autoResetMinutes: 60 },
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
          durationMin: 10,
          zoneIds: [],
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
        { id: 'e1', name: 'm', days: ['Mon'], startTime: '08:00', durationMin: 10, zoneIds: [] },
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
