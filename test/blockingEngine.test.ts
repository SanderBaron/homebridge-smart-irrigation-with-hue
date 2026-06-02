import {
  degreesToOctant,
  evaluateRainBlocking,
  evaluateWindBlocking,
  evaluateZoneBlocking,
} from '../src/blockingEngine';
import type { RainBlockingConfig, Zone } from '../src/types';
import type { WeatherSnapshot } from '../src/weather/types';

function snapshot(
  partial: Partial<WeatherSnapshot> & Pick<WeatherSnapshot, 'source'>,
): WeatherSnapshot {
  return {
    observedAt: new Date('2026-05-26T08:00:00Z'),
    ...partial,
  };
}

const ZONE_WIND_ONLY: Zone = {
  id: 'z1',
  name: 'Front lawn',
  type: 'sprinkler',
  hueLightId: '7',
  windBlocking: {
    enabled: true,
    blockedOctants: ['N', 'NE', 'NW'],
    minimumWindSpeedMs: 6,
  },
};

const ZONE_NO_BLOCKING: Zone = {
  id: 'z2',
  name: 'Vegetable patch',
  type: 'dripLine',
  hueLightId: '8',
};

const RAIN_CFG: RainBlockingConfig = {
  enabled: true,
  past24hThresholdMm: 5,
  next12hThresholdMm: 2,
};

describe('degreesToOctant', () => {
  it.each([
    [0, 'N'],
    [22.5, 'NE'],
    [45, 'NE'],
    [67.5, 'E'],
    [90, 'E'],
    [180, 'S'],
    [292.5, 'NW'],
    [337.5, 'N'],
    [359, 'N'],
  ] as const)('maps %p° to %p', (deg, expected) => {
    expect(degreesToOctant(deg)).toBe(expected);
  });

  it('wraps negative and >360 bearings', () => {
    expect(degreesToOctant(-45)).toBe(degreesToOctant(315));
    expect(degreesToOctant(720)).toBe(degreesToOctant(0));
  });
});

describe('evaluateWindBlocking', () => {
  it('returns undefined when wind blocking is disabled', () => {
    expect(evaluateWindBlocking(ZONE_NO_BLOCKING, [], 'majority')).toBeUndefined();
  });

  it('blocks when wind from a blocked octant exceeds the threshold', () => {
    const snaps = [snapshot({ source: 'open-meteo', windSpeedMs: 8, windDirectionDeg: 350 })];
    const decision = evaluateWindBlocking(ZONE_WIND_ONLY, snaps, 'any');
    expect(decision?.blocked).toBe(true);
  });

  it('does not block when wind is from a non-blocked octant', () => {
    const snaps = [snapshot({ source: 'open-meteo', windSpeedMs: 15, windDirectionDeg: 180 })];
    const decision = evaluateWindBlocking(ZONE_WIND_ONLY, snaps, 'any');
    expect(decision?.blocked).toBe(false);
  });

  it('does not block when speed is below the threshold even from a blocked octant', () => {
    const snaps = [snapshot({ source: 'open-meteo', windSpeedMs: 3, windDirectionDeg: 0 })];
    const decision = evaluateWindBlocking(ZONE_WIND_ONLY, snaps, 'any');
    expect(decision?.blocked).toBe(false);
  });

  it('abstains for sources missing wind speed or direction', () => {
    const snaps = [
      snapshot({ source: 'open-meteo', windDirectionDeg: 0 }), // no speed → abstain
      snapshot({ source: 'buienradar', windSpeedMs: 9 }), // no direction → abstain
      snapshot({ source: 'openweathermap', windSpeedMs: 7, windDirectionDeg: 0 }), // votes block
    ];
    const decision = evaluateWindBlocking(ZONE_WIND_ONLY, snaps, 'any');
    expect(decision?.totalVotes).toBe(1);
    expect(decision?.blocked).toBe(true);
  });

  it('combines votes via the majority strategy', () => {
    const snaps = [
      snapshot({ source: 'open-meteo', windSpeedMs: 8, windDirectionDeg: 0 }), // block
      snapshot({ source: 'buienradar', windSpeedMs: 3, windDirectionDeg: 0 }), // pass
      snapshot({ source: 'openweathermap', windSpeedMs: 8, windDirectionDeg: 0 }), // block
    ];
    const decision = evaluateWindBlocking(ZONE_WIND_ONLY, snaps, 'majority');
    expect(decision?.blocked).toBe(true);
    expect(decision?.blockingVotes).toBe(2);
  });
});

