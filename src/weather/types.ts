/**
 * Shared types for the weather layer.
 *
 * Each weather source is a function that returns a {@link WeatherSnapshot}.
 * A snapshot is a partial view — fields are optional because not every source
 * provides every metric (e.g. OpenWeatherMap's free tier exposes no past-24h
 * rainfall). Downstream code (the blocking engine in Phase 4) must treat a
 * missing field as "this source abstains on that condition" rather than
 * defaulting to zero.
 *
 * Internal units are always:
 * - wind speed: metres per second (m/s)
 * - wind direction: degrees, 0 = N, 90 = E (the direction the wind is *from*)
 * - rainfall: millimetres (mm)
 */

export type WeatherSourceName = 'open-meteo' | 'buienradar' | 'openweathermap';

export interface WeatherSnapshot {
  /** Current wind speed in m/s. Absent when the source has no wind data. */
  windSpeedMs?: number;
  /** Compass bearing the wind is *from*, in degrees 0..359. */
  windDirectionDeg?: number;
  /** Total precipitation in the past 24 hours, in mm. */
  rainLast24hMm?: number;
  /** Forecast precipitation in the next 12 hours, in mm. */
  rainNext12hMm?: number;
  /** When the source produced this snapshot. */
  observedAt: Date;
  /** Which source produced it. */
  source: WeatherSourceName;
}

export type WeatherErrorKind = 'timeout' | 'network' | 'http' | 'protocol' | 'config';

export class WeatherError extends Error {
  public readonly kind: WeatherErrorKind;
  public readonly source: WeatherSourceName;
  public readonly httpStatus?: number;
  public readonly cause?: unknown;

  public constructor(
    message: string,
    source: WeatherSourceName,
    kind: WeatherErrorKind,
    extras: { httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'WeatherError';
    this.kind = kind;
    this.source = source;
    if (extras.httpStatus !== undefined) {
      this.httpStatus = extras.httpStatus;
    }
    if (extras.cause !== undefined) {
      this.cause = extras.cause;
    }
  }
}

/** Options shared by every weather source. */
export interface FetchOptions {
  /** Latitude in WGS84 decimal degrees. */
  latitude: number;
  /** Longitude in WGS84 decimal degrees. */
  longitude: number;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Injectable fetch — tests pass a stub; in production omit. */
  fetchImpl?: typeof fetch;
}

/** Consensus strategies across multiple sources. */
export type ConsensusStrategy = 'any' | 'majority' | 'all';

/**
 * A vote from a single source on a single blocking condition. The blocking
 * engine in Phase 4 produces these from per-source snapshots and per-zone
 * thresholds; the consensus engine combines them into a single decision.
 */
export interface ConsensusVote {
  source: WeatherSourceName;
  blocked: boolean;
  /** Optional human-readable reason — surfaced in logs and the explanation string. */
  reason?: string;
}
