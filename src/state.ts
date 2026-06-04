import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Logging } from 'homebridge';

import type { WeatherSnapshot, WeatherSourceName } from './weather/types';

/** Bump when the on-disk schema changes incompatibly. */
const STATE_FORMAT_VERSION = 1;

/** Filename inside the Homebridge storage dir. */
export const STATE_FILE_NAME = 'weather-smart-irrigation-state.json';

export interface PersistedOverride {
  zoneId: string;
  kind: 'wind' | 'rain';
  /** Unix-ms timestamp when the override would auto-clear. */
  expiresAt: number;
}

/**
 * Snapshot of everything the plugin needs to remember across Homebridge
 * restarts.
 *
 * - **scheduleActive** mirrors the "Activate Schedule" switch.
 * - **schedulerFiredToday** keeps the per-entry last-fired date, so a restart
 *   doesn't re-trigger morning watering that already ran today.
 * - **overrides** preserves manual wind/rain overrides plus their original
 *   expiry, so they don't silently reset on restart.
 * - **weatherSnapshots** carries the last weather reading so blocking
 *   decisions made immediately after restart aren't running blind.
 * - **valveDurations** stores the user-chosen HomeKit SetDuration value per
 *   zone (in seconds) so it survives a Homebridge restart.
 */
export interface PersistentState {
  version: number;
  scheduleActive: boolean;
  schedulerFiredToday: Record<string, string>;
  overrides: PersistedOverride[];
  weatherSnapshots: WeatherSnapshot[];
  /** Wall-clock ms when the snapshot was written; used for diagnostics. */
  savedAt: number;
  /** Per-zone user-chosen valve duration in seconds (HomeKit SetDuration). */
  valveDurations?: Record<string, number>;
}

export function defaultState(): PersistentState {
  return {
    version: STATE_FORMAT_VERSION,
    scheduleActive: false,
    schedulerFiredToday: {},
    overrides: [],
    weatherSnapshots: [],
    savedAt: 0,
  };
}

/** Filesystem surface the StateStore depends on — abstracted for tests. */
export interface StateFs {
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
}

const defaultFs: StateFs = {
  readFile: (p) => fs.readFile(p, 'utf8'),
  writeFile: (p, data) => fs.writeFile(p, data, 'utf8'),
  rename: (from, to) => fs.rename(from, to),
  unlink: (p) => fs.unlink(p),
};

export interface StateStoreOptions {
  /** Directory in which to write the state file. Typically `api.user.storagePath()`. */
  storageDir: string;
  /** Injectable filesystem for tests. */
  fsImpl?: StateFs;
  log?: Logging;
}

/**
 * Reads and writes the plugin's persistent state file.
 *
 * - Atomic writes via a `.tmp` sibling + `rename` — partial writes never leave
 *   a corrupted state file on disk.
 * - Tolerant load: any parse error, missing file, or version mismatch produces
 *   the default state plus a logged warning instead of crashing the platform.
 * - Single-file design: one JSON document per the spec, no SQLite or
 *   per-section files.
 */
export class StateStore {
  private readonly filePath: string;
  private readonly tmpPath: string;
  private readonly fsImpl: StateFs;
  private readonly log: Logging | undefined;

  public constructor(options: StateStoreOptions) {
    this.filePath = path.join(options.storageDir, STATE_FILE_NAME);
    this.tmpPath = `${this.filePath}.tmp`;
    this.fsImpl = options.fsImpl ?? defaultFs;
    this.log = options.log;
  }

  /** Absolute path of the state file. Exposed for diagnostics. */
  public path(): string {
    return this.filePath;
  }

  /**
   * Load state from disk. Returns a sanitised {@link PersistentState} on
   * success, or the default state on any failure (missing file, malformed
   * JSON, unknown version). Never throws.
   */
  public async load(): Promise<PersistentState> {
    let raw: string;
    try {
      raw = await this.fsImpl.readFile(this.filePath);
    } catch {
      return defaultState();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.log?.warn(
        'State file %s is not valid JSON; using defaults: %s',
        this.filePath,
        String(err),
      );
      return defaultState();
    }

    return sanitise(parsed, this.log);
  }

