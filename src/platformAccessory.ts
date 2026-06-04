import { Perms } from 'homebridge';
import type { CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { Characteristic } from '@homebridge/hap-nodejs';

import { computeSwitches, computeValves, type SwitchPlan } from './accessoryPlan';
import type { SmartIrrigationConfig } from './config';
import type { HueClient } from './hue/client';
import type { PumpOrchestrator } from './pumpOrchestrator';
import type { Scheduler } from './scheduler';
import type { SmartIrrigationPlatform } from './platform';

/** Default user-chosen valve duration when none has been set yet. 5 minutes. */
const DEFAULT_VALVE_SECONDS = 300;

interface ValveRuntime {
  active: boolean;
  /** User-configurable duration in seconds (via SetDuration). Defaults to 5 min. */
  setDurationSec: number;
  /** Actual duration of the current (or most recent) run in seconds. Used for the
   *  RemainingDuration countdown so schedule-triggered runs show their real time,
   *  not the HomeKit default SetDuration. */
  currentRunDurationSec: number;
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
  /** True when the Hue Bridge passed its most recent health check. */
  isHueOnline: () => boolean;
  /** Per-zone SetDuration values restored from the state file. */
  initialDurations: Record<string, number>;
  /** Called when the user changes SetDuration so the platform can persist it. */
  onSetDuration: (zoneId: string, seconds: number) => void;
}

/**
 * The single platform accessory: one Irrigation System service with a Valve
 * sub-service per zone, plus the two schedule Switch services (Activate
 * Schedule + Run Schedule Now).
 *
 * This class is the glue between HomeKit characteristic events and the
 * subsystem modules (Hue client, pump, scheduler). It deliberately stays thin
 * — concurrency, weather logic, and pump timing all live in those modules; the
 * accessory just routes events.
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
    this.applyDisplayName(svc, this.deps.config.name);

    // The IrrigationSystem service exposes Active / InUse / ProgramMode. In
    // Apple Home's "one tile" view these render as separate ghost tiles, and
    // because we don't actually let the user *turn the irrigation system
    // itself* on or off (individual valves and the schedule switch handle
    // that), tapping them used to snap back. Locking the perms to
    // PAIRED_READ + NOTIFY tells Apple Home these are read-only signals and
    // it suppresses the interactive controls.
    for (const Char of [
      this.platform.Characteristic.Active,
      this.platform.Characteristic.InUse,
      this.platform.Characteristic.ProgramMode,
    ]) {
      svc.getCharacteristic(Char).setProps({ perms: [Perms.PAIRED_READ, Perms.NOTIFY] });
    }
    svc.updateCharacteristic(
      this.platform.Characteristic.Active,
      this.platform.Characteristic.Active.ACTIVE,
    );
    svc.updateCharacteristic(
      this.platform.Characteristic.ProgramMode,
      this.platform.Characteristic.ProgramMode.NO_PROGRAM_SCHEDULED,
    );
    svc.updateCharacteristic(
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
      this.applyDisplayName(svc, plan.displayName);
      svc.setCharacteristic(
        this.platform.Characteristic.ValveType,
        this.platform.Characteristic.ValveType.IRRIGATION,
      );

      const initialSec = this.deps.initialDurations[plan.zoneId] ?? DEFAULT_VALVE_SECONDS;
      this.valveState.set(plan.zoneId, {
        active: false,
        setDurationSec: initialSec,
        currentRunDurationSec: initialSec,
        startedAt: 0,
      });

      this.rewireCharacteristic(
        svc,
        this.platform.Characteristic.Active,
        this.makeValveActiveSetter(plan.zoneId),
        () => this.getValveActive(plan.zoneId),
      );
      this.rewireCharacteristic(svc, this.platform.Characteristic.InUse, undefined, () =>
        this.getValveActive(plan.zoneId),
      );
      this.rewireCharacteristic(
        svc,
        this.platform.Characteristic.SetDuration,
        (value) => {
          const state = this.valveState.get(plan.zoneId);
          if (state !== undefined) {
            state.setDurationSec = Number(value);
            this.deps.onSetDuration(plan.zoneId, Number(value));
          }
        },
        () => this.valveState.get(plan.zoneId)?.setDurationSec ?? DEFAULT_VALVE_SECONDS,
      );
      this.rewireCharacteristic(
        svc,
        this.platform.Characteristic.RemainingDuration,
        undefined,
        () => this.getRemainingSeconds(plan.zoneId),
      );

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
      this.applyDisplayName(svc, plan.displayName);
      this.rewireCharacteristic(
        svc,
        this.platform.Characteristic.On,
        this.makeSwitchSetter(plan),
        () => this.initialSwitchState(plan),
      );
      svc.updateCharacteristic(this.platform.Characteristic.On, this.initialSwitchState(plan));
      this.switchServices.set(plan.subtype, svc);
    }
  }

  /**
   * Apply a display name to a service via both `Name` (HomeKit's stable name)
   * and `ConfiguredName` (the user-editable label Apple Home shows). Without
   * `ConfiguredName`, Apple Home often falls back to the accessory's display
   * name — which is why every valve was showing up as "Smart Irrigation".
   *
   * `ConfiguredName` is not part of the optional-characteristics list for
   * Valve/Switch/IrrigationSystem in HAP-NodeJS's service definitions, so we
   * declare it as optional first. Without that call Homebridge logs a warning
   * about "Adding anyway" even though it works.
   */
  private applyDisplayName(svc: Service, displayName: string): void {
    svc.setCharacteristic(this.platform.Characteristic.Name, displayName);
    svc.addOptionalCharacteristic(this.platform.Characteristic.ConfiguredName);
    const configured = svc.getCharacteristic(this.platform.Characteristic.ConfiguredName);
    configured.setProps({ perms: configured.props.perms });
    configured.updateValue(displayName);
  }

  /**
   * Replace any existing onSet / onGet handlers on the characteristic before
   * attaching ours. When a cached accessory is loaded from disk on a
   * subsequent Homebridge start, our previous handlers are already in place;
   * calling `.onSet()` again would *add* a second listener, so each tap would
   * fire every accumulated handler. removing first guarantees exactly one.
   */
  private rewireCharacteristic(
    svc: Service,
    characteristic: WithUUID<new () => Characteristic>,
    onSetHandler: ((value: CharacteristicValue) => void | Promise<void>) | undefined,
    onGetHandler: () => CharacteristicValue | Promise<CharacteristicValue>,
  ): void {
    const c = svc.getCharacteristic(characteristic);
    c.removeAllListeners('set');
    c.removeAllListeners('get');
    if (onSetHandler !== undefined) {
      c.onSet(onSetHandler);
    }
    c.onGet(onGetHandler);
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
        case 'run-now':
          if (on) {
            this.platform.log.info('Run Schedule Now requested');
            this.deps.scheduler.runAllEntriesNow();
            // The switch is kept ON by syncManualRunSwitch (fired by the
            // scheduler when the manual sequences start). It auto-flips off
            // when all manual sequences complete, or when the user taps OFF
            // below to abort.
          } else {
            this.platform.log.info('Run Schedule Now aborted by user');
            void this.deps.scheduler.stopAll();
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
      // Re-open while already active = extension (the scheduler renewed the
      // run, typically because a later step pulled this zone in again via
      // run-with). The Hue valve is already on, so skip the network call;
      // just reset the auto-close timer so we don't close at the original
      // deadline.
      if (state.closeTimer !== undefined) {
        clearTimeout(state.closeTimer);
      }
      state.startedAt = Date.now();
      state.currentRunDurationSec = durationMs / 1000;
      state.closeTimer = setTimeout(() => {
        void this.closeValve(zoneId, 'duration-expired');
      }, durationMs);
      const extSvc = this.valveServices.get(`valve-${zoneId}`);
      extSvc?.updateCharacteristic(
        this.platform.Characteristic.RemainingDuration,
        Math.round(durationMs / 1000),
      );
      this.platform.log.debug(
        'Zone "%s" already active; extending close timer (%s, %d sec)',
        zone.name,
        source,
        durationMs / 1000,
      );
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
    state.currentRunDurationSec = durationMs / 1000;
    state.closeTimer = setTimeout(() => {
      void this.closeValve(zoneId, 'duration-expired');
    }, durationMs);

    this.syncValveActiveCharacteristic(zoneId, true);
    this.updateIrrigationInUse();
    // Push RemainingDuration immediately so Apple Home shows the correct
    // countdown from the first instant rather than waiting for the next poll.
    const openSvc = this.valveServices.get(`valve-${zoneId}`);
    openSvc?.updateCharacteristic(
      this.platform.Characteristic.RemainingDuration,
      Math.round(durationMs / 1000),
    );

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
    return Math.max(0, Math.round(state.currentRunDurationSec - elapsed));
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
    if (!active) {
      svc.updateCharacteristic(this.platform.Characteristic.RemainingDuration, 0);
    }
  }

  /**
   * Mirror the scheduler's manual-run state into the "Run Schedule Now"
   * switch. The scheduler fires this callback when the first manually-
   * triggered sequence starts and again when the last one completes (or is
   * aborted via stopAll).
   */
  public syncManualRunSwitch(active: boolean): void {
    const svc = this.switchServices.get('switch-run-now');
    svc?.updateCharacteristic(this.platform.Characteristic.On, active);
  }

  private initialSwitchState(plan: SwitchPlan): boolean {
    switch (plan.kind) {
      case 'schedule':
        return this.deps.scheduler.isActive();
      case 'run-now':
        // Reflects whether a manual run is currently in progress. After a
        // Homebridge restart the scheduler is empty so this resolves to
        // false, which is the correct boot state.
        return this.deps.scheduler.hasActiveManualRun();
    }
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
