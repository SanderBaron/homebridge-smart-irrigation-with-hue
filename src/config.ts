import type { PlatformConfig } from 'homebridge';

import type { ConsensusStrategy, WeatherSourceName } from './weather/types';
import type {
  CompassOctant,
  PumpConfig,
  RainBlockingConfig,
  ScheduleEntry,
  ScheduleStep,
  WeekDay,
  WindBlockingConfig,
  WindUnit,
  Zone,
  ZoneType,
} from './types';

/**
 * Strictly-typed plugin configuration. The platform parses Homebridge's raw
 * `PlatformConfig` (effectively `Record<string, unknown>`) into this shape with
 * sensible defaults so the rest of the code never has to guard against
 * `undefined` for required fields.
 *
 * The full configuration UI lands in Phase 9; until then users can edit
 * `config.json` by hand and the parser tolerates missing sections — an empty
 * config simply yields zero zones and zero schedule entries, which is enough
 * for the platform to load cleanly.
 */
export interface SmartIrrigationConfig {
  name: string;
  hue: {
    bridgeIp: string;
    apiKey: string;
    healthCheckSec: number;
  };
  location: {
    latitude: number;
    longitude: number;
    name?: string;
  };
  pump?: PumpConfig;
  zones: Zone[];
  schedule: ScheduleEntry[];
  /**
   * Global rain blocking. Applies to every zone equally — rain falls the same
   * everywhere on a single irrigation rig. Absent or `enabled: false` means
   * rain never blocks watering. Replaces the v0.1 per-zone `rainBlocking`
   * field; the parser migrates legacy configs by taking the strictest (lowest
   * non-zero) threshold across all zones that had rain enabled.
   */
  rain?: RainBlockingConfig;
  weather: {
    sources: WeatherSourceName[];
    openWeatherMapApiKey?: string;
    consensusStrategy: ConsensusStrategy;
    cacheMinutes: number;
  };
  windUnit: WindUnit;
  logLevel: 'info' | 'debug';
}