  /** Write the given state atomically. Never throws — failures are logged. */
  public async save(state: PersistentState): Promise<void> {
    const data: PersistentState = {
      ...state,
      version: STATE_FORMAT_VERSION,
      savedAt: Date.now(),
    };
    const json = JSON.stringify(data, snapshotReplacer);
    try {
      await this.fsImpl.writeFile(this.tmpPath, json);
      await this.fsImpl.rename(this.tmpPath, this.filePath);
    } catch (err) {
      this.log?.error('Failed to save state file %s: %s', this.filePath, String(err));
    }
  }
}

/** Serialises `Date` objects as ISO strings so they survive a round-trip through JSON. */
function snapshotReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function sanitise(value: unknown, log: Logging | undefined): PersistentState {
  if (typeof value !== 'object' || value === null) {
    return defaultState();
  }
  const r = value as Record<string, unknown>;
  if (typeof r['version'] === 'number' && r['version'] !== STATE_FORMAT_VERSION) {
    log?.warn(
      'State file version %s does not match expected %s; using defaults',
      String(r['version']),
      String(STATE_FORMAT_VERSION),
    );
    return defaultState();
  }
  const base = defaultState();
  if (typeof r['scheduleActive'] === 'boolean') {
    base.scheduleActive = r['scheduleActive'];
  }
  const fired = r['schedulerFiredToday'];
  if (typeof fired === 'object' && fired !== null && !Array.isArray(fired)) {
    for (const [k, v] of Object.entries(fired as Record<string, unknown>)) {
      if (typeof v === 'string') {
        base.schedulerFiredToday[k] = v;
      }
    }
  }
  if (Array.isArray(r['overrides'])) {
    for (const o of r['overrides']) {
      if (typeof o !== 'object' || o === null) {
        continue;
      }
      const item = o as Record<string, unknown>;
      const zoneId = item['zoneId'];
      const kind = item['kind'];
      const expiresAt = item['expiresAt'];
      if (typeof zoneId !== 'string' || (kind !== 'wind' && kind !== 'rain')) {
        continue;
      }
      if (typeof expiresAt !== 'number') {
        continue;
      }
      base.overrides.push({ zoneId, kind, expiresAt });
    }
  }
  if (Array.isArray(r['weatherSnapshots'])) {
    for (const s of r['weatherSnapshots']) {
      const snap = parseSnapshot(s);
      if (snap !== undefined) {
        base.weatherSnapshots.push(snap);
      }
    }
  }
  if (typeof r['savedAt'] === 'number') {
    base.savedAt = r['savedAt'];
  }
  const durations = r['valveDurations'];
  if (typeof durations === 'object' && durations !== null && !Array.isArray(durations)) {
    base.valveDurations = {};
    for (const [k, v] of Object.entries(durations as Record<string, unknown>)) {
      if (typeof v === 'number' && v > 0) {
        base.valveDurations[k] = v;
      }
    }
  }
  return base;
}

function parseSnapshot(value: unknown): WeatherSnapshot | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const r = value as Record<string, unknown>;
  const source = r['source'];
  if (source !== 'open-meteo' && source !== 'buienradar' && source !== 'openweathermap') {
    return undefined;
  }
  const observedRaw = r['observedAt'];
  const observedAt =
    typeof observedRaw === 'string'
      ? new Date(observedRaw)
      : observedRaw instanceof Date
        ? observedRaw
        : undefined;
  if (observedAt === undefined || Number.isNaN(observedAt.getTime())) {
    return undefined;
  }
  const snap: WeatherSnapshot = {
    source: source as WeatherSourceName,
    observedAt,
  };
  if (typeof r['windSpeedMs'] === 'number') {
    snap.windSpeedMs = r['windSpeedMs'];
  }
  if (typeof r['windDirectionDeg'] === 'number') {
    snap.windDirectionDeg = r['windDirectionDeg'];
  }
  if (typeof r['rainLast24hMm'] === 'number') {
    snap.rainLast24hMm = r['rainLast24hMm'];
  }
  if (typeof r['rainNext12hMm'] === 'number') {
    snap.rainNext12hMm = r['rainNext12hMm'];
  }
  return snap;
}
