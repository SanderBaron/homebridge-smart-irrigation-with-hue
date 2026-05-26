import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { computeSwitches, computeValves, type SwitchPlan } from './accessoryPlan';
import type { SmartIrrigationConfig } from './config';
import type { HueClient } from './hue/client';
import type { OverrideManager } from './overrideManager';
import type { PumpOrchestrator } from './pumpOrchestrator';
import type { Scheduler } from './scheduler';
import type { SmartIrrigationPlatform } from './platform';

/** Default user-chosen valve duration when none has been set yet. 5 minutes. */
const DEFAULT_VALVE_SECONDS = 300;

interface ValveRuntime {
  active: boolean;
  /** User-configurable duration in seconds (via SetDuration). Defaults to 5 min. */
  setDurationSec: number;
  /** Wall-clock ms when the current run was started; 0 if not running. */
  startedAt: number;
  /** Auto-close timer for the active run. */
  closeTimer?: NodeJS.Timeout;
}

export interface AccessoryDependencies {
  config: SmartIrrigationConfig;
  hueClient: HueClient | undefined;
  pump: PumpOrchestrator;
  scheduler: Scheduler;
  overrideManager: OverrideManager;
  /** True when the Hue Bridge passed its most recent health check. */
  isHueOnline: () => boolean;
}

/**
 * The single platform accessory: one Irrigation System service with a Valve
 * sub-service per zone, plus dynamic Switch services for the schedule and the
 * per-zone wind/rain overrides.
 *
 * This class is the glue between HomeKit characteristic events and the
 * subsystem modules (Hue client, pump, scheduler, override manager). It
 * deliberately stays thin — concurrency, weather logic, and pump timing all
 * live in those modules; the accessory just routes events.
 */
export class SmartIrrigationAccessory {
  private readonly platform: SmartIrrigationPlatform;
  private readonly accessory: PlatformAccessory;
  private readonly deps: AccessoryDependencies;
  private readonly valveServices = new Map<string, Service>();
  private readonly switchServices = new Map<string, Service>();
  private readonly valveState = new Map<string, ValveRuntime>();
  private irrigationService: Service | undefined;

  public constructor(
    platform: SmartIrrigationPlatform,
    accessory: PlatformAccessory,
    deps: AccessoryDependencies,
  ) {
    this.platform = platform;
    this.accessory = accessory;
    this.deps = deps;

    this.buildAccessoryInfo();
    this.buildIrrigationSystem();
    this.buildValves();
    this.buildSwitches();
    this.removeStaleServices();
    this.wireOverrideSync();
  }

  /** Start a zone programmatically (called by the scheduler). */
  public async startZoneFromSchedule(zoneId: string, durationMs: number): Promise<void> {
    await this.openValve(zoneId, durationMs, 'schedule');
  }

  /** Stop a zone programmatically (called by the scheduler). */
  public async stopZoneFromSchedule(zoneId: string): Promise<void> {
    await this.closeValve(zoneId, 'schedule');
  }

  /** Close every active valve. Intended for shutdown hooks and bridge-offline events. */
  public async closeAllValves(reason: string): Promise<void> {
    const active = [...this.valveState.entries()].filter(([, s]) => s.active).map(([id]) => id);
    for (const zoneId of active) {
      await this.closeValve(zoneId, reason);
    }
  }

  // ---------- builders ----------