const VALID_OCTANTS: readonly CompassOctant[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const VALID_DAYS: readonly WeekDay[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const VALID_ZONE_TYPES: readonly ZoneType[] = [
  'sprinkler',
  'dripLine',
  'microSpray',
  'mist',
  'other',
];
const VALID_WIND_UNITS: readonly WindUnit[] = ['m/s', 'km/h', 'mph', 'kts', 'Bft'];
const VALID_STRATEGIES: readonly ConsensusStrategy[] = ['any', 'majority', 'all'];
const VALID_SOURCES: readonly WeatherSourceName[] = ['open-meteo', 'buienradar', 'openweathermap'];

/** Result of parsing — either a typed config or an error message for the log. */
export type ParseResult =
  | { ok: true; config: SmartIrrigationConfig }
  | { ok: false; error: string };

/**
 * Parse and validate a Homebridge `PlatformConfig` into a typed
 * {@link SmartIrrigationConfig}. Never throws; failures come back as
 * `{ ok: false, error }` so the platform can log and continue without
 * accessories.
 */
export function parseConfig(raw: PlatformConfig): ParseResult {
  const r = raw as Record<string, unknown>;

  const name = stringOr(r['name'], 'Smart Irrigation');

  const hueRaw = isRecord(r['hue']) ? r['hue'] : {};
  const hue = {
    bridgeIp: stringOr(hueRaw['bridgeIp'], ''),
    apiKey: stringOr(hueRaw['apiKey'], ''),
    healthCheckSec: numberOr(hueRaw['healthCheckSec'], 60),
  };

  const locationRaw = isRecord(r['location']) ? r['location'] : {};
  const latitude = numberOr(locationRaw['latitude'], Number.NaN);
  const longitude = numberOr(locationRaw['longitude'], Number.NaN);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return {
      ok: false,
      error: 'config.location.latitude and config.location.longitude are required',
    };
  }
  const location: SmartIrrigationConfig['location'] = { latitude, longitude };
  const locationName = stringOrUndef(locationRaw['name']);
  if (locationName !== undefined) {
    location.name = locationName;
  }

  const { zones, legacyRainConfigs } = parseZones(r['zones']);
  const schedule = parseSchedule(r['schedule'], new Set(zones.map((z) => z.id)));
  const pump = parsePump(r['pump'], new Set(zones.map((z) => z.id)));
  const rain = parseRain(r['rain'], legacyRainConfigs);

  const weatherRaw = isRecord(r['weather']) ? r['weather'] : {};
  const requestedSources = parseStringArray(weatherRaw['sources']);
  const sources = (
    requestedSources.length === 0 ? ['open-meteo', 'buienradar'] : requestedSources
  ).filter((s): s is WeatherSourceName => VALID_SOURCES.includes(s as WeatherSourceName));
  const owmKey = stringOrUndef(weatherRaw['openWeatherMapApiKey']);
  const consensusStrategy = oneOf(weatherRaw['consensusStrategy'], VALID_STRATEGIES, 'majority');

  const weather: SmartIrrigationConfig['weather'] = {
    sources,
    consensusStrategy,
    cacheMinutes: numberOr(weatherRaw['cacheMinutes'], 10),
  };
  if (owmKey !== undefined && owmKey.length > 0) {
    weather.openWeatherMapApiKey = owmKey;
  } else {
    // If OWM is enabled but no key is provided, silently drop it.
    weather.sources = weather.sources.filter((s) => s !== 'openweathermap');
  }

  const windUnit = oneOf(r['windUnit'], VALID_WIND_UNITS, 'm/s');
  const logLevel = oneOf(r['logLevel'], ['info', 'debug'] as const, 'info');

  const config: SmartIrrigationConfig = {
    name,
    hue,
    location,
    zones,
    schedule,
    weather,
    windUnit,
    logLevel,
  };
  if (pump !== undefined) {
    config.pump = pump;
  }
  if (rain !== undefined) {
    config.rain = rain;
  }
  return { ok: true, config };
}

function parseZones(raw: unknown): {
  zones: Zone[];
  /** Legacy per-zone rain configs picked up for top-level migration. */
  legacyRainConfigs: RainBlockingConfig[];
} {
  if (!Array.isArray(raw)) {
    return { zones: [], legacyRainConfigs: [] };
  }
  // First pass: build the list with id-only references retained; second pass
  // filters runWith down to ids we actually know about (no dangling pointers).
  const out: Zone[] = [];
  const legacyRainConfigs: RainBlockingConfig[] = [];
  const seenIds = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    const id = stringOr(item['id'], '').trim();
    const name = stringOr(item['name'], '').trim();
    const hueLightId = stringOr(item['hueLightId'], '').trim();
    if (id === '' || name === '' || hueLightId === '' || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    const type = oneOf(item['type'], VALID_ZONE_TYPES, 'other');
    const zone: Zone = { id, name, type, hueLightId };
    const runWith = parseStringArray(item['runWith']).filter((rid) => rid !== id);
    if (runWith.length > 0) {
      zone.runWith = runWith;
    }
    const wind = parseWindBlocking(item['windBlocking']);
    if (wind !== undefined) {
      zone.windBlocking = wind;
    }
    // Rain was per-zone in v0.1 — pick the config up here so the top-level
    // parser can migrate it, but never write it back onto the zone in v0.2+.
    const legacyRain = parseRainBlocking(item['rainBlocking']);
    if (legacyRain !== undefined) {
      legacyRainConfigs.push(legacyRain);
    }
    out.push(zone);
  }
  // Second pass: drop runWith ids that don't exist among the parsed zones.
  for (const zone of out) {
    if (zone.runWith !== undefined) {
      const filtered = zone.runWith.filter((rid) => seenIds.has(rid));
      if (filtered.length === 0) {
        delete zone.runWith;
      } else {
        zone.runWith = filtered;
      }
    }
  }
  return { zones: out, legacyRainConfigs };
}

function parseWindBlocking(raw: unknown): WindBlockingConfig | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const enabled = booleanOr(raw['enabled'], false);
  const octants = parseStringArray(raw['blockedOctants']).filter((o): o is CompassOctant =>
    VALID_OCTANTS.includes(o as CompassOctant),
  );
  const minimumWindSpeedMs = numberOr(raw['minimumWindSpeedMs'], 0);
  return { enabled, blockedOctants: octants, minimumWindSpeedMs };
}

function parseRainBlocking(raw: unknown): RainBlockingConfig | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return {
    enabled: booleanOr(raw['enabled'], false),
    past24hThresholdMm: numberOr(raw['past24hThresholdMm'], 0),
    next12hThresholdMm: numberOr(raw['next12hThresholdMm'], 0),
  };
}

