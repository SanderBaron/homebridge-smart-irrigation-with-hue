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
  it('returns no switches when the schedule is empty', () => {
    const result = computeSwitches(makeConfig());
    expect(result).toEqual([]);
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

  it('never emits override switches — only the two schedule switches exist', () => {
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
    expect(result.map((s) => s.kind)).toEqual(['schedule', 'run-now']);
  });

  it('emits no switches at all when there is no schedule, even with blocking configured', () => {
    const config = makeConfig({
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
    expect(computeSwitches(config)).toEqual([]);
  });
});