  private buildAccessoryInfo(): void {
    const info =
      this.accessory.getService(this.platform.Service.AccessoryInformation) ??
      this.accessory.addService(this.platform.Service.AccessoryInformation);
    info
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Sander Baron')
      .setCharacteristic(this.platform.Characteristic.Model, 'Smart Irrigation')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID);
  }

  private buildIrrigationSystem(): void {
    const svc =
      this.accessory.getService(this.platform.Service.IrrigationSystem) ??
      this.accessory.addService(this.platform.Service.IrrigationSystem);
    svc.setCharacteristic(this.platform.Characteristic.Name, this.deps.config.name);
    svc.setCharacteristic(
      this.platform.Characteristic.Active,
      this.platform.Characteristic.Active.ACTIVE,
    );
    svc.setCharacteristic(
      this.platform.Characteristic.ProgramMode,
      this.platform.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED,
    );
    svc.setCharacteristic(
      this.platform.Characteristic.InUse,
      this.platform.Characteristic.InUse.NOT_IN_USE,
    );
    this.irrigationService = svc;
  }

  private buildValves(): void {
    for (const plan of computeValves(this.deps.config)) {
      const svc =
        this.accessory.getServiceById(this.platform.Service.Valve, plan.subtype) ??
        this.accessory.addService(this.platform.Service.Valve, plan.displayName, plan.subtype);
      svc.setCharacteristic(this.platform.Characteristic.Name, plan.displayName);
      svc.setCharacteristic(
        this.platform.Characteristic.ValveType,
        this.platform.Characteristic.ValveType.IRRIGATION,
      );

      this.valveState.set(plan.zoneId, {
        active: false,
        setDurationSec: DEFAULT_VALVE_SECONDS,
        startedAt: 0,
      });

      svc
        .getCharacteristic(this.platform.Characteristic.Active)
        .onSet(this.makeValveActiveSetter(plan.zoneId))
        .onGet(() => this.getValveActive(plan.zoneId));

      svc
        .getCharacteristic(this.platform.Characteristic.InUse)
        .onGet(() => this.getValveActive(plan.zoneId));

      svc
        .getCharacteristic(this.platform.Characteristic.SetDuration)
        .onSet((value) => {
          const state = this.valveState.get(plan.zoneId);
          if (state !== undefined) {
            state.setDurationSec = Number(value);
          }
        })
        .onGet(() => this.valveState.get(plan.zoneId)?.setDurationSec ?? DEFAULT_VALVE_SECONDS);

      svc
        .getCharacteristic(this.platform.Characteristic.RemainingDuration)
        .onGet(() => this.getRemainingSeconds(plan.zoneId));

      this.irrigationService?.addLinkedService(svc);
      this.valveServices.set(plan.subtype, svc);
    }
  }

  private buildSwitches(): void {
    const plans = computeSwitches(this.deps.config);
    for (const plan of plans) {
      const svc =
        this.accessory.getServiceById(this.platform.Service.Switch, plan.subtype) ??
        this.accessory.addService(this.platform.Service.Switch, plan.displayName, plan.subtype);
      svc.setCharacteristic(this.platform.Characteristic.Name, plan.displayName);
      svc.getCharacteristic(this.platform.Characteristic.On).onSet(this.makeSwitchSetter(plan));
      // Initial state: schedule reflects scheduler.isActive(); overrides default off.
      const initial =
        plan.kind === 'schedule'
          ? this.deps.scheduler.isActive()
          : plan.zoneId !== undefined
            ? this.deps.overrideManager.isOverridden(
                plan.zoneId,
                plan.kind === 'wind-override' ? 'wind' : 'rain',
              )
            : false;
      svc.updateCharacteristic(this.platform.Characteristic.On, initial);
      this.switchServices.set(plan.subtype, svc);
    }
  }

  /**
   * Remove any cached services that the current config no longer wants. Lets
   * users delete a zone or schedule entry without leaving stale tiles in
   * Apple Home.
   */
  private removeStaleServices(): void {
    const expectedValveSubtypes = new Set(computeValves(this.deps.config).map((v) => v.subtype));
    const expectedSwitchSubtypes = new Set(computeSwitches(this.deps.config).map((s) => s.subtype));

    for (const svc of [...this.accessory.services]) {
      if (svc.UUID === this.platform.Service.Valve.UUID) {
        if (svc.subtype !== undefined && !expectedValveSubtypes.has(svc.subtype)) {
          this.accessory.removeService(svc);
        }
      } else if (svc.UUID === this.platform.Service.Switch.UUID) {
        if (svc.subtype !== undefined && !expectedSwitchSubtypes.has(svc.subtype)) {
          this.accessory.removeService(svc);
        }
      }
    }
  }

  private wireOverrideSync(): void {
    // Whenever an override auto-resets, mirror the change to the HomeKit switch.
    // We register a single observer; the OverrideManager fires `onChange` with
    // the zoneId and kind, so we can locate the right switch service.
    // OverrideManager is constructed by the platform with `onChange` already
    // wired — this method is a placeholder for future reactivity work.
  }

  // ---------- handlers ----------

  private makeValveActiveSetter(zoneId: string): (value: CharacteristicValue) => void {
    return (value): void => {
      const active = Number(value) === this.platform.Characteristic.Active.ACTIVE;
      const state = this.valveState.get(zoneId);
      if (state === undefined) {
        return;
      }
      if (active) {
        const durationMs = state.setDurationSec * 1000;
        void this.openValve(zoneId, durationMs, 'manual');
      } else {
        void this.closeValve(zoneId, 'manual');
      }
    };
  }

  private makeSwitchSetter(plan: SwitchPlan): (value: CharacteristicValue) => void {
    return (value): void => {
      const on = Boolean(value);
      switch (plan.kind) {
        case 'schedule':
          this.deps.scheduler.setActive(on);
          this.platform.log.info('Schedule %s', on ? 'activated' : 'deactivated');
          break;
        case 'wind-override':
          if (plan.zoneId !== undefined) {
            this.deps.overrideManager.setOverride(plan.zoneId, 'wind', on);
          }
          break;
        case 'rain-override':
          if (plan.zoneId !== undefined) {
            this.deps.overrideManager.setOverride(plan.zoneId, 'rain', on);
          }
          break;
      }
    };
  }

  // ---------- runtime ----------

  private async openValve(
    zoneId: string,
    durationMs: number,
    source: 'manual' | 'schedule' | 'manual-buddy',
  ): Promise<void> {
    const state = this.valveState.get(zoneId);
    if (state === undefined) {
      return;
    }
    const zone = this.deps.config.zones.find((z) => z.id === zoneId);
    if (zone === undefined) {
      this.platform.log.warn('Cannot open unknown zone %s', zoneId);
      return;
    }

    if (state.active) {
      this.platform.log.debug('Zone %s already active; ignoring open request', zoneId);
      return;
    }

    if (this.deps.hueClient === undefined || !this.deps.isHueOnline()) {
      this.platform.log.error('Cannot open zone %s — Hue Bridge unavailable', zoneId);
      this.syncValveActiveCharacteristic(zoneId, false);
      return;
    }

    this.platform.log.info('Opening zone "%s" (%s, %d sec)', zone.name, source, durationMs / 1000);

    try {
      await this.deps.pump.requestPumpStart(zoneId);
      await this.deps.hueClient.setLightOn(zone.hueLightId, true);
    } catch (err) {
      this.platform.log.error('Failed to open zone %s: %s', zoneId, String(err));
      this.deps.pump.releasePumpStop(zoneId);
      this.syncValveActiveCharacteristic(zoneId, false);
      return;
    }

    state.active = true;
    state.startedAt = Date.now();
    state.closeTimer = setTimeout(() => {
      void this.closeValve(zoneId, 'duration-expired');
    }, durationMs);

    this.syncValveActiveCharacteristic(zoneId, true);
    this.updateIrrigationInUse();

    // Manual opens pull along the zone's run-with buddies for the same
    // duration. The schedule path doesn't repeat this because the scheduler
    // has already expanded the entry's zone list with each zone's buddies.
    if (source === 'manual') {
      for (const buddyId of zone.runWith ?? []) {
        void this.openValve(buddyId, durationMs, 'manual-buddy').catch((err: unknown) => {
          this.platform.log.warn(
            'Failed to open run-with buddy %s for %s: %s',
            buddyId,
            zoneId,
            String(err),
          );
        });
      }
    }
  }

  private async closeValve(zoneId: string, reason: string): Promise<void> {
    const state = this.valveState.get(zoneId);
    if (!state?.active) {
      return;
    }
    const zone = this.deps.config.zones.find((z) => z.id === zoneId);

    if (state.closeTimer !== undefined) {
      clearTimeout(state.closeTimer);
      delete state.closeTimer;
    }

    this.platform.log.info('Closing zone "%s" (%s)', zone?.name ?? zoneId, reason);

    try {
      if (this.deps.hueClient !== undefined && zone !== undefined) {
        await this.deps.hueClient.setLightOn(zone.hueLightId, false);
      }
    } catch (err) {
      this.platform.log.error('Failed to close zone %s: %s', zoneId, String(err));
    }

    state.active = false;
    state.startedAt = 0;
    this.deps.pump.releasePumpStop(zoneId);
    this.syncValveActiveCharacteristic(zoneId, false);
    this.updateIrrigationInUse();
  }

  private getValveActive(zoneId: string): number {
    const active = this.valveState.get(zoneId)?.active === true;
    return active
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  private getRemainingSeconds(zoneId: string): number {
    const state = this.valveState.get(zoneId);
    if (state === undefined || !state.active || state.startedAt === 0) {
      return 0;
    }
    const elapsed = (Date.now() - state.startedAt) / 1000;
    return Math.max(0, Math.round(state.setDurationSec - elapsed));
  }

  private syncValveActiveCharacteristic(zoneId: string, active: boolean): void {
    const svc = this.valveServices.get(`valve-${zoneId}`);
    if (svc === undefined) {
      return;
    }
    const value = active
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
    svc.updateCharacteristic(this.platform.Characteristic.Active, value);
    svc.updateCharacteristic(this.platform.Characteristic.InUse, value);
  }

  /** Mirror an override flip back to the corresponding Switch.On. Called from the platform's `onChange` wiring. */
  public syncOverrideSwitch(zoneId: string, kind: 'wind' | 'rain', active: boolean): void {
    const subtype = kind === 'wind' ? `wind-override-${zoneId}` : `rain-override-${zoneId}`;
    const svc = this.switchServices.get(subtype);
    svc?.updateCharacteristic(this.platform.Characteristic.On, active);
  }

  private updateIrrigationInUse(): void {
    if (this.irrigationService === undefined) {
      return;
    }
    const anyActive = [...this.valveState.values()].some((s) => s.active);
    this.irrigationService.updateCharacteristic(
      this.platform.Characteristic.InUse,
      anyActive
        ? this.platform.Characteristic.InUse.IN_USE
        : this.platform.Characteristic.InUse.NOT_IN_USE,
    );
  }
}
