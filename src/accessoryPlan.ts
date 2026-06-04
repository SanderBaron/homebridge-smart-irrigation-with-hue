import type { SmartIrrigationConfig } from './config';

export type SwitchKind = 'schedule' | 'run-now';

export interface SwitchPlan {
  /** Stable HomeKit sub-type — survives reboots and lets us match cached services. */
  subtype: string;
  /** Display name shown in Apple Home. */
  displayName: string;
  kind: SwitchKind;
  /** Zone id this switch applies to. Absent for the schedule switches. */
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
 * Weather blocking applies only to the scheduled programme; a manual valve
 * open or "Run Schedule Now" always waters regardless of the weather, so there
 * are no manual-override switches. The only switches are the two schedule
 * controls, present when at least one schedule entry exists.
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