describe('evaluateRainBlocking', () => {
  it('returns undefined when no rain config is supplied', () => {
    expect(evaluateRainBlocking(undefined, [], 'any')).toBeUndefined();
  });

  it('returns undefined when rain config is disabled', () => {
    const disabled: RainBlockingConfig = {
      enabled: false,
      past24hThresholdMm: 5,
      next12hThresholdMm: 2,
    };
    expect(evaluateRainBlocking(disabled, [], 'any')).toBeUndefined();
  });

  it('blocks when past-24h rainfall exceeds the threshold', () => {
    const snaps = [snapshot({ source: 'open-meteo', rainLast24hMm: 6, rainNext12hMm: 0 })];
    const decision = evaluateRainBlocking(RAIN_CFG, snaps, 'any');
    expect(decision?.blocked).toBe(true);
  });

  it('blocks when forecast rainfall exceeds the threshold', () => {
    const snaps = [snapshot({ source: 'open-meteo', rainLast24hMm: 0, rainNext12hMm: 3 })];
    const decision = evaluateRainBlocking(RAIN_CFG, snaps, 'any');
    expect(decision?.blocked).toBe(true);
  });

  it('does not block when both values are below the threshold', () => {
    const snaps = [snapshot({ source: 'open-meteo', rainLast24hMm: 2, rainNext12hMm: 1 })];
    const decision = evaluateRainBlocking(RAIN_CFG, snaps, 'any');
    expect(decision?.blocked).toBe(false);
  });

  it('abstains for sources with no rain data', () => {
    const snaps = [snapshot({ source: 'buienradar', windSpeedMs: 5 })];
    const decision = evaluateRainBlocking(RAIN_CFG, snaps, 'any');
    expect(decision?.totalVotes).toBe(0);
    expect(decision?.blocked).toBe(false);
  });

  it('votes on partial data (only past-24h known)', () => {
    const snaps = [snapshot({ source: 'buienradar', rainLast24hMm: 8 })];
    const decision = evaluateRainBlocking(RAIN_CFG, snaps, 'any');
    expect(decision?.totalVotes).toBe(1);
    expect(decision?.blocked).toBe(true);
  });
});

describe('evaluateZoneBlocking', () => {
  const ZONE_WIND: Zone = {
    id: 'z3',
    name: 'Roses',
    type: 'mist',
    hueLightId: '9',
    windBlocking: {
      enabled: true,
      blockedOctants: ['N'],
      minimumWindSpeedMs: 4,
    },
  };

  it('aggregates wind OR rain as blocking', () => {
    const snaps = [snapshot({ source: 'open-meteo', rainLast24hMm: 10, rainNext12hMm: 0 })];
    const result = evaluateZoneBlocking(ZONE_WIND, RAIN_CFG, snaps, 'any');
    expect(result.blocked).toBe(true);
    expect(result.rain?.blocked).toBe(true);
    expect(result.wind?.blocked).toBe(false);
  });

  it('returns blocked: false when neither condition fires', () => {
    const snaps = [
      snapshot({
        source: 'open-meteo',
        windSpeedMs: 2,
        windDirectionDeg: 180,
        rainLast24hMm: 0,
        rainNext12hMm: 0,
      }),
    ];
    const result = evaluateZoneBlocking(ZONE_WIND, RAIN_CFG, snaps, 'any');
    expect(result.blocked).toBe(false);
  });

  it('omits the rain decision when no rain config is supplied', () => {
    const result = evaluateZoneBlocking(ZONE_WIND_ONLY, undefined, [], 'any');
    expect(result.rain).toBeUndefined();
    expect(result.wind).toBeDefined();
  });

  it('omits the wind decision when wind blocking is disabled', () => {
    const result = evaluateZoneBlocking(ZONE_NO_BLOCKING, RAIN_CFG, [], 'any');
    expect(result.wind).toBeUndefined();
    expect(result.rain).toBeDefined();
  });
});