/**
 * Resolve the global rain blocking config.
 *
 * Priority:
 * 1. A top-level `rain` block in the raw config wins outright.
 * 2. Otherwise, if any zones carried a legacy v0.1 `rainBlocking` entry,
 *    migrate by taking the strictest (minimum non-zero) thresholds across all
 *    *enabled* legacy entries — the safest choice per the spec: any zone that
 *    used to stop at 1 mm should still stop at 1 mm globally.
 * 3. Otherwise return `undefined` (no rain blocking active).
 */
function parseRain(
  rawTopLevel: unknown,
  legacyRainConfigs: RainBlockingConfig[],
): RainBlockingConfig | undefined {
  const direct = parseRainBlocking(rawTopLevel);
  if (direct !== undefined) {
    return direct;
  }
  const enabledLegacy = legacyRainConfigs.filter((c) => c.enabled);
  if (enabledLegacy.length === 0) {
    return undefined;
  }
  const minNonZero = (values: number[]): number => {
    const positives = values.filter((v) => v > 0);
    return positives.length === 0 ? 0 : Math.min(...positives);
  };
  return {
    enabled: true,
    past24hThresholdMm: minNonZero(enabledLegacy.map((c) => c.past24hThresholdMm)),
    next12hThresholdMm: minNonZero(enabledLegacy.map((c) => c.next12hThresholdMm)),
  };
}

function parseSchedule(raw: unknown, knownZoneIds: Set<string>): ScheduleEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ScheduleEntry[] = [];
  const seenIds = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }
    const id = stringOr(item['id'], '').trim();
    const name = stringOr(item['name'], '').trim();
    const startTime = stringOr(item['startTime'], '').trim();
    if (
      id === '' ||
      name === '' ||
      seenIds.has(id) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime)
    ) {
      continue;
    }
    const days = parseStringArray(item['days']).filter((d): d is WeekDay =>
      VALID_DAYS.includes(d as WeekDay),
    );
    if (days.length === 0) {
      continue;
    }
    const steps = parseSteps(item, knownZoneIds);
    if (steps.length === 0) {
      continue;
    }
    const repeat = Math.max(1, Math.floor(numberOr(item['repeat'], 1)));
    seenIds.add(id);
    out.push({ id, name, days, startTime, steps, repeat });
  }
  return out;
}

/**
 * Parse the steps array — or, if the entry is in the legacy
 * `zoneIds: string[] + durationMin: number` shape, migrate to one step per
 * zone with the old duration. Invalid steps are dropped silently.
 */
function parseSteps(item: Record<string, unknown>, knownZoneIds: Set<string>): ScheduleStep[] {
  const raw = item['steps'];
  if (Array.isArray(raw)) {
    const out: ScheduleStep[] = [];
    for (const stepRaw of raw) {
      if (!isRecord(stepRaw)) {
        continue;
      }
      const zoneId = stringOr(stepRaw['zoneId'], '').trim();
      const durationMin = numberOr(stepRaw['durationMin'], 0);
      if (zoneId === '' || !knownZoneIds.has(zoneId) || durationMin <= 0) {
        continue;
      }
      out.push({ zoneId, durationMin });
    }
    return out;
  }
  // Legacy shape — migrate.
  const legacyDuration = numberOr(item['durationMin'], 0);
  if (legacyDuration <= 0) {
    return [];
  }
  const legacyZones = parseStringArray(item['zoneIds']).filter((z) => knownZoneIds.has(z));
  return legacyZones.map((zoneId) => ({ zoneId, durationMin: legacyDuration }));
}

function parsePump(raw: unknown, knownZoneIds: Set<string>): PumpConfig | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const enabled = booleanOr(raw['enabled'], false);
  const hueLightId = stringOr(raw['hueLightId'], '').trim();
  if (!enabled || hueLightId === '') {
    return undefined;
  }
  const zoneIds = parseStringArray(raw['zoneIds']).filter((z) => knownZoneIds.has(z));
  return {
    enabled: true,
    hueLightId,
    preRunSec: numberOr(raw['preRunSec'], 3),
    postRunSec: numberOr(raw['postRunSec'], 5),
    zoneIds,
  };
}

// ---------------------- primitive coercion helpers ----------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string') {
    const parsed = Number.parseFloat(v);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function booleanOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function parseStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) {
    return [];
  }
  return v.filter((x): x is string => typeof x === 'string');
}

function oneOf<T extends string>(v: unknown, valid: readonly T[], fallback: T): T {
  if (typeof v === 'string' && (valid as readonly string[]).includes(v)) {
    return v as T;
  }
  return fallback;
}
