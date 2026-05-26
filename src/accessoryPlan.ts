import type { SmartIrrigationConfig } from './config';

export type SwitchKind = 'schedule' | 'wind-override' | 'rain-override';

export interface SwitchPlan {
  /** Stable HomeKit sub-type — survives reboots and lets us match cached services. */
  subtype: string;
  /** Display name shown in Apple Home. */
  displayName: string;
  kind: SwitchKind;
  /** Zone id this switch applies to. Absent for the schedule switch. */
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
 * Rules from the spec:
 * - One "Activate Schedule" switch when at least one schedule entry exists.
 * - One "Wind override: <zone>" switch per zone with wind blocking enabled.
 * - One "Rain override: <zone>" switch per zone with rain blocking enabled.
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
  }
  for (const zone of config.zones) {
    if (zone.windBlocking?.enabled === true) {
      out.push({
        subtype: `wind-override-${zone.id}`,
        displayName: `Wind override: ${zone.name}`,
        kind: 'wind-override',
        zoneId: zone.id,
      });
    }
    if (zone.rainBlocking?.enabled === true) {
      out.push({
        subtype: `rain-override-${zone.id}`,
        displayName: `Rain override: ${zone.name}`,
        kind: 'rain-override',
        zoneId: zone.id,
      });
    }
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
