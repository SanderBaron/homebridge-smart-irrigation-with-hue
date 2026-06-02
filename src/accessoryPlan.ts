import type { SmartIrrigationConfig } from './config';

/** Sentinel zone id used by the OverrideManager to mean "applies to all zones". */
export const GLOBAL_OVERRIDE_ZONE_ID = '__all__';

export type SwitchKind =
  | 'schedule'
  | 'run-now'
  | 'wind-override'
  | 'wind-override-global'
  | 'rain-override-global';

export interface SwitchPlan {
  /** Stable HomeKit sub-type — survives reboots and lets us match cached services. */
  subtype: string;
  /** Display name shown in Apple Home. */
  displayName: string;
  kind: SwitchKind;
  /** Zone id this switch applies to. Absent for the schedule switch and global override switches. */
  zoneId?: string;
}

export interface ValvePlan {
  /** Stable HomeKit sub-type, derived from Zone.id. */
  subtype: string;
  /** Display name shown in Apple Home. */
  displayName: string;
  zoneId: string;
}

/**
 * Pure projection: given a parsed config, return the list of HomeKit Switch
 * services that should exist on the accessory.
 *
 * Rules:
 * - One "Activate Schedule" + one "Run Schedule Now" switch when at least
 *   one schedule entry exists.
 * - Wind blocking is per-zone, so wind overrides follow the configured
 *   granularity (per-zone / global / none).
 * - Rain blocking is global (single config), so there is at most ONE rain
 *   override switch regardless of granularity. `granularity: 'none'`
 *   suppresses it; everything else exposes it when rain blocking is enabled.
 *
 * Returning this as a pure list keeps the platform's add/remove diffing
 * straightforward and lets us unit-test the planning logic without touching
 * Homebridge.
 */
export function computeSwitches(config: SmartIrrigationConfig): SwitchPlan[] {
  const out: SwitchPlan[] = [];
  if (config.schedule.length > 0) {
    out.push({
      subtype: 'switch-schedule',
      displayName: 'Activate Schedule',
      kind: 'schedule',
    });
    out.push({
      subtype: 'switch-run-now',
      displayName: 'Run Schedule Now',
      kind: 'run-now',
    });
  }

  const granularity = config.override.granularity;
  if (granularity === 'none') {
    return out;
  }

  const anyWindBlocking = config.zones.some((z) => z.windBlocking?.enabled === true);
  const rainBlockingEnabled = config.rain?.enabled === true;

  if (granularity === 'global') {
    if (anyWindBlocking) {
      out.push({
        subtype: 'wind-override-global',
        displayName: 'Wind override (all zones)',
        kind: 'wind-override-global',
      });
    }
  } else {
    // per-zone wind overrides
    for (const zone of config.zones) {
      if (zone.windBlocking?.enabled === true) {
        out.push({
          subtype: `wind-override-${zone.id}`,
          displayName: `Wind override: ${zone.name}`,
          kind: 'wind-override',
          zoneId: zone.id,
        });
      }
    }
  }

  // Rain is global by configuration — always a single switch when enabled,
  // regardless of the per-zone vs global granularity setting (which now only
  // governs wind).
  if (rainBlockingEnabled) {
    out.push({
      subtype: 'rain-override-global',
      displayName: 'Rain override',
      kind: 'rain-override-global',
    });
  }

  return out;
}

/** Valves are one-to-one with zones. */
export function computeValves(config: SmartIrrigationConfig): ValvePlan[] {
  return config.zones.map((z) => ({
    subtype: `valve-${z.id}`,
    displayName: z.name,
    zoneId: z.id,
  }));
}
