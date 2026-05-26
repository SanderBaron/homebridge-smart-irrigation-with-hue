/**
 * Project-wide shared types.
 *
 * Hue- and weather-layer-specific types live next to those modules
 * (`src/hue/types.ts`, `src/weather/types.ts`); this file holds the higher-
 * level domain shapes — zones, blocking config, schedule entries, pump — that
 * cross multiple layers.
 */

/** The eight compass octants the blocking engine maps wind directions onto. */
export type CompassOctant = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

/** Wind speed unit selectable in the UI; internal storage and calculations always use m/s. */
export type WindUnit = 'm/s' | 'km/h' | 'mph' | 'kts' | 'Bft';

/**
 * How many manual-override switches the platform exposes in Apple Home.
 *
 * - `per-zone` — one wind switch + one rain switch *per zone* that has the
 *   corresponding blocking enabled. Lets the user override specific zones.
 * - `global`   — one wind switch + one rain switch *total*, applying to every
 *   zone with the corresponding blocking. Cleaner Home layout.
 * - `none`     — no override switches at all. Users can still bypass blocks
 *   by manually opening valves in Apple Home; only scheduled runs respect the
 *   weather blocks in this mode.
 */
export type OverrideGranularity = 'per-zone' | 'global' | 'none';

/**
 * Zone hardware/usage type. Used only to seed sensible defaults in the UI when
 * a zone is first created — the blocking logic itself never branches on this.
 */
export type ZoneType = 'sprinkler' | 'dripLine' | 'microSpray' | 'mist' | 'other';

export interface WindBlockingConfig {
  /** Master toggle; when false the blocking engine produces no wind-related votes. */
  enabled: boolean;
  /** Octants the zone is downwind of — when the wind blows *from* one of these, watering is unsafe. */
  blockedOctants: CompassOctant[];
  /** Wind speed (m/s) at and above which the zone is blocked. Always stored in m/s. */
  minimumWindSpeedMs: number;
}

export interface RainBlockingConfig {
  /** Master toggle. */
  enabled: boolean;
  /** Skip watering when total rainfall in the past 24h exceeds this many mm. */
  past24hThresholdMm: number;
  /** Skip watering when forecast rainfall in the next 12h exceeds this many mm. */
  next12hThresholdMm: number;
}

/**
 * Day-of-week codes. Ordering matches JavaScript's `Date.getDay()` (Sun = 0)
 * so the scheduler can map a Date directly to the array index. UI shortcuts
 * like "Daily", "Weekdays only", "Weekends only" are expanded to a list of
 * these before persistence.
 */
export type WeekDay = 'Sun' | 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat';

/** One ordered step inside a schedule entry: water one zone for `durationMin` minutes. */
export interface ScheduleStep {
  /** Zone to water during this step (by `Zone.id`). */
  zoneId: string;
  /** Duration of this step in minutes. Must be greater than zero. */
  durationMin: number;
}

/**
 * A single entry in the user's watering schedule.
 *
 * Steps run sequentially: step 0 fires first, when its zone finishes step 1
 * starts, and so on. After the last step the whole sequence repeats `repeat`
 * times in total (so `repeat: 1` means "run once"). Run-with buddies attached
 * to a step's zone water alongside that step automatically.
 */
export interface ScheduleEntry {
  /** Stable identifier, persisted across restarts. */
  id: string;
  /** User-chosen display name (free text). */
  name: string;
  /** Days of the week on which this entry fires. */
  days: WeekDay[];
  /** Start time in 24-hour `HH:MM` format. */
  startTime: string;
  /** Ordered list of steps to execute. Must contain at least one step. */
  steps: ScheduleStep[];
  /** Total times to run the sequence. Default 1 (no repeat). Minimum 1. */
  repeat: number;
}

/**
 * Optional central pump that must run before any of its covered zones can
 * receive water. v1 supports a single pump; multi-pump configurations are on
 * the roadmap.
 */
export interface PumpConfig {
  /** Master toggle. When false, the orchestrator becomes a no-op so the platform code doesn't need to branch. */
  enabled: boolean;
  /** Hue light/socket id the bridge toggles to power the pump. */
  hueLightId: string;
  /** Seconds the pump runs before any valve opens, to build line pressure. Default 3. */
  preRunSec: number;
  /** Seconds the pump keeps running after the last valve closes, to bleed off pressure. Default 5. */
  postRunSec: number;
  /**
   * Zone ids this pump serves. Empty array means "all zones" — the orchestrator
   * treats that as universal coverage so users don't have to maintain a list.
   */
  zoneIds: string[];
}

export interface Zone {
  /** Stable identifier, persisted across restarts. */
  id: string;
  /** User-chosen display name (free text). */
  name: string;
  /** Zone hardware type — affects defaults only. */
  type: ZoneType;
  /** Hue light/socket id the bridge will toggle on/off. */
  hueLightId: string;
  /**
   * Other zones that should automatically run alongside this one. When this
   * zone is started (by the scheduler or by manual valve open), every zone
   * id listed here is started too, for the same duration.
   *
   * Two zones are considered compatible (can run together) iff at least one
   * of them lists the other in `runWith`. Zones whose `runWith` lists do not
   * mention each other are serialised by the scheduler.
   *
   * Replaces the earlier `concurrencyGroup` string. The two models differ:
   * groups are equivalence classes (everyone in group X can run with everyone
   * else in group X), while `runWith` is a directed graph that can also
   * express asymmetric relationships — e.g. a drip line that joins every
   * sprinkler without those sprinklers joining each other.
   */
  runWith?: string[];
  /** Optional wind blocking. Absent or `enabled: false` means the zone never blocks on wind. */
  windBlocking?: WindBlockingConfig;
  /** Optional rain blocking. Absent or `enabled: false` means the zone never blocks on rain. */
  rainBlocking?: RainBlockingConfig;
}
